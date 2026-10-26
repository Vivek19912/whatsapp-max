// ============================================================
// Meta Lead Ads → Google Sheets — durable outbox.
//
// Flow (all Meta-only, never Flow Tables):
//   * Configuration is per Workspace table: one
//     `meta_lead_sheets_configs` row per (account, Meta form id).
//     Each table syncs only its own form's leads into its own
//     spreadsheet/tab/columns.
//   * Ingestion (`processSubmissionById` success), assignment
//     changes, and Workspace cell edits call `maybeEnqueue...`
//     AFTER the underlying write succeeded. Enqueue is a single
//     idempotent INSERT keyed UNIQUE(account_id, submission_id):
//     polling/import/retries/concurrent workers collapse to one row.
//     Enqueue NEVER throws into lead processing. Rows whose form has
//     no table config are never enqueued.
//   * `drainSheetsQueue` (cron + manual sync-now) claims due rows,
//     resolves each row's table config by its form, and writes to
//     Sheets idempotently (update existing row matched by stable
//     Meta Lead ID at its configured column, else append),
//     recording the sheet row number for future updates. Rows
//     without a matching table config are parked untouched (resume
//     on configure).
//   * Google failures use bounded exponential backoff and never roll
//     back the lead. Auth failures leave rows queued with a long
//     backoff + surface `needs_reauth` via config.last_error.
//   * Historical backfill enqueues existing processed submissions in
//     safe batches; resume is automatic via the queue.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';

import {
  META_SHEETS_BATCH_SIZE,
  META_SHEETS_LEAD_ID_COL,
  META_SHEETS_MAX_ATTEMPTS,
  META_SHEETS_SWEEP_LIMIT,
  sheetsRetryDelayMs,
} from './constants';
import {
  computeManagedLayout,
  projectRowValues,
  resolveEffectiveColumns,
  type SheetsColumnDef,
} from './columns';
import {
  buildLeadFieldMap,
  resolveBusinessDisplays,
  sheetsSourceLabel,
} from './mapping';
import { resolveFlowAnswers } from '@/lib/flows/flow-tables';
import {
  applyOptionLabelsToAnswers,
  buildOptionLabelMap,
  choiceQuestionKeys,
  type StoredFormQuestion,
} from '@/lib/meta-lead-ads/option-labels';
import { questionVarKeys } from '@/lib/meta-lead-ads/virtual-flow';
import { META_SOURCE_COLUMN_KEY } from '@/lib/meta-lead-ads/virtual-flow';
import { standardContactFromAnswers } from '@/lib/meta-lead-ads/normalize';
import { getSheetsAccessToken, SheetsAuthError } from './oauth';
import {
  appendSheetsRows,
  assertWorksheetTabExists,
  deleteSheetRows,
  ensureSheetsHeader,
  findSheetsRowsByLeadId,
  isQuotaSheetsError,
  isTransientSheetsError,
  rewriteSheetRows,
  setSheetColumnHidden,
  SheetsApiError,
  TabMissingError,
  updateSheetsRow,
} from './sheets-client';
import {
  EXHAUSTED_PARK_MS,
  exhaustedSuffix,
  sheetsQuotaDelayMs,
  withSheetsThrottle,
} from './throttle';

const STALE_CLAIM_MS = 5 * 60_000;

export interface QueueRow {
  id: string;
  account_id: string;
  submission_id: string;
  flow_run_id: string | null;
  meta_lead_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  sheet_row_number: number | null;
}

interface SubmissionRow {
  id: string;
  account_id: string;
  meta_lead_id: string;
  flow_run_id: string | null;
  form_id: string | null;
  form_name: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  source: string | null;
  answers: Record<string, string> | null;
  meta_created_time: string | null;
  created_at: string;
}

/**
 * This table's Sheets preference: auto_sync for one
 * (account, Meta form). No row = not configured = sync nothing.
 */
async function getTableAutoSync(
  db: SupabaseClient,
  accountId: string,
  formId: string
): Promise<boolean> {
  const { data } = await db
    .from('meta_lead_sheets_configs')
    .select('auto_sync')
    .eq('account_id', accountId)
    .eq('form_id', formId)
    .maybeSingle();
  return (data as { auto_sync?: boolean } | null)?.auto_sync === true;
}

async function loadSubmission(
  db: SupabaseClient,
  accountId: string,
  submissionId: string
): Promise<SubmissionRow | null> {
  const { data, error } = await db
    .from('meta_lead_submissions')
    .select(
      'id, account_id, meta_lead_id, flow_run_id, form_id, form_name, campaign_name, ad_name, source, answers, meta_created_time, created_at'
    )
    .eq('id', submissionId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as SubmissionRow | null) ?? null;
}

/**
 * Idempotent enqueue after a lead was created/updated. Never throws.
 * Skips when this table (account + form) has no Sheets config or
 * auto_sync is off. (Manual sync-now drains forcefully; backfill
 * enqueues explicitly per form.)
 */
export async function maybeEnqueueSheetsSync(
  db: SupabaseClient,
  args: { accountId: string; submissionId: string }
): Promise<{ enqueued: boolean }> {
  try {
    const submission = await loadSubmission(
      db,
      args.accountId,
      args.submissionId
    );
    if (!submission) return { enqueued: false };
    // Only sync leads that actually became Workspace rows; failed /
    // ignored submissions have no flow_run_id yet and will be
    // enqueued when (if) they process.
    if (!submission.flow_run_id || !submission.form_id)
      return { enqueued: false };
    // This table's config only — other tables' forms never enter.
    if (!(await getTableAutoSync(db, args.accountId, submission.form_id))) {
      return { enqueued: false };
    }
    const { error } = await db.from('meta_lead_sheets_queue').insert({
      account_id: args.accountId,
      submission_id: submission.id,
      flow_run_id: submission.flow_run_id,
      meta_lead_id: submission.meta_lead_id,
    });
    if (error) {
      if (isUniqueViolation(error)) return { enqueued: false };
      throw error;
    }
    return { enqueued: true };
  } catch (err) {
    console.error(
      '[meta-sheets] enqueue failed (lead processing unaffected):',
      err instanceof Error ? err.message : err
    );
    return { enqueued: false };
  }
}

/**
 * Enqueue by Workspace run id (assignment + cell-edit paths).
 * Resolves the Meta submission server-side; unknown runs are a no-op.
 * Never throws.
 */
export async function enqueueSheetsSyncForRun(
  db: SupabaseClient,
  args: { accountId: string; runId: string }
): Promise<{ enqueued: boolean }> {
  try {
    const { data, error } = await db
      .from('meta_lead_submissions')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('flow_run_id', args.runId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { id: string } | null;
    if (!row) return { enqueued: false };
    // maybeEnqueueSheetsSync re-checks this table's config + form.
    return maybeEnqueueSheetsSync(db, {
      accountId: args.accountId,
      submissionId: row.id,
    });
  } catch (err) {
    console.error(
      '[meta-sheets] enqueue-for-run failed (assignment unaffected):',
      err instanceof Error ? err.message : err
    );
    return { enqueued: false };
  }
}

export interface BackfillResult {
  enqueued: number;
  alreadyQueued: number;
  total: number;
}

/**
 * Historical sync for ONE table: enqueue that form's processed
 * submissions in batches. Idempotent (unique key) — safe to resume
 * after interruption.
 */
export async function backfillFormSheets(
  db: SupabaseClient,
  accountId: string,
  formId: string,
  limit = 500
): Promise<BackfillResult> {
  const bounded = Math.max(1, Math.min(limit, 2000));
  const { data, error } = await db
    .from('meta_lead_submissions')
    .select('id, flow_run_id, meta_lead_id, form_id')
    .eq('account_id', accountId)
    .eq('status', 'processed')
    .not('flow_run_id', 'is', null)
    .eq('form_id', formId)
    .order('created_at', { ascending: true })
    .limit(bounded);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    flow_run_id: string | null;
    meta_lead_id: string;
  }>;
  let enqueued = 0;
  let alreadyQueued = 0;
  for (let i = 0; i < rows.length; i += META_SHEETS_BATCH_SIZE) {
    const batch = rows.slice(i, i + META_SHEETS_BATCH_SIZE);
    for (const row of batch) {
      const { error: insertErr } = await db
        .from('meta_lead_sheets_queue')
        .insert({
          account_id: accountId,
          submission_id: row.id,
          flow_run_id: row.flow_run_id,
          meta_lead_id: row.meta_lead_id,
        });
      if (insertErr) {
        if (isUniqueViolation(insertErr)) {
          alreadyQueued += 1;
          continue;
        }
        throw insertErr;
      }
      enqueued += 1;
    }
  }
  await db
    .from('meta_lead_sheets_configs')
    .update({
      historical_import_status: 'done',
      historical_imported_count: enqueued + alreadyQueued,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId);
  return { enqueued, alreadyQueued, total: rows.length };
}

export interface FormsDeltaResult {
  enqueued: number;
  alreadyQueued: number;
  total: number;
}

/**
 * Reconcile newly selected forms: enqueue their processed submissions
 * without duplicating anything already queued or sent (UNIQUE key).
 * Used when the form selection gains forms; deselection needs no
 * queue writes (pending rows are skipped by the drain filter and an
 * explicit cleanup removes sheet rows on request).
 */
export async function enqueueFormsDelta(
  db: SupabaseClient,
  accountId: string,
  formIds: string[],
  limit = 2000
): Promise<FormsDeltaResult> {
  if (formIds.length === 0) return { enqueued: 0, alreadyQueued: 0, total: 0 };
  const bounded = Math.max(1, Math.min(limit, 2000));
  const { data, error } = await db
    .from('meta_lead_submissions')
    .select('id, flow_run_id, meta_lead_id')
    .eq('account_id', accountId)
    .eq('status', 'processed')
    .not('flow_run_id', 'is', null)
    .in('form_id', formIds)
    .order('created_at', { ascending: true })
    .limit(bounded);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    flow_run_id: string | null;
    meta_lead_id: string;
  }>;
  let enqueued = 0;
  let alreadyQueued = 0;
  for (const row of rows) {
    const { error: insertErr } = await db
      .from('meta_lead_sheets_queue')
      .insert({
        account_id: accountId,
        submission_id: row.id,
        flow_run_id: row.flow_run_id,
        meta_lead_id: row.meta_lead_id,
      });
    if (insertErr) {
      if (isUniqueViolation(insertErr)) {
        alreadyQueued += 1;
        continue;
      }
      throw insertErr;
    }
    enqueued += 1;
  }
  return { enqueued, alreadyQueued, total: rows.length };
}

/** Inclusive YYYY-MM-DD day range (UTC) for a manual import. */
export interface TableImportRange {
  from: string;
  to: string;
}

export interface TableImportResult {
  /** In-scope candidates (after range filtering). */
  total: number;
  /** Newly enqueued leads (new sheet rows on drain). */
  imported: number;
  /** Already mapped leads (drain updates them in place, never appends). */
  updated: number;
  /** Skipped: no Workspace run to sync (nothing to write). */
  skipped: number;
  /** Enqueue errors (non-unique violations). */
  failed: number;
  /** True when more candidates exist than the limit allowed. */
  truncated: boolean;
}

/** Max submissions classified per manual import call (bounded request). */
export const TABLE_IMPORT_LIMIT = 2000;

/**
 * Effective Workspace submission time for one lead: the run's
 * start time wins (what the Workspace Submission Time column
 * shows), then the Meta creation time, then row creation. Pure.
 */
export function resolveImportSubmittedAt(args: {
  runStartedAt: string | null;
  metaCreatedTime: string | null;
  createdAt: string | null;
}): string | null {
  for (const value of [args.runStartedAt, args.metaCreatedTime, args.createdAt]) {
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))) {
      return value;
    }
  }
  return null;
}

/**
 * Inclusive [fromDay, toDay] day-range check over UTC day
 * boundaries: from 00:00:00.000 through 23:59:59.999. Pure.
 */
export function isWithinImportRange(
  iso: string | null,
  fromDay: string,
  toDay: string
): boolean {
  if (typeof iso !== 'string') return false;
  const at = Date.parse(iso);
  const from = Date.parse(`${fromDay}T00:00:00.000Z`);
  const to = Date.parse(`${toDay}T23:59:59.999Z`);
  if (Number.isNaN(at) || Number.isNaN(from) || Number.isNaN(to)) return false;
  return at >= from && at <= to;
}

export interface ImportCandidate {
  id: string;
  flow_run_id: string;
  meta_lead_id: string;
}

export interface ImportScope {
  /** In-scope candidates in import order. */
  candidates: ImportCandidate[];
  /** Candidate ids that already have a sheet row (refreshed in place). */
  mappedIds: string[];
  /** In-scope total (excludes out-of-range and run-less rows). */
  total: number;
  /** Candidates without a sheet row yet. */
  imported: number;
  /** Candidates already mapped (updated in place, never appended twice). */
  updated: number;
  /** In-scope submissions with no Workspace run (nothing syncable). */
  skipped: number;
  /** True when more candidates exist than the limit allowed. */
  truncated: boolean;
}

/**
 * Classify ONE table's processed submissions for manual import
 * (all, or an inclusive submission-day range) with a bounded
 * number of queries — no per-row round trips. Read-only: Workspace
 * rows are never written. Returns the exact candidate snapshot an
 * import job persists, so re-pumps and retries reconcile the same
 * set. Only the caller's (account, form) scope is read.
 */
export async function planImportScope(
  db: SupabaseClient,
  accountId: string,
  formId: string,
  range: TableImportRange | null,
  limit = TABLE_IMPORT_LIMIT
): Promise<ImportScope> {
  const bounded = Math.max(1, Math.min(limit, TABLE_IMPORT_LIMIT));
  const { data, error } = await db
    .from('meta_lead_submissions')
    .select('id, flow_run_id, meta_lead_id, meta_created_time, created_at')
    .eq('account_id', accountId)
    .eq('status', 'processed')
    .eq('form_id', formId)
    .order('created_at', { ascending: true })
    .limit(bounded + 1);
  if (error) throw error;
  const rows = ((data ?? []) as Array<{
    id: string;
    flow_run_id: string | null;
    meta_lead_id: string;
    meta_created_time: string | null;
    created_at: string;
  }>);
  const truncated = rows.length > bounded;
  const batch = rows.slice(0, bounded);

  // Workspace submission times (run start wins) for range filtering.
  const runIds = [...new Set(batch.map((r) => r.flow_run_id).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const startedByRun = new Map<string, string | null>();
  if (runIds.length > 0) {
    const { data: runs, error: runErr } = await db
      .from('flow_runs')
      .select('id, started_at')
      .eq('account_id', accountId)
      .in('id', runIds);
    if (runErr) throw runErr;
    for (const run of (runs ?? []) as Array<{ id: string; started_at: string | null }>) {
      startedByRun.set(run.id, run.started_at ?? null);
    }
  }

  // Already-mapped submissions (have a sheet row): the drain will
  // update them in place rather than append. Also doubles as the
  // existing-queue-row set for duplicate-safe bulk inserts.
  const mapped = new Set<string>();
  const existing = new Set<string>();
  const subIds = batch.map((r) => r.id);
  if (subIds.length > 0) {
    const { data: queued, error: queueErr } = await db
      .from('meta_lead_sheets_queue')
      .select('submission_id, sheet_row_number')
      .eq('account_id', accountId)
      .in('submission_id', subIds);
    if (queueErr) throw queueErr;
    for (const q of (queued ?? []) as Array<{ submission_id: string; sheet_row_number: number | null }>) {
      existing.add(q.submission_id);
      if (typeof q.sheet_row_number === 'number') mapped.add(q.submission_id);
    }
  }

  const candidates: ImportCandidate[] = [];
  let skipped = 0;
  for (const row of batch) {
    // No Workspace run: nothing syncable to write.
    if (!row.flow_run_id) {
      skipped += 1;
      continue;
    }
    if (range) {
      const effective = resolveImportSubmittedAt({
        runStartedAt: startedByRun.get(row.flow_run_id) ?? null,
        metaCreatedTime: row.meta_created_time ?? null,
        createdAt: row.created_at ?? null,
      });
      if (effective === null || !isWithinImportRange(effective, range.from, range.to)) {
        continue;
      }
    }
    candidates.push({
      id: row.id,
      flow_run_id: row.flow_run_id,
      meta_lead_id: row.meta_lead_id,
    });
  }

  let updated = 0;
  for (const c of candidates) {
    if (mapped.has(c.id)) updated += 1;
  }
  return {
    candidates,
    mappedIds: [...mapped].filter((id) =>
      candidates.some((c) => c.id === id)
    ),
    total: candidates.length,
    imported: candidates.length - updated,
    updated,
    skipped,
    truncated,
  };
}

export interface EnqueueImportResult {
  enqueued: number;
  alreadyQueued: number;
  failed: number;
}

/**
 * Enqueue a classification snapshot with bulk operations: one
 * reset for sent/failed rows (drain refreshes them in place,
 * matched by lead ID downstream — never appended twice), one
 * existence check, and chunked bulk inserts for the rest.
 * In-flight (queued/sending) rows are left untouched. Bulk
 * failures fall back to per-row writes so one bad row cannot fail
 * the batch; per-row enqueue errors are counted, never thrown.
 */
export async function enqueueImportCandidates(
  db: SupabaseClient,
  accountId: string,
  candidates: ImportCandidate[],
): Promise<EnqueueImportResult> {
  const out: EnqueueImportResult = { enqueued: 0, alreadyQueued: 0, failed: 0 };
  if (candidates.length === 0) return out;
  const nowIso = new Date().toISOString();
  const ids = candidates.map((c) => c.id);

  // Reset sent/failed rows so the drain refreshes them in place.
  const { error: resetErr } = await db
    .from('meta_lead_sheets_queue')
    .update({ status: 'queued', claimed_at: null, next_retry_at: nowIso, updated_at: nowIso })
    .eq('account_id', accountId)
    .in('submission_id', ids)
    .in('status', ['sent', 'failed']);
  if (resetErr) throw resetErr;

  // Insert only rows with no queue row yet (bulk insert aborts the
  // whole statement on a unique violation, so pre-check first).
  const { data: existingRows, error: existingErr } = await db
    .from('meta_lead_sheets_queue')
    .select('submission_id')
    .eq('account_id', accountId)
    .in('submission_id', ids);
  if (existingErr) throw existingErr;
  const existing = new Set(
    ((existingRows ?? []) as Array<{ submission_id: string }>).map((r) => r.submission_id)
  );
  const fresh = candidates.filter((c) => !existing.has(c.id));
  out.alreadyQueued = candidates.length - fresh.length;

  const CHUNK = 200;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const chunk = fresh.slice(i, i + CHUNK);
    const { error: insertErr } = await db.from('meta_lead_sheets_queue').insert(
      chunk.map((c) => ({
        account_id: accountId,
        submission_id: c.id,
        flow_run_id: c.flow_run_id,
        meta_lead_id: c.meta_lead_id,
      }))
    );
    if (!insertErr) {
      out.enqueued += chunk.length;
      continue;
    }
    if (!isUniqueViolation(insertErr)) throw insertErr;
    // A concurrent worker won the race on some row: fall back to
    // per-row writes so the rest still land.
    for (const c of chunk) {
      const { error: singleErr } = await db
        .from('meta_lead_sheets_queue')
        .insert({
          account_id: accountId,
          submission_id: c.id,
          flow_run_id: c.flow_run_id,
          meta_lead_id: c.meta_lead_id,
        });
      if (!singleErr) {
        out.enqueued += 1;
      } else if (isUniqueViolation(singleErr)) {
        out.alreadyQueued += 1;
      } else {
        out.failed += 1;
      }
    }
  }
  return out;
}

/**
 * Manual historical import for ONE table: classify + enqueue that
 * form's processed submissions (all, or an inclusive submission-day
 * range), resetting already-mapped rows to queued so the drain
 * refreshes them in place. Matching is always by stable Meta Lead
 * ID downstream, so re-imports update instead of duplicating;
 * Workspace rows are only read, never written. Only callers'
 * (account, form) scope is touched - every query below carries
 * both. Classification and enqueue run as bulk operations (a
 * handful of queries for up to 2000 leads); bulk failures throw
 * (callers surface them) while per-row insert fallbacks are
 * counted, never thrown.
 */
export async function importTableLeads(
  db: SupabaseClient,
  accountId: string,
  formId: string,
  range: TableImportRange | null,
  limit = TABLE_IMPORT_LIMIT
): Promise<TableImportResult> {
  const scope = await planImportScope(db, accountId, formId, range, limit);
  const { failed } = await enqueueImportCandidates(db, accountId, scope.candidates);
  return {
    total: scope.total,
    imported: scope.imported,
    updated: scope.updated,
    skipped: scope.skipped,
    failed,
    truncated: scope.truncated,
  };
}

export interface DrainResult {
  attempted: number;
  sent: number;
  /**
   * Terminal failures only (retry budget spent or permanent
   * error). Rows that will retry automatically are counted in
   * `retrying`, never here.
   */
  failed: number;
  /**
   * Rows that failed but are scheduled for automatic retry
   * (quota/transient backoff, or quota-parked without burning an
   * attempt). Never reported as permanently failed.
   */
  retrying: number;
  skippedDisabled: number;
  /** Rows parked because their form has no table config (resume on configure). */
  skippedNoConfig: number;
  needsReauth: number;
}

interface ConfigRow {
  account_id: string;
  form_id: string;
  spreadsheet_id: string;
  spreadsheet_url: string | null;
  spreadsheet_title: string | null;
  sheet_tab: string;
  auto_sync: boolean;
  last_success_at: string | null;
  last_error: string | null;
  column_config: unknown;
  pending_remap: boolean;
  remap_cursor: number | null;
}

/** This table's Sheets config: one row per (account, Meta form id). */
async function loadTableConfig(
  db: SupabaseClient,
  accountId: string,
  formId: string
): Promise<ConfigRow | null> {
  const { data, error } = await db
    .from('meta_lead_sheets_configs')
    .select(
      'account_id, form_id, spreadsheet_id, spreadsheet_url, spreadsheet_title, sheet_tab, auto_sync, last_success_at, last_error, column_config, pending_remap, remap_cursor'
    )
    .eq('account_id', accountId)
    .eq('form_id', formId)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    account_id: string;
    form_id: string;
    spreadsheet_id: string;
    spreadsheet_url?: string | null;
    spreadsheet_title?: string | null;
    sheet_tab: string;
    auto_sync: boolean;
    last_success_at?: string | null;
    last_error?: string | null;
    column_config?: unknown;
    pending_remap?: boolean | null;
    remap_cursor?: number | null;
  } | null;
  if (!row) return null;
  return {
    account_id: row.account_id,
    form_id: row.form_id,
    spreadsheet_id: row.spreadsheet_id,
    spreadsheet_url: row.spreadsheet_url ?? null,
    spreadsheet_title: row.spreadsheet_title ?? null,
    sheet_tab: row.sheet_tab,
    auto_sync: row.auto_sync,
    last_success_at: row.last_success_at ?? null,
    last_error: row.last_error ?? null,
    column_config: row.column_config ?? null,
    pending_remap: row.pending_remap === true,
    remap_cursor:
      typeof row.remap_cursor === 'number' ? row.remap_cursor : null,
  };
}

/**
 * Load everything needed to render one sheet row.
 *
 * Reuses the existing Workspace table data and display-value mapping
 * for the selected table (never independently reconstructs values
 * from raw Meta form submissions):
 *   * flow_runs.vars is the Workspace source (same as the table RPC),
 *     with workspace_flow_overrides applied (override wins per key),
 *   * Instant Form option labels + choice fallback map raw values to
 *     the exact readable text users see (e.g. `3_star` → `3 Star`),
 *   * system Name/Phone prefer the contact row with the same
 *     identity fallback the Workspace uses,
 *   * Source prefers the Workspace answer display, falling back to
 *     the stored enum label,
 *   * Submitted At prefers the Workspace run start.
 * Headers stay aligned via projectRowValues (ID at its configured
 * position for stable lead-ID matching), only selected columns in
 * order sync.
 */
async function buildRowValues(
  db: SupabaseClient,
  accountId: string,
  submission: SubmissionRow,
  columns: SheetsColumnDef[]
): Promise<string[]> {
  let fields: Array<{ id: string; name: string }> = [];
  let values: Array<{ field_id: string; value_text: string | null }> = [];
  let roster: Array<{ user_id: string; full_name: string | null }> = [];
  // Workspace source for this lead (same as the table RPC).
  let runVars: Record<string, unknown> = {};
  let runStartedAt: string | null = null;
  let runContactId: string | null = null;
  let runFlowId: string | null = null;
  const overrides: Record<string, string | null> = {};
  if (submission.flow_run_id) {
    const { data: run } = await db
      .from('flow_runs')
      .select('flow_id, vars, started_at, contact_id')
      .eq('id', submission.flow_run_id)
      .eq('account_id', accountId)
      .maybeSingle();
    const runRow = run as {
      flow_id?: string | null;
      vars?: unknown;
      started_at?: string | null;
      contact_id?: string | null;
    } | null;
    runFlowId = runRow?.flow_id ?? null;
    if (runRow && typeof runRow.vars === 'object' && runRow.vars !== null) {
      runVars = runRow.vars as Record<string, unknown>;
    }
    runStartedAt =
      typeof runRow?.started_at === 'string' ? runRow.started_at : null;
    runContactId =
      typeof runRow?.contact_id === 'string' ? runRow.contact_id : null;
    if (runFlowId) {
      const [{ data: fieldRows }, { data: valueRows }] = await Promise.all([
        db
          .from('workspace_fields')
          .select('id, name')
          .eq('account_id', accountId)
          .eq('flow_id', runFlowId),
        db
          .from('workspace_values')
          .select('field_id, value_text')
          .eq('account_id', accountId)
          .eq('flow_run_id', submission.flow_run_id),
      ]);
      fields = (fieldRows ?? []) as Array<{ id: string; name: string }>;
      values = (valueRows ?? []) as Array<{
        field_id: string;
        value_text: string | null;
      }>;
      // Agent overrides for flow-derived cells (display wins per key).
      try {
        const { data: overrideRows } = await db
          .from('workspace_flow_overrides')
          .select('field_key, value_text')
          .eq('account_id', accountId)
          .eq('flow_id', runFlowId)
          .eq('flow_run_id', submission.flow_run_id);
        for (const o of (overrideRows ?? []) as Array<{
          field_key: string;
          value_text: string | null;
        }>) {
          if (typeof o.field_key === 'string' && o.field_key !== '') {
            overrides[o.field_key] = o.value_text ?? null;
          }
        }
      } catch {
        // Best-effort: missing table/migration degrades to originals.
      }
    }
  }
  const { data: profiles } = await db
    .from('profiles')
    .select('user_id, full_name')
    .eq('account_id', accountId);
  roster = (profiles ?? []) as Array<{
    user_id: string;
    full_name: string | null;
  }>;
  const business = resolveBusinessDisplays({ fields, values, roster });

  // Raw Workspace vars (flow_runs.vars, fallback to the stored
  // submission answers for legacy rows/tests) normalized to the
  // string|null shape the Workspace table renders.
  const rawAnswers: Record<string, string | null> = {};
  const varSource =
    Object.keys(runVars).length > 0 ? runVars : ((submission.answers ?? {}) as Record<string, unknown>);
  for (const [k, v] of Object.entries(varSource)) {
    if (typeof v === 'string') rawAnswers[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean')
      rawAnswers[k] = String(v);
    else if (v === null || v === undefined) rawAnswers[k] = null;
  }
  // Display = override ?? original (same rule the Workspace uses).
  const withOverrides = resolveFlowAnswers(rawAnswers, overrides);

  // Instant Form display mapping (same lookup the Workspace table
  // route builds): exact option-key matches first, underscore
  // fallback for known choice questions. Display-only.
  let displayAnswers: Record<string, string | null> = { ...withOverrides };
  try {
    if (submission.form_id) {
      const { data: formRow } = await db
        .from('meta_lead_forms')
        .select('questions')
        .eq('account_id', accountId)
        .eq('form_id', submission.form_id)
        .maybeSingle();
      const rawQuestions = (formRow as { questions?: unknown } | null)
        ?.questions;
      const rawList = Array.isArray(rawQuestions) ? rawQuestions : [];
      const stored: StoredFormQuestion[] = rawList.map((entry) => {
        const e =
          entry && typeof entry === 'object'
            ? (entry as Record<string, unknown>)
            : {};
        const rawOptions = Array.isArray(e.options) ? e.options : [];
        return {
          key: typeof e.key === 'string' ? e.key : null,
          label: typeof e.label === 'string' ? e.label : null,
          type: typeof e.type === 'string' ? e.type : null,
          options: rawOptions.map((o) => {
            const oo =
              o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
            return {
              key: typeof oo.key === 'string' ? oo.key : null,
              value: typeof oo.value === 'string' ? oo.value : null,
            };
          }),
        };
      });
      const keys = questionVarKeys(stored);
      const labelMap = buildOptionLabelMap(stored, keys);
      const choiceKeys = choiceQuestionKeys(stored, keys);
      if (labelMap.size > 0 || choiceKeys.size > 0) {
        displayAnswers = applyOptionLabelsToAnswers(
          withOverrides,
          labelMap,
          choiceKeys
        );
      }
    }
  } catch {
    // Best-effort: without option metadata values stay as stored.
  }

  // System Name/Phone match the Workspace: contact wins, else the
  // standard identity fallback from the (display-mapped) answers.
  let contactName: string | null = null;
  let contactPhone: string | null = null;
  if (runContactId) {
    try {
      const { data: contact } = await db
        .from('contacts')
        .select('name, phone')
        .eq('id', runContactId)
        .eq('account_id', accountId)
        .maybeSingle();
      const c = contact as { name?: unknown; phone?: unknown } | null;
      if (typeof c?.name === 'string' && c.name.trim() !== '')
        contactName = c.name;
      if (typeof c?.phone === 'string' && c.phone.trim() !== '')
        contactPhone = c.phone;
    } catch {
      // Best-effort: fall back to answers below.
    }
  }
  const standard = standardContactFromAnswers(
    displayAnswers as Record<string, string | null | undefined>
  );
  const workspaceName = contactName ?? standard.name ?? null;
  const workspacePhone = contactPhone ?? standard.phone ?? null;
  // Email stays display-mapped (overrides + option labels already
  // applied; email questions are never choice-mapped).
  const workspaceEmail = standard.email ?? null;

  const sourceFromWorkspace =
    typeof displayAnswers[META_SOURCE_COLUMN_KEY] === 'string' &&
    (displayAnswers[META_SOURCE_COLUMN_KEY] as string).trim() !== ''
      ? (displayAnswers[META_SOURCE_COLUMN_KEY] as string)
      : null;

  // displayAnswers carries readable values for every dynamic key;
  // standard name/phone/email are forced to the Workspace-resolved
  // contact/fallback so they match the table even when overrides or
  // contacts differ from the raw submission.
  const answersForMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(displayAnswers)) {
    if (typeof v === 'string' && v !== '') answersForMap[k] = v;
  }
  // Standard keys reflect Workspace identity resolution.
  if (workspaceName !== null) answersForMap['full_name'] = workspaceName;
  if (workspacePhone !== null) answersForMap['phone_number'] = workspacePhone;

  const fieldMap = buildLeadFieldMap({
    metaLeadId: submission.meta_lead_id,
    submittedAt:
      runStartedAt ?? submission.meta_created_time ?? submission.created_at,
    answers: answersForMap,
    formName: submission.form_name,
    campaignName: submission.campaign_name,
    adName: submission.ad_name,
    source: sourceFromWorkspace ?? sheetsSourceLabel(submission.source),
    assigneeDisplay: business.assigneeDisplay,
    leadType: business.leadType,
    stage: business.stage,
  });
  // Force the Workspace-resolved contact identity onto the standard
  // slots (buildLeadFieldMap derives them from answers, but the
  // contact row wins in the Workspace and must win here too).
  if (workspaceName !== null) fieldMap['name'] = workspaceName;
  if (workspacePhone !== null) fieldMap['phone'] = workspacePhone;
  if (workspaceEmail !== null) fieldMap['email'] = workspaceEmail;
  return projectRowValues(fieldMap, columns);
}

/**
 * Record a row failure. Returns true when the row will retry
 * automatically (bounded backoff), false when the budget is spent
 * (terminal: parked for 30 days with a final error, revived only
 * by manual retry). Never throws for DB failures — callers treat
 * a throw as "leave the claim", so this swallows nothing and lets
 * the stale-claim reaper recover the row.
 */
async function markRowFailed(
  db: SupabaseClient,
  row: QueueRow,
  message: string,
  retry: number | 'terminal' | null
): Promise<boolean> {
  const terminal = retry === 'terminal' || retry === null;
  const attempt = terminal ? row.max_attempts : row.attempts + 1;
  const willRetry = !terminal && attempt < row.max_attempts;
  const finalMessage = willRetry
    ? message
    : `${message}${exhaustedSuffix(attempt, row.max_attempts)}`;
  await db
    .from('meta_lead_sheets_queue')
    .update({
      status: 'failed',
      attempts: attempt,
      last_error: finalMessage.slice(0, 500),
      next_retry_at:
        willRetry && typeof retry === 'number'
          ? new Date(Date.now() + retry).toISOString()
          : new Date(Date.now() + EXHAUSTED_PARK_MS).toISOString(),
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  return willRetry;
}

/** Rows rewritten per layout-remap chunk (bounded Google + DB work). */
export const REMAP_CHUNK_SIZE = 100;

export interface RemapChunkResult {
  done: boolean;
  remapped: number;
  skipped: number;
}

/**
 * Roll one chunk of already-written managed rows onto the CURRENT
 * column layout. Rows are rebuilt from the database (never from
 * sheet contents) in ascending row-number order from `cursor`;
 * each chunk persists the new cursor so a crash resumes safely.
 * When no rows remain, the header is rewritten to the new layout,
 * the ID-column visibility is applied, and the remap flag clears.
 * Per-row Google failures skip that row (counted, logged) rather
 * than aborting the rollout. Never touches unmapped rows or user
 * content — only queue rows with a recorded sheet_row_number.
 */
export async function remapLayoutChunk(
  db: SupabaseClient,
  accessToken: string,
  config: {
    account_id: string;
    form_id: string;
    spreadsheet_id: string;
    sheet_tab: string;
    column_config: unknown;
  },
  cursor: number | null,
  fetchImpl: typeof fetch = fetch,
  chunkSize = REMAP_CHUNK_SIZE
): Promise<RemapChunkResult> {
  const columns = resolveEffectiveColumns(config.column_config);
  const layout = computeManagedLayout(columns);
  const from = typeof cursor === 'number' ? cursor : 0;

  // Bound the scan: only sent, mapped rows past the cursor. Filtering
  // `> cursor` happens in memory (small bounded set) so the resume
  // point survives crashes without per-row version bookkeeping.
  const { data, error } = await db
    .from('meta_lead_sheets_queue')
    .select('id, sheet_row_number, submission_id')
    .eq('account_id', config.account_id)
    .eq('status', 'sent')
    .not('sheet_row_number', 'is', null)
    .order('sheet_row_number', { ascending: true })
    .limit(500);
  if (error) throw error;
  const candidates = (
    (data ?? []) as Array<{
      id: string;
      sheet_row_number: number | null;
      submission_id: string;
    }>
  ).filter(
    (r) => typeof r.sheet_row_number === 'number' && r.sheet_row_number > from
  );
  const batch = candidates.slice(0, Math.max(1, Math.min(chunkSize, 500)));

  if (batch.length === 0) {
    // Rollout complete: swap the header, then fix ID visibility.
    await ensureSheetsHeader(
      accessToken,
      config.spreadsheet_id,
      config.sheet_tab,
      layout.headers,
      fetchImpl
    );
    await applyIdColumnVisibility(
      accessToken,
      config.spreadsheet_id,
      config.sheet_tab,
      layout.idVisible,
      fetchImpl,
      layout.idColumnIndex
    );
    await db
      .from('meta_lead_sheets_configs')
      .update({
        pending_remap: false,
        remap_cursor: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', config.account_id)
      .eq('form_id', config.form_id);
    return { done: true, remapped: 0, skipped: 0 };
  }

  const rewrites: Array<{ rowNumber: number; values: (string | number)[] }> =
    [];
  let skipped = 0;
  let maxNumber = from;
  for (const item of batch) {
    const rowNumber = item.sheet_row_number as number;
    maxNumber = Math.max(maxNumber, rowNumber);
    try {
      const submission = await loadSubmission(
        db,
        config.account_id,
        item.submission_id
      );
      // Only this table's form is remapped; other forms' rows keep
      // their own layout rollout (each table owns its sheet range).
      if (
        !submission ||
        !submission.flow_run_id ||
        submission.form_id !== config.form_id
      ) {
        skipped += 1;
        continue;
      }
      const values = await buildRowValues(
        db,
        config.account_id,
        submission,
        columns
      );
      rewrites.push({ rowNumber, values });
    } catch (err) {
      console.error(
        `[meta-sheets] remap skipped row ${rowNumber}:`,
        err instanceof Error ? err.message : err
      );
      skipped += 1;
    }
  }
  if (rewrites.length > 0) {
    await rewriteSheetRows(
      accessToken,
      config.spreadsheet_id,
      config.sheet_tab,
      rewrites,
      fetchImpl
    );
  }
  await db
    .from('meta_lead_sheets_configs')
    .update({ remap_cursor: maxNumber, updated_at: new Date().toISOString() })
    .eq('account_id', config.account_id)
    .eq('form_id', config.form_id);
  return { done: false, remapped: rewrites.length, skipped };
}

/**
 * Apply ID-column visibility at its configured position: hidden
 * when the ID is not a selected visible column, shown otherwise.
 * Cosmetic; failures are logged and swallowed (data stays correct
 * either way). When the ID no longer sits at the legacy column-A
 * position, column A is unhidden first so a stale hidden flag from
 * a pre-reorder layout can never hide the new first data column.
 */
export async function applyIdColumnVisibility(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  idVisible: boolean,
  fetchImpl: typeof fetch = fetch,
  idColumnIndex: number = META_SHEETS_LEAD_ID_COL
): Promise<void> {
  try {
    if (idColumnIndex !== META_SHEETS_LEAD_ID_COL) {
      await setSheetColumnHidden(
        accessToken,
        spreadsheetId,
        tab,
        META_SHEETS_LEAD_ID_COL,
        false,
        fetchImpl
      );
    }
    await setSheetColumnHidden(
      accessToken,
      spreadsheetId,
      tab,
      idColumnIndex,
      !idVisible,
      fetchImpl
    );
  } catch (err) {
    console.error(
      '[meta-sheets] ID column visibility update failed (cosmetic only):',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Drain one pending layout rollout (bounded chunk). Returns true
 * when a remap was in flight (normal due-row processing should
 * wait one run so the sheet holds exactly one layout at a time).
 */
async function drainPendingRemap(
  db: SupabaseClient,
  fetchImpl: typeof fetch
): Promise<boolean> {
  const { data, error } = await db
    .from('meta_lead_sheets_configs')
    .select(
      'account_id, form_id, spreadsheet_id, sheet_tab, column_config, remap_cursor'
    )
    .eq('pending_remap', true)
    .limit(3);
  if (error) {
    console.error('[meta-sheets] remap scan failed:', error.message);
    return false;
  }
  const pending = (data ?? []) as Array<{
    account_id: string;
    form_id: string;
    spreadsheet_id: string;
    sheet_tab: string;
    column_config: unknown;
    remap_cursor: number | null;
  }>;
  if (pending.length === 0) return false;
  for (const cfg of pending) {
    try {
      const token = await getSheetsAccessToken(db, cfg.account_id, fetchImpl);
      await remapLayoutChunk(
        db,
        token,
        cfg,
        cfg.remap_cursor ?? 0,
        fetchImpl,
        REMAP_CHUNK_SIZE
      );
    } catch (err) {
      await db
        .from('meta_lead_sheets_configs')
        .update({
          last_error: (err instanceof Error ? err.message : String(err)).slice(
            0,
            500
          ),
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', cfg.account_id)
        .eq('form_id', cfg.form_id);
      console.error(
        `[meta-sheets] remap chunk failed for ${cfg.account_id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return true;
}

export interface CleanupResult {
  removed: number;
  skippedUnmapped: number;
}

/**
 * Explicit, confirmed cleanup of ONE table's managed rows (used when
 * a table's target changes or its sheet is retired). Only rows with
 * a verified queue mapping (account + submission of THIS form +
 * recorded sheet_row_number) are ever deleted; sent rows without a
 * recorded number and all user content are never touched. Remaining
 * managed row numbers are fixed arithmetically after the bottom-to-
 * top delete, and the removed queue rows are dropped so the leads
 * do not re-sync. Throws on Google failures (nothing is half-applied
 * except the sheet delete itself, which is reported).
 */
export async function cleanupTableRows(
  db: SupabaseClient,
  accessToken: string,
  accountId: string,
  formId: string,
  fetchImpl: typeof fetch = fetch
): Promise<CleanupResult> {
  const config = await loadTableConfig(db, accountId, formId);
  if (!config) throw new Error('Sheets sync is not configured for this table.');
  const { data: queued, error: queueErr } = await db
    .from('meta_lead_sheets_queue')
    .select('id, submission_id, sheet_row_number')
    .eq('account_id', accountId)
    .eq('status', 'sent');
  if (queueErr) throw queueErr;
  const sentRows = (queued ?? []) as Array<{
    id: string;
    submission_id: string;
    sheet_row_number: number | null;
  }>;
  const mapped = sentRows.filter(
    (r) =>
      typeof r.sheet_row_number === 'number' &&
      (r.sheet_row_number as number) >= 2
  );
  let skippedUnmapped = sentRows.length - mapped.length;

  // Keep only this table's verified rows (tenant + form scoped).
  const toDelete: Array<{ queueId: string; rowNumber: number }> = [];
  for (const row of mapped) {
    const submission = await loadSubmission(db, accountId, row.submission_id);
    if (!submission) {
      // Orphaned mapping (submission gone): drop the queue row and
      // count it as skipped — never delete a sheet row we cannot
      // verify (it may be user content by now).
      skippedUnmapped += 1;
      continue;
    }
    if (submission.form_id === formId) {
      toDelete.push({
        queueId: row.id,
        rowNumber: row.sheet_row_number as number,
      });
    }
  }
  if (toDelete.length === 0) {
    return { removed: 0, skippedUnmapped };
  }

  const numbers = toDelete.map((d) => d.rowNumber).sort((a, b) => a - b);
  await deleteSheetRows(
    accessToken,
    config.spreadsheet_id,
    config.sheet_tab,
    numbers,
    fetchImpl
  );

  // Fix surviving managed row numbers arithmetically (a bottom-to-top
  // delete shifts every row below each deletion up by one).
  const remaining = sentRows.filter(
    (r) => !toDelete.some((d) => d.queueId === r.id)
  );
  for (const row of remaining) {
    if (typeof row.sheet_row_number !== 'number') continue;
    let shift = 0;
    for (const n of numbers) {
      if (n < (row.sheet_row_number as number)) shift += 1;
      else break;
    }
    if (shift > 0) {
      await db
        .from('meta_lead_sheets_queue')
        .update({ sheet_row_number: (row.sheet_row_number as number) - shift })
        .eq('id', row.id);
    }
  }
  await db
    .from('meta_lead_sheets_queue')
    .delete()
    .in(
      'id',
      toDelete.map((d) => d.queueId)
    );
  return { removed: toDelete.length, skippedUnmapped };
}

/**
 * Drain due queue rows to Google Sheets. Never throws for per-row
 * failures; each outcome is recorded on its row + config.
 *
 * Idempotent: a lead maps to exactly one sheet row via the
 * configured Meta Lead ID column. Stored `sheet_row_number` is
 * preferred; on resume (row appended but mapping not saved) we
 * re-scan the ID column before appending, so retries never
 * duplicate.
 */
interface ReadyRow {
  row: QueueRow;
  /** Status before this drain claimed it (restored on quota park). */
  originalStatus: string;
  submission: SubmissionRow;
  config: ConfigRow;
}

interface GroupWork {
  key: string;
  accountId: string;
  config: ConfigRow;
  columns: SheetsColumnDef[];
  layout: ReturnType<typeof computeManagedLayout>;
  items: Array<{
    row: QueueRow;
    originalStatus: string;
    submission: SubmissionRow;
    values: string[];
    targetRow?: number | null;
    /** Per-row fallback append failed (excluded from the re-scan). */
    appendFailed?: boolean;
  }>;
}

export async function drainSheetsQueue(
  db: SupabaseClient,
  opts: {
    limit?: number;
    onlyAccountId?: string;
    /** Restrict this drain to one table's form (per-table sync-now). */
    onlyFormId?: string;
    force?: boolean;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<DrainResult> {
  const fetchImpl = withSheetsThrottle(opts.fetchImpl ?? fetch);
  const limit = Math.max(
    1,
    Math.min(opts.limit ?? META_SHEETS_SWEEP_LIMIT, 100)
  );
  const result: DrainResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    retrying: 0,
    skippedDisabled: 0,
    skippedNoConfig: 0,
    needsReauth: 0,
  };
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  // Reclaim stale `sending` rows from crashed workers.
  await db
    .from('meta_lead_sheets_queue')
    .update({ status: 'queued', claimed_at: null, updated_at: nowIso })
    .eq('status', 'sending')
    .lte('updated_at', staleIso);

  // A layout rollout in flight takes over the drain (bounded chunk);
  // due rows wait one run so each sheet holds exactly one layout.
  if (await drainPendingRemap(db, fetchImpl)) {
    return result;
  }

  let query = db
    .from('meta_lead_sheets_queue')
    .select(
      'id, account_id, submission_id, flow_run_id, meta_lead_id, status, attempts, max_attempts, sheet_row_number'
    )
    .in('status', ['queued', 'failed'])
    .lte('next_retry_at', nowIso)
    .order('next_retry_at', { ascending: true })
    .limit(limit);
  if (opts.onlyAccountId) query = query.eq('account_id', opts.onlyAccountId);
  const { data: due, error } = await query;
  if (error) {
    console.error('[meta-sheets] due-jobs scan failed:', error.message);
    return result;
  }
  const rows = ((due ?? []) as QueueRow[]).filter(
    // Exhausted rows never auto-retry (they would loop forever on
    // permanent errors and burn quota re-probing them). They stay
    // visible as failed until a manual retry revives them.
    (r) => (r.attempts ?? 0) < (r.max_attempts ?? META_SHEETS_MAX_ATTEMPTS)
  );
  const ensuredHeaders = new Set<string>();
  const tokens = new Map<string, string>();

  /** Record one row outcome + attribute it to its own table only. */
  const recordFailure = async (
    row: QueueRow,
    config: ConfigRow | null,
    message: string,
    retry: number | 'terminal' | null
  ): Promise<void> => {
    const willRetry = await markRowFailed(db, row, message, retry);
    if (config) {
      await db
        .from('meta_lead_sheets_configs')
        .update({ last_error: message.slice(0, 500), updated_at: nowIso })
        .eq('account_id', row.account_id)
        .eq('form_id', config.form_id);
    }
    if (willRetry) result.retrying += 1;
    else result.failed += 1;
    console.error(
      `[meta-sheets] job ${row.id} failed (attempt ${row.attempts + 1}): ${message.slice(0, 200)}`
    );
  };

  /** Release a claim without burning an attempt (pause/config paths). */
  const releaseClaim = async (rowId: string, status: string): Promise<void> => {
    await db
      .from('meta_lead_sheets_queue')
      .update({ status, claimed_at: null, updated_at: nowIso })
      .eq('id', rowId);
  };

  /** Quota trip state: once any Google call is throttled, the rest
   *  of this drain parks without touching the API. Shared with
   *  every worker through next_retry_at (see parkForQuota). */
  let tripDelayMs: number | null = null;

  /** Park claimed rows with a future retry: no attempt is burned,
   *  and every concurrent worker's due-scan skips them until the
   *  backoff elapses. This is the cross-worker coordination. */
  const parkForQuota = async (
    items: Array<{ row: QueueRow; originalStatus: string }>,
    delayMs: number
  ): Promise<void> => {
    if (items.length === 0) return;
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    console.error(
      `[meta-sheets] quota trip: parking ${items.length} row(s) for ${Math.round(delayMs / 1000)}s`
    );
    for (const item of items) {
      await db
        .from('meta_lead_sheets_queue')
        .update({
          status: item.originalStatus,
          next_retry_at: retryAt,
          claimed_at: null,
          updated_at: nowIso,
        })
        .eq('id', item.row.id);
      result.retrying += 1;
    }
  };

  const quotaDelayFor = (err: unknown, attempt: number): number =>
    sheetsQuotaDelayMs(attempt, quotaRetryAfterMs(err));

  // ---------- Phase 1: claim + DB-only prelim (no Google calls) --
  const ready: ReadyRow[] = [];
  for (const row of rows) {
    result.attempted += 1;
    // Pre-claim status (restored if a quota trip parks the row).
    // Read BEFORE claiming: the claim itself moves the row on.
    const originalStatus = row.status;
    // Claim.
    const { data: claimed } = await db
      .from('meta_lead_sheets_queue')
      .update({ status: 'sending', claimed_at: nowIso, updated_at: nowIso })
      .eq('id', row.id)
      .in('status', ['queued', 'failed'])
      .select('id')
      .maybeSingle();
    if (!claimed) continue;

    const submission = await loadSubmission(
      db,
      row.account_id,
      row.submission_id
    ).catch((err) => {
      console.error('[meta-sheets] submission load failed:', err);
      return undefined;
    });
    if (submission === undefined) {
      // Load threw (DB down): leave the claim for the stale-claim
      // reaper rather than burning an attempt or dropping the row.
      continue;
    }
    if (!submission) {
      // Submission deleted — drop the queue row (nothing to sync).
      await db.from('meta_lead_sheets_queue').delete().eq('id', row.id);
      continue;
    }
    if (opts.onlyFormId && submission.form_id !== opts.onlyFormId) {
      await releaseClaim(row.id, 'queued');
      continue;
    }
    // One table's config per row: a form with no table config never
    // writes. The claim is released untouched so configuring the
    // table later resumes instantly.
    if (!submission.form_id) {
      await recordFailure(
        row,
        null,
        'Lead has no form reference; cannot route to a table.',
        'terminal'
      );
      continue;
    }
    const config = await loadTableConfig(
      db,
      row.account_id,
      submission.form_id
    ).catch(() => null);
    if (!config) {
      await releaseClaim(row.id, 'queued');
      result.skippedNoConfig += 1;
      continue;
    }
    if (!config.auto_sync && !opts.force) {
      await releaseClaim(row.id, 'queued');
      result.skippedDisabled += 1;
      continue;
    }
    ready.push({ row, originalStatus, submission, config });
  }

  // ---------- Phase 2: batched Google writes per spreadsheet -----
  // Rows bound for the same (account, spreadsheet, tab) share one
  // tab check, one header ensure, one ID-column scan, and one
  // append — instead of ~5 API calls per row. Within a group,
  // rows keep due order, so a lead's update-vs-append decision is
  // still made against a single consistent scan.
  const groups = new Map<string, GroupWork>();
  for (const item of ready) {
    const key = `${item.row.account_id}::${item.config.spreadsheet_id}::${item.config.sheet_tab}`;
    let group = groups.get(key);
    if (!group) {
      const columns = resolveEffectiveColumns(item.config.column_config);
      group = {
        key,
        accountId: item.row.account_id,
        config: item.config,
        columns,
        layout: computeManagedLayout(columns),
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push({ ...item, values: [] });
  }

  for (const group of groups.values()) {
    if (tripDelayMs !== null) {
      // A previous group tripped quota: park this whole group
      // without touching the API.
      await parkForQuota(group.items, tripDelayMs);
      continue;
    }
    await processGroup(group);
  }
  return result;

  /** Resolve (and cache per drain) one account's access token. */
  async function tokenFor(accountId: string): Promise<string> {
    const cached = tokens.get(accountId);
    if (cached) return cached;
    const token = await getSheetsAccessToken(db, accountId, fetchImpl);
    tokens.set(accountId, token);
    return token;
  }

  /** Handle one spreadsheet group end-to-end. */
  async function processGroup(group: GroupWork): Promise<void> {
    const { config, columns, layout } = group;
    const remaining = [...group.items];

    let accessToken: string;
    try {
      accessToken = await tokenFor(group.accountId);
    } catch (authErr) {
      if (isQuotaSheetsError(authErr)) {
        // Token endpoint throttled: nothing was consumed, park the
        // whole group untouched for a quota backoff.
        const delayMs = quotaDelayFor(authErr, 1);
        tripDelayMs = delayMs;
        await parkForQuota(remaining, delayMs);
        return;
      }
      // Genuinely unauthorized: existing reauth path per row (rows
      // stay queued with an hourly backoff; config surfaces
      // needs_reauth). Attempts are NOT burned for credential
      // problems that a retry cannot fix.
      const message =
        authErr instanceof SheetsAuthError
          ? 'Google authorization expired or was revoked. Reconnect Google Sheets.'
          : authErr instanceof Error
            ? authErr.message
            : String(authErr);
      for (const item of remaining) {
        await db
          .from('meta_lead_sheets_queue')
          .update({
            status: 'queued',
            last_error: message.slice(0, 500),
            next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            claimed_at: null,
            updated_at: nowIso,
          })
          .eq('id', item.row.id);
        await db
          .from('meta_lead_sheets_configs')
          .update({ last_error: message.slice(0, 500), updated_at: nowIso })
          .eq('account_id', item.row.account_id)
          .eq('form_id', config.form_id);
        result.needsReauth += 1;
      }
      return;
    }

    // The tab must exist — never auto-create, never fall back to
    // another tab. A renamed/deleted tab surfaces as an explicit,
    // actionable error instead of a silent write elsewhere.
    try {
      await assertWorksheetTabExists(
        accessToken,
        config.spreadsheet_id,
        config.sheet_tab,
        fetchImpl
      );
      const headerKey = `${config.spreadsheet_id}::${config.sheet_tab}`;
      if (!ensuredHeaders.has(headerKey)) {
        await ensureSheetsHeader(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          layout.headers,
          fetchImpl
        );
        ensuredHeaders.add(headerKey);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isQuotaSheetsError(err)) {
        const delayMs = quotaDelayFor(
          err,
          minAttempts(remaining) + 1
        );
        tripDelayMs = delayMs;
        await parkForQuota(remaining, delayMs);
        return;
      }
      for (const item of remaining) {
        if (err instanceof TabMissingError) {
          // Configuration error (renamed/deleted tab): terminal.
          // Never writes elsewhere, never drops the row.
          await recordFailure(
            item.row,
            config,
            `Worksheet "${err.tab}" was not found. Select a replacement tab in this table's Google Sheets settings.`,
            'terminal'
          );
        } else {
          await recordFailure(
            item.row,
            config,
            message,
            retryDelayFor(err, item.row.attempts + 1)
          );
        }
      }
      return;
    }

    // Row values are DB-only: build each row independently so one
    // bad row never poisons its group.
    const withValues: Array<(typeof remaining)[number]> = [];
    for (const item of remaining) {
      try {
        item.values = await buildRowValues(
          db,
          item.row.account_id,
          item.submission,
          columns
        );
        withValues.push(item);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordFailure(
          item.row,
          config,
          message,
          sheetsRetryDelayMs(item.row.attempts + 1)
        );
      }
    }
    if (withValues.length === 0) return;

    // One ID-column scan for the whole group (was: one per row,
    // plus a second scan per append).
    let found: Map<string, number>;
    try {
      found = await findSheetsRowsByLeadId(
        accessToken,
        config.spreadsheet_id,
        config.sheet_tab,
        withValues.map((w) => w.submission.meta_lead_id),
        fetchImpl,
        layout.idColumnIndex
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isQuotaSheetsError(err)) {
        const delayMs = quotaDelayFor(err, minAttempts(withValues) + 1);
        tripDelayMs = delayMs;
        await parkForQuota(withValues, delayMs);
        return;
      }
      for (const item of withValues) {
        await recordFailure(
          item.row,
          config,
          message,
          retryDelayFor(err, item.row.attempts + 1)
        );
      }
      return;
    }

    const updates: typeof withValues = [];
    const creates: typeof withValues = [];
    for (const item of withValues) {
      const target =
        item.row.sheet_row_number ??
        found.get(item.submission.meta_lead_id) ??
        null;
      if (target) {
        item.targetRow = target;
        updates.push(item);
      } else {
        creates.push(item);
      }
    }

    // Updates stay per-row PUTs (idempotent overwrites by row
    // number); a quota error trips the drain and parks the rest.
    for (let i = 0; i < updates.length; i++) {
      const item = updates[i];
      if (tripDelayMs !== null) {
        await parkForQuota(
          [...updates.slice(i), ...creates],
          tripDelayMs
        );
        return;
      }
      try {
        await updateSheetsRow(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          item.targetRow as number,
          item.values,
          fetchImpl
        );
        await markSent(item, item.targetRow as number);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isQuotaSheetsError(err)) {
          const delayMs = quotaDelayFor(err, item.row.attempts + 1);
          tripDelayMs = delayMs;
          await recordFailure(item.row, config, quotaMessage(message), delayMs);
          await parkForQuota([...updates.slice(i + 1), ...creates], delayMs);
          return;
        }
        await recordFailure(
          item.row,
          config,
          message,
          retryDelayFor(err, item.row.attempts + 1)
        );
      }
    }

    // One append for all new rows, then one re-scan to resolve the
    // appended row numbers (was: append + re-scan per row).
    if (creates.length > 0) {
      if (tripDelayMs !== null) {
        await parkForQuota(creates, tripDelayMs);
        return;
      }
      try {
        await appendSheetsRows(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          creates.map((c) => c.values),
          fetchImpl
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isQuotaSheetsError(err)) {
          const delayMs = quotaDelayFor(err, minAttempts(creates) + 1);
          tripDelayMs = delayMs;
          for (const item of creates) {
            await recordFailure(item.row, config, quotaMessage(message), delayMs);
          }
          return;
        }
        // Non-quota batch failure: fall back to per-row appends so
        // one bad row cannot hold the whole group hostage.
        for (let i = 0; i < creates.length; i++) {
          const item = creates[i];
          if (tripDelayMs !== null) {
            await parkForQuota(creates.slice(i), tripDelayMs);
            return;
          }
          try {
            await appendSheetsRows(
              accessToken,
              config.spreadsheet_id,
              config.sheet_tab,
              [item.values],
              fetchImpl
            );
            item.appendFailed = false;
          } catch (singleErr) {
            const singleMessage =
              singleErr instanceof Error ? singleErr.message : String(singleErr);
            if (isQuotaSheetsError(singleErr)) {
              const delayMs = quotaDelayFor(singleErr, item.row.attempts + 1);
              tripDelayMs = delayMs;
              await recordFailure(
                item.row,
                config,
                quotaMessage(singleMessage),
                delayMs
              );
              await parkForQuota(creates.slice(i + 1), delayMs);
              return;
            }
            await recordFailure(
              item.row,
              config,
              singleMessage,
              retryDelayFor(singleErr, item.row.attempts + 1)
            );
            item.appendFailed = true;
          }
        }
      }
      const appended = creates.filter((c) => !c.appendFailed);
      // Resolve appended row numbers with a single re-scan. (Sheets
      // append has no row-number response; a second read is the
      // documented way to learn it.)
      try {
        const resolved = await findSheetsRowsByLeadId(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          appended.map((c) => c.submission.meta_lead_id),
          fetchImpl,
          layout.idColumnIndex
        );
        for (const item of appended) {
          await markSent(
            item,
            resolved.get(item.submission.meta_lead_id) ?? null
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isQuotaSheetsError(err)) {
          const delayMs = quotaDelayFor(err, minAttempts(appended) + 1);
          tripDelayMs = delayMs;
          for (const item of appended) {
            await recordFailure(item.row, config, quotaMessage(message), delayMs);
          }
          return;
        }
        for (const item of appended) {
          await recordFailure(
            item.row,
            config,
            message,
            retryDelayFor(err, item.row.attempts + 1)
          );
        }
      }
    }
    /** Persist one successful write (row mapping + table success). */
    async function markSent(
      item: (typeof withValues)[number],
      targetRow: number | null
    ): Promise<void> {
      await db
        .from('meta_lead_sheets_queue')
        .update({
          status: 'sent',
          last_error: null,
          next_retry_at: nowIso,
          claimed_at: null,
          sheet_row_number: targetRow,
          updated_at: nowIso,
        })
        .eq('id', item.row.id);
      result.sent += 1;
    }

    // One success stamp per spreadsheet per drain (was: per row).
    await db
      .from('meta_lead_sheets_configs')
      .update({
        last_success_at: nowIso,
        last_error: null,
        updated_at: nowIso,
      })
      .eq('account_id', group.accountId)
      .eq('form_id', config.form_id);
  }

  /** Smallest attempts in a set (quota delay must cover the freshest row). */
  function minAttempts(
    items: Array<{ row: QueueRow }>
  ): number {
    let min = Number.POSITIVE_INFINITY;
    for (const item of items) {
      min = Math.min(min, item.row.attempts ?? 0);
    }
    return min === Number.POSITIVE_INFINITY ? 0 : min;
  }

  /** Classify a Google failure: quota/transient backoff or terminal. */
  function retryDelayFor(err: unknown, attempt: number): number | 'terminal' {
    if (isQuotaSheetsError(err)) {
      return sheetsQuotaDelayMs(attempt, quotaRetryAfterMs(err));
    }
    if (isTransientSheetsError(err)) return sheetsRetryDelayMs(attempt);
    if (err instanceof SheetsApiError) {
      // Remaining 4xx (validation, permission, not-found): retrying
      // cannot fix them — terminal with a clear error.
      return 'terminal';
    }
    // Unknown/DB-adjacent failures: retryable with normal backoff.
    return sheetsRetryDelayMs(attempt);
  }

  function quotaMessage(message: string): string {
    return `Google Sheets API quota exceeded — backing off and retrying automatically: ${message.slice(0, 300)}`;
  }

  function quotaRetryAfterMs(err: unknown): number | null {
    if (err instanceof SheetsApiError) return err.retryAfterMs;
    const rec = (err ?? {}) as { retryAfterMs?: unknown };
    return typeof rec.retryAfterMs === 'number' ? rec.retryAfterMs : null;
  }
}

/**
 * Revive one table's failed rows for manual retry (the "61 failed
 * records" path): every `failed` row of THIS table (account +
 * form) returns to `queued` with a fresh attempt budget, due
 * immediately. Rows already `sent` are never matched, so synced
 * spreadsheet rows cannot duplicate; rows whose submission was
 * deleted are dropped by the drain instead of synced. Returns the
 * number of revived rows. Never throws for empty sets.
 */
export async function reviveTableFailedRows(
  db: SupabaseClient,
  accountId: string,
  formId: string
): Promise<{ revived: number }> {
  const nowIso = new Date().toISOString();
  // The queue carries no form_id: scope through this table's
  // submissions (bounded; per-table queues are small). Sent rows
  // are excluded by the status filter, so synced spreadsheet rows
  // can never duplicate.
  const { data: submissionRows, error: subError } = await db
    .from('meta_lead_submissions')
    .select('id')
    .eq('account_id', accountId)
    .eq('form_id', formId)
    .limit(5000);
  if (subError) throw subError;
  const submissionIds = (
    (submissionRows ?? []) as Array<{ id: string }>
  ).map((s) => s.id);
  if (submissionIds.length === 0) return { revived: 0 };
  const { data, error } = await db
    .from('meta_lead_sheets_queue')
    .update({
      status: 'queued',
      attempts: 0,
      last_error: null,
      next_retry_at: nowIso,
      claimed_at: null,
      updated_at: nowIso,
    })
    .eq('account_id', accountId)
    .in('submission_id', submissionIds)
    .eq('status', 'failed')
    .select('id');
  if (error) throw error;
  return { revived: ((data ?? []) as unknown[]).length };
}

export interface SheetsSyncStatus {
  configured: boolean;
  connected: boolean;
  needsReauth: boolean;
  email: string | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  sheetTab: string | null;
  autoSync: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending: number;
  /** Terminal failures (budget spent or permanent error). */
  failed: number;
  /** Failures scheduled for automatic retry (quota/transient backoff). */
  retrying: number;
  columns: SheetsColumnDef[] | null;
  remapPending: boolean;
  cleanupPreview: { managedRows: number };
}

/**
 * Per-table status for the Workspace sheet dialog (tokens never
 * returned). Pending/failed count only this table's submissions;
 * cleanup preview counts this table's verified managed rows.
 */
export async function getTableSheetsStatus(
  db: SupabaseClient,
  accountId: string,
  formId: string
): Promise<SheetsSyncStatus> {
  const [{ data: conn }, config] = await Promise.all([
    db
      .from('meta_lead_sheets_connections')
      .select('google_email, last_error')
      .eq('account_id', accountId)
      .maybeSingle(),
    loadTableConfig(db, accountId, formId),
  ]);
  const connection = conn as {
    google_email: string | null;
    last_error: string | null;
  } | null;
  const lastError = config?.last_error ?? connection?.last_error ?? null;

  // This table's submissions (bounded; per-table queues are small).
  const { data: submissionRows } = await db
    .from('meta_lead_submissions')
    .select('id')
    .eq('account_id', accountId)
    .eq('form_id', formId)
    .limit(5000);
  const submissionIds = new Set(
    ((submissionRows ?? []) as Array<{ id: string }>).map((s) => s.id)
  );
  let pending = 0;
  let failed = 0;
  let retrying = 0;
  let managed = 0;
  if (submissionIds.size > 0) {
    const { data: queueRows } = await db
      .from('meta_lead_sheets_queue')
      .select('submission_id, status, attempts, max_attempts, sheet_row_number')
      .eq('account_id', accountId)
      .limit(5000);
    for (const qr of (queueRows ?? []) as Array<{
      submission_id: string;
      status: string;
      attempts: number | null;
      max_attempts: number | null;
      sheet_row_number: number | null;
    }>) {
      if (!submissionIds.has(qr.submission_id)) continue;
      if (qr.status === 'queued' || qr.status === 'sending') pending += 1;
      else if (qr.status === 'failed') {
        // Scheduled for automatic retry vs terminally failed.
        if ((qr.attempts ?? 0) < (qr.max_attempts ?? META_SHEETS_MAX_ATTEMPTS)) {
          retrying += 1;
        } else {
          failed += 1;
        }
      } else if (qr.status === 'sent' && typeof qr.sheet_row_number === 'number')
        managed += 1;
    }
  }
  return {
    configured: metaSheetsOAuthConfiguredSafe(),
    connected: !!connection,
    needsReauth:
      !!connection?.last_error ||
      (lastError ?? '').toLowerCase().includes('reconnect'),
    email: connection?.google_email ?? null,
    spreadsheetId: config?.spreadsheet_id ?? null,
    spreadsheetUrl: config?.spreadsheet_url ?? null,
    spreadsheetTitle: config?.spreadsheet_title ?? null,
    sheetTab: config?.sheet_tab ?? null,
    autoSync: config?.auto_sync ?? false,
    lastSuccessAt: config?.last_success_at ?? null,
    lastError,
    pending,
    failed,
    retrying,
    columns: config ? resolveEffectiveColumns(config.column_config) : null,
    remapPending: config?.pending_remap === true,
    cleanupPreview: { managedRows: managed },
  };
}

function metaSheetsOAuthConfiguredSafe(): boolean {
  try {
    return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  } catch {
    return false;
  }
}
