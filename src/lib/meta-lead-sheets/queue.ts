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
  isAuthSheetsError,
  isTransientSheetsError,
  rewriteSheetRows,
  setSheetColumnHidden,
  SheetsApiError,
  TabMissingError,
  updateSheetsRow,
} from './sheets-client';

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

/**
 * Manual historical import for ONE table: classify + enqueue that
 * form's processed submissions (all, or an inclusive submission-day
 * range), resetting already-mapped rows to queued so the drain
 * refreshes them in place. Matching is always by stable Meta Lead
 * ID downstream, so re-imports update instead of duplicating;
 * Workspace rows are only read, never written. Only callers'
 * (account, form) scope is touched — every query below carries
 * both. Throws on DB failures (callers surface them); per-row
 * enqueue errors are counted, never thrown.
 */
export async function importTableLeads(
  db: SupabaseClient,
  accountId: string,
  formId: string,
  range: TableImportRange | null,
  limit = TABLE_IMPORT_LIMIT
): Promise<TableImportResult> {
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
  // update them in place rather than append.
  const mapped = new Set<string>();
  const subIds = batch.map((r) => r.id);
  if (subIds.length > 0) {
    const { data: queued, error: queueErr } = await db
      .from('meta_lead_sheets_queue')
      .select('submission_id, sheet_row_number')
      .eq('account_id', accountId)
      .in('submission_id', subIds);
    if (queueErr) throw queueErr;
    for (const q of (queued ?? []) as Array<{ submission_id: string; sheet_row_number: number | null }>) {
      if (typeof q.sheet_row_number === 'number') mapped.add(q.submission_id);
    }
  }

  const nowIso = new Date().toISOString();
  let total = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
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
    total += 1;
    // Reset sent/failed rows so the drain refreshes them in place
    // (matched by lead ID downstream — never appended twice).
    // In-flight (queued/sending) rows are left untouched.
    const { error: resetErr } = await db
      .from('meta_lead_sheets_queue')
      .update({ status: 'queued', claimed_at: null, next_retry_at: nowIso, updated_at: nowIso })
      .eq('account_id', accountId)
      .eq('submission_id', row.id)
      .in('status', ['sent', 'failed']);
    if (resetErr) {
      failed += 1;
      continue;
    }
    const { error: insertErr } = await db
      .from('meta_lead_sheets_queue')
      .insert({
        account_id: accountId,
        submission_id: row.id,
        flow_run_id: row.flow_run_id,
        meta_lead_id: row.meta_lead_id,
      });
    if (insertErr && !isUniqueViolation(insertErr)) {
      failed += 1;
      continue;
    }
    if (mapped.has(row.id)) updated += 1;
    else imported += 1;
  }
  return { total, imported, updated, skipped, failed, truncated };
}

export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
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

async function markRowFailed(
  db: SupabaseClient,
  row: QueueRow,
  message: string,
  retryInMs: number | null
): Promise<void> {
  const attempt = row.attempts + 1;
  const willRetry = attempt < row.max_attempts && retryInMs !== null;
  await db
    .from('meta_lead_sheets_queue')
    .update({
      status: willRetry ? 'failed' : 'failed',
      attempts: attempt,
      last_error: message.slice(0, 500),
      next_retry_at:
        willRetry && retryInMs !== null
          ? new Date(Date.now() + retryInMs).toISOString()
          : new Date(Date.now() + sheetsRetryDelayMs(attempt)).toISOString(),
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  // Terminal failures keep next_retry_at far out so the cron stops
  // hammering but the row stays visible for manual retry.
  if (!willRetry) {
    await db
      .from('meta_lead_sheets_queue')
      .update({
        next_retry_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      })
      .eq('id', row.id);
  }
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
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = Math.max(
    1,
    Math.min(opts.limit ?? META_SHEETS_SWEEP_LIMIT, 100)
  );
  const result: DrainResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
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
  const rows = (due ?? []) as QueueRow[];
  const ensuredHeaders = new Set<string>();

  for (const row of rows) {
    result.attempted += 1;
    // Claim.
    const { data: claimed } = await db
      .from('meta_lead_sheets_queue')
      .update({ status: 'sending', claimed_at: nowIso, updated_at: nowIso })
      .eq('id', row.id)
      .in('status', ['queued', 'failed'])
      .select('id')
      .maybeSingle();
    if (!claimed) continue;

    // Hoisted for the catch block: a per-row Google failure is
    // recorded against this table's config (never a sibling table's).
    let config: ConfigRow | null = null;
    try {
      const submission = await loadSubmission(
        db,
        row.account_id,
        row.submission_id
      );
      if (!submission) {
        // Submission deleted — drop the queue row (nothing to sync).
        await db.from('meta_lead_sheets_queue').delete().eq('id', row.id);
        continue;
      }
      if (opts.onlyFormId && submission.form_id !== opts.onlyFormId) {
        await db
          .from('meta_lead_sheets_queue')
          .update({ status: 'queued', claimed_at: null, updated_at: nowIso })
          .eq('id', row.id);
        continue;
      }
      // One table's config per row: a form with no table config never
      // writes. The claim is released untouched so configuring the
      // table later resumes instantly.
      if (!submission.form_id) {
        await markRowFailed(
          db,
          row,
          'Lead has no form reference; cannot route to a table.',
          null
        );
        result.failed += 1;
        continue;
      }
      config = await loadTableConfig(db, row.account_id, submission.form_id);
      if (!config) {
        await db
          .from('meta_lead_sheets_queue')
          .update({ status: 'queued', claimed_at: null, updated_at: nowIso })
          .eq('id', row.id);
        result.skippedNoConfig += 1;
        continue;
      }
      if (!config.auto_sync && !opts.force) {
        await db
          .from('meta_lead_sheets_queue')
          .update({ status: 'queued', claimed_at: null, updated_at: nowIso })
          .eq('id', row.id);
        result.skippedDisabled += 1;
        continue;
      }

      let accessToken: string;
      try {
        accessToken = await getSheetsAccessToken(db, row.account_id, fetchImpl);
      } catch (authErr) {
        const message =
          authErr instanceof SheetsAuthError
            ? 'Google authorization expired or was revoked. Reconnect Google Sheets.'
            : authErr instanceof Error
              ? authErr.message
              : String(authErr);
        await db
          .from('meta_lead_sheets_queue')
          .update({
            status: 'queued',
            attempts: row.attempts + 1,
            last_error: message.slice(0, 500),
            next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            claimed_at: null,
            updated_at: nowIso,
          })
          .eq('id', row.id);
        await db
          .from('meta_lead_sheets_configs')
          .update({ last_error: message.slice(0, 500), updated_at: nowIso })
          .eq('account_id', row.account_id)
          .eq('form_id', config.form_id);
        result.needsReauth += 1;
        result.failed += 1;
        continue;
      }

      const columns = resolveEffectiveColumns(config.column_config);
      const layout = computeManagedLayout(columns);

      // The tab must exist — never auto-create, never fall back to
      // another tab. A renamed/deleted tab surfaces as an explicit,
      // actionable error instead of a silent write elsewhere.
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

      const values = await buildRowValues(
        db,
        row.account_id,
        submission,
        columns
      );

      let targetRow = row.sheet_row_number;
      if (!targetRow) {
        const found = await findSheetsRowsByLeadId(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          [submission.meta_lead_id],
          fetchImpl,
          layout.idColumnIndex
        );
        targetRow = found.get(submission.meta_lead_id) ?? null;
      }
      if (targetRow) {
        await updateSheetsRow(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          targetRow,
          values,
          fetchImpl
        );
      } else {
        await appendSheetsRows(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          [values],
          fetchImpl
        );
        // Resolve the appended row number by re-scanning the ID
        // column. (Sheets append has no row-number response; a
        // second read is the documented way to learn it.)
        const found = await findSheetsRowsByLeadId(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          [submission.meta_lead_id],
          fetchImpl,
          layout.idColumnIndex
        );
        targetRow = found.get(submission.meta_lead_id) ?? null;
      }

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
        .eq('id', row.id);
      await db
        .from('meta_lead_sheets_configs')
        .update({
          last_success_at: nowIso,
          last_error: null,
          updated_at: nowIso,
        })
        .eq('account_id', row.account_id)
        .eq('form_id', config.form_id);
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Config writes below are scoped to THIS table only. config can
      // only be null when its own load threw (DB down) — then there is
      // no table to attribute, so skip the config write but still
      // record the row outcome.
      const markTableConfig = async (patch: Record<string, unknown>) => {
        if (!config) return;
        await db
          .from('meta_lead_sheets_configs')
          .update({ ...patch, updated_at: nowIso })
          .eq('account_id', row.account_id)
          .eq('form_id', config.form_id);
      };
      if (err instanceof TabMissingError) {
        // The worksheet was renamed or deleted: park the row with a
        // long backoff and an actionable error. Never write to
        // another tab, never drop the row.
        await db
          .from('meta_lead_sheets_queue')
          .update({
            status: 'failed',
            attempts: row.attempts + 1,
            last_error:
              `Worksheet "${err.tab}" was not found. Select a replacement tab in this table's Google Sheets settings.`.slice(
                0,
                500
              ),
            next_retry_at: new Date(
              Date.now() + 24 * 60 * 60_000
            ).toISOString(),
            claimed_at: null,
            updated_at: nowIso,
          })
          .eq('id', row.id);
        await markTableConfig({ last_error: message.slice(0, 500) });
        result.failed += 1;
      } else if (isAuthSheetsError(err)) {
        await db
          .from('meta_lead_sheets_queue')
          .update({
            status: 'queued',
            attempts: row.attempts + 1,
            last_error:
              'Google rejected the request (check sharing + reconnect).'.slice(
                0,
                500
              ),
            next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            claimed_at: null,
            updated_at: nowIso,
          })
          .eq('id', row.id);
        await markTableConfig({ last_error: message.slice(0, 500) });
        result.needsReauth += 1;
        result.failed += 1;
      } else if (isTransientSheetsError(err) || err instanceof SheetsApiError) {
        const attempt = row.attempts + 1;
        const retryIn = sheetsRetryDelayMs(attempt);
        await markRowFailed(
          db,
          { ...row, attempts: row.attempts },
          message,
          retryIn
        );
        await markTableConfig({ last_error: message.slice(0, 500) });
        result.failed += 1;
      } else {
        await markRowFailed(
          db,
          row,
          message,
          sheetsRetryDelayMs(row.attempts + 1)
        );
        result.failed += 1;
      }
      console.error(
        `[meta-sheets] job ${row.id} failed (attempt ${row.attempts + 1}): ${message.slice(0, 200)}`
      );
    }
  }
  return result;
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
  failed: number;
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
  let managed = 0;
  if (submissionIds.size > 0) {
    const { data: queueRows } = await db
      .from('meta_lead_sheets_queue')
      .select('submission_id, status, sheet_row_number')
      .eq('account_id', accountId)
      .limit(5000);
    for (const qr of (queueRows ?? []) as Array<{
      submission_id: string;
      status: string;
      sheet_row_number: number | null;
    }>) {
      if (!submissionIds.has(qr.submission_id)) continue;
      if (qr.status === 'queued' || qr.status === 'sending') pending += 1;
      else if (qr.status === 'failed') failed += 1;
      else if (qr.status === 'sent' && typeof qr.sheet_row_number === 'number')
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
