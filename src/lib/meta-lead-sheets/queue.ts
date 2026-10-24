// ============================================================
// Meta Lead Ads → Google Sheets — durable outbox.
//
// Flow (all Meta-only, never Flow Tables):
//   * Ingestion (`processSubmissionById` success), assignment
//     changes, and Workspace cell edits call `maybeEnqueue...`
//     AFTER the underlying write succeeded. Enqueue is a single
//     idempotent INSERT keyed UNIQUE(account_id, submission_id):
//     polling/import/retries/concurrent workers collapse to one row.
//     Enqueue NEVER throws into lead processing.
//   * `drainSheetsQueue` (cron + manual sync-now) claims due rows,
//     writes to Sheets idempotently (update existing row matched by
//     stable Meta Lead ID column A, else append), and records the
//     sheet row number for future updates.
//   * Google failures use bounded exponential backoff and never roll
//     back the lead. Auth failures leave rows queued with a long
//     backoff + surface `needs_reauth` via config.last_error.
//   * Historical backfill enqueues existing processed submissions in
//     safe batches; resume is automatic via the queue.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isUniqueViolation } from "@/lib/contacts/dedupe";

import {
  META_SHEETS_BATCH_SIZE,
  META_SHEETS_MAX_ATTEMPTS,
  META_SHEETS_SWEEP_LIMIT,
  sheetsRetryDelayMs,
} from "./constants";
import { buildSheetsRow, resolveBusinessDisplays, sheetsSourceLabel } from "./mapping";
import { getSheetsAccessToken, SheetsAuthError } from "./oauth";
import {
  appendSheetsRows,
  ensureSheetsHeader,
  ensureSheetsTab,
  findSheetsRowsByLeadId,
  isAuthSheetsError,
  isTransientSheetsError,
  SheetsApiError,
  updateSheetsRow,
} from "./sheets-client";

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
  form_name: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  source: string | null;
  answers: Record<string, string> | null;
  meta_created_time: string | null;
  created_at: string;
}

async function getAutoSync(
  db: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  const { data } = await db
    .from("meta_lead_sheets_configs")
    .select("auto_sync")
    .eq("account_id", accountId)
    .maybeSingle();
  return (data as { auto_sync?: boolean } | null)?.auto_sync === true;
}

async function loadSubmission(
  db: SupabaseClient,
  accountId: string,
  submissionId: string,
): Promise<SubmissionRow | null> {
  const { data, error } = await db
    .from("meta_lead_submissions")
    .select(
      "id, account_id, meta_lead_id, flow_run_id, form_name, campaign_name, ad_name, source, answers, meta_created_time, created_at",
    )
    .eq("id", submissionId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as SubmissionRow | null) ?? null;
}

/**
 * Idempotent enqueue after a lead was created/updated. Never throws.
 * Skips when the account has no Meta Sheets config or auto_sync is off
 * (manual sync-now can still enqueue via `enqueueSheetsSyncForRun`
 * with force, or backfill explicitly).
 */
export async function maybeEnqueueSheetsSync(
  db: SupabaseClient,
  args: { accountId: string; submissionId: string },
): Promise<{ enqueued: boolean }> {
  try {
    if (!(await getAutoSync(db, args.accountId))) return { enqueued: false };
    const submission = await loadSubmission(db, args.accountId, args.submissionId);
    if (!submission) return { enqueued: false };
    // Only sync leads that actually became Workspace rows; failed /
    // ignored submissions have no flow_run_id yet and will be
    // enqueued when (if) they process.
    if (!submission.flow_run_id) return { enqueued: false };
    const { error } = await db.from("meta_lead_sheets_queue").insert({
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
      "[meta-sheets] enqueue failed (lead processing unaffected):",
      err instanceof Error ? err.message : err,
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
  args: { accountId: string; runId: string },
): Promise<{ enqueued: boolean }> {
  try {
    if (!(await getAutoSync(db, args.accountId))) return { enqueued: false };
    const { data, error } = await db
      .from("meta_lead_submissions")
      .select("id")
      .eq("account_id", args.accountId)
      .eq("flow_run_id", args.runId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { id: string } | null;
    if (!row) return { enqueued: false };
    return maybeEnqueueSheetsSync(db, { accountId: args.accountId, submissionId: row.id });
  } catch (err) {
    console.error(
      "[meta-sheets] enqueue-for-run failed (assignment unaffected):",
      err instanceof Error ? err.message : err,
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
 * Historical sync: enqueue existing processed submissions in batches.
 * Idempotent (unique key) — safe to resume after interruption.
 */
export async function backfillAccountSheets(
  db: SupabaseClient,
  accountId: string,
  limit = 500,
): Promise<BackfillResult> {
  const bounded = Math.max(1, Math.min(limit, 2000));
  const { data, error } = await db
    .from("meta_lead_submissions")
    .select("id, flow_run_id, meta_lead_id")
    .eq("account_id", accountId)
    .eq("status", "processed")
    .not("flow_run_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(bounded);
  if (error) throw error;
  const rows = ((data ?? []) as Array<{
    id: string;
    flow_run_id: string | null;
    meta_lead_id: string;
  }>);
  let enqueued = 0;
  let alreadyQueued = 0;
  for (let i = 0; i < rows.length; i += META_SHEETS_BATCH_SIZE) {
    const batch = rows.slice(i, i + META_SHEETS_BATCH_SIZE);
    for (const row of batch) {
      const { error: insertErr } = await db
        .from("meta_lead_sheets_queue")
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
    .from("meta_lead_sheets_configs")
    .update({
      historical_import_status: "done",
      historical_imported_count: enqueued + alreadyQueued,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId);
  return { enqueued, alreadyQueued, total: rows.length };
}

export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
  skippedDisabled: number;
  needsReauth: number;
}

interface ConfigRow {
  account_id: string;
  spreadsheet_id: string;
  sheet_tab: string;
  auto_sync: boolean;
}

async function loadConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<ConfigRow | null> {
  const { data, error } = await db
    .from("meta_lead_sheets_configs")
    .select("account_id, spreadsheet_id, sheet_tab, auto_sync")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as ConfigRow | null) ?? null;
}

/** Load everything needed to render one sheet row. */
async function buildRowValues(
  db: SupabaseClient,
  accountId: string,
  submission: SubmissionRow,
): Promise<string[]> {
  let fields: Array<{ id: string; name: string }> = [];
  let values: Array<{ field_id: string; value_text: string | null }> = [];
  let roster: Array<{ user_id: string; full_name: string | null }> = [];
  if (submission.flow_run_id) {
    const { data: run } = await db
      .from("flow_runs")
      .select("flow_id")
      .eq("id", submission.flow_run_id)
      .eq("account_id", accountId)
      .maybeSingle();
    const flowId = (run as { flow_id: string } | null)?.flow_id;
    if (flowId) {
      const [{ data: fieldRows }, { data: valueRows }] = await Promise.all([
        db
          .from("workspace_fields")
          .select("id, name")
          .eq("account_id", accountId)
          .eq("flow_id", flowId),
        db
          .from("workspace_values")
          .select("field_id, value_text")
          .eq("account_id", accountId)
          .eq("flow_run_id", submission.flow_run_id),
      ]);
      fields = ((fieldRows ?? []) as Array<{ id: string; name: string }>);
      values = ((valueRows ?? []) as Array<{
        field_id: string;
        value_text: string | null;
      }>);
    }
  }
  const { data: profiles } = await db
    .from("profiles")
    .select("user_id, full_name")
    .eq("account_id", accountId);
  roster = ((profiles ?? []) as Array<{ user_id: string; full_name: string | null }>);
  const business = resolveBusinessDisplays({ fields, values, roster });
  return buildSheetsRow({
    metaLeadId: submission.meta_lead_id,
    submittedAt: submission.meta_created_time ?? submission.created_at,
    answers: submission.answers ?? {},
    formName: submission.form_name,
    campaignName: submission.campaign_name,
    adName: submission.ad_name,
    source: sheetsSourceLabel(submission.source),
    assigneeDisplay: business.assigneeDisplay,
    leadType: business.leadType,
    stage: business.stage,
  });
}

async function markRowFailed(
  db: SupabaseClient,
  row: QueueRow,
  message: string,
  retryInMs: number | null,
): Promise<void> {
  const attempt = row.attempts + 1;
  const willRetry = attempt < row.max_attempts && retryInMs !== null;
  await db
    .from("meta_lead_sheets_queue")
    .update({
      status: willRetry ? "failed" : "failed",
      attempts: attempt,
      last_error: message.slice(0, 500),
      next_retry_at:
        willRetry && retryInMs !== null
          ? new Date(Date.now() + retryInMs).toISOString()
          : new Date(Date.now() + sheetsRetryDelayMs(attempt)).toISOString(),
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  // Terminal failures keep next_retry_at far out so the cron stops
  // hammering but the row stays visible for manual retry.
  if (!willRetry) {
    await db
      .from("meta_lead_sheets_queue")
      .update({
        next_retry_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      })
      .eq("id", row.id);
  }
}

/**
 * Drain due queue rows to Google Sheets. Never throws for per-row
 * failures; each outcome is recorded on its row + config.
 *
 * Idempotent: a lead maps to exactly one sheet row via column A
 * (Meta Lead ID). Stored `sheet_row_number` is preferred; on resume
 * (row appended but mapping not saved) we re-scan column A before
 * appending, so retries never duplicate.
 */
export async function drainSheetsQueue(
  db: SupabaseClient,
  opts: {
    limit?: number;
    onlyAccountId?: string;
    force?: boolean;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DrainResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = Math.max(1, Math.min(opts.limit ?? META_SHEETS_SWEEP_LIMIT, 100));
  const result: DrainResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedDisabled: 0,
    needsReauth: 0,
  };
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  // Reclaim stale `sending` rows from crashed workers.
  await db
    .from("meta_lead_sheets_queue")
    .update({ status: "queued", claimed_at: null, updated_at: nowIso })
    .eq("status", "sending")
    .lte("updated_at", staleIso);

  let query = db
    .from("meta_lead_sheets_queue")
    .select(
      "id, account_id, submission_id, flow_run_id, meta_lead_id, status, attempts, max_attempts, sheet_row_number",
    )
    .in("status", ["queued", "failed"])
    .lte("next_retry_at", nowIso)
    .order("next_retry_at", { ascending: true })
    .limit(limit);
  if (opts.onlyAccountId) query = query.eq("account_id", opts.onlyAccountId);
  const { data: due, error } = await query;
  if (error) {
    console.error("[meta-sheets] due-jobs scan failed:", error.message);
    return result;
  }
  const rows = ((due ?? []) as QueueRow[]);
  const ensuredHeaders = new Set<string>();

  for (const row of rows) {
    result.attempted += 1;
    // Claim.
    const { data: claimed } = await db
      .from("meta_lead_sheets_queue")
      .update({ status: "sending", claimed_at: nowIso, updated_at: nowIso })
      .eq("id", row.id)
      .in("status", ["queued", "failed"])
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      const config = await loadConfig(db, row.account_id);
      if (!config) {
        await markRowFailed(db, row, "Sheets sync is not configured for this account.", null);
        result.failed += 1;
        continue;
      }
      if (!config.auto_sync && !opts.force) {
        await db
          .from("meta_lead_sheets_queue")
          .update({ status: "queued", claimed_at: null, updated_at: nowIso })
          .eq("id", row.id);
        result.skippedDisabled += 1;
        continue;
      }

      let accessToken: string;
      try {
        accessToken = await getSheetsAccessToken(db, row.account_id, fetchImpl);
      } catch (authErr) {
        const message =
          authErr instanceof SheetsAuthError
            ? "Google authorization expired or was revoked. Reconnect Google Sheets."
            : authErr instanceof Error
              ? authErr.message
              : String(authErr);
        await db
          .from("meta_lead_sheets_queue")
          .update({
            status: "queued",
            attempts: row.attempts + 1,
            last_error: message.slice(0, 500),
            next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            claimed_at: null,
            updated_at: nowIso,
          })
          .eq("id", row.id);
        await db
          .from("meta_lead_sheets_configs")
          .update({ last_error: message.slice(0, 500), updated_at: nowIso })
          .eq("account_id", row.account_id);
        result.needsReauth += 1;
        result.failed += 1;
        continue;
      }

      const submission = await loadSubmission(db, row.account_id, row.submission_id);
      if (!submission) {
        // Submission deleted — drop the queue row (nothing to sync).
        await db.from("meta_lead_sheets_queue").delete().eq("id", row.id);
        continue;
      }

      await ensureSheetsTab(accessToken, config.spreadsheet_id, config.sheet_tab, fetchImpl);
      const headerKey = `${config.spreadsheet_id}::${config.sheet_tab}`;
      if (!ensuredHeaders.has(headerKey)) {
        await ensureSheetsHeader(accessToken, config.spreadsheet_id, config.sheet_tab, fetchImpl);
        ensuredHeaders.add(headerKey);
      }

      const values = await buildRowValues(db, row.account_id, submission);

      let targetRow = row.sheet_row_number;
      if (!targetRow) {
        const found = await findSheetsRowsByLeadId(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          [submission.meta_lead_id],
          fetchImpl,
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
          fetchImpl,
        );
      } else {
        await appendSheetsRows(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          [values],
          fetchImpl,
        );
        // Resolve the appended row number by re-scanning column A.
        // (Sheets append has no row-number response; a second read is
        // the documented way to learn it.)
        const found = await findSheetsRowsByLeadId(
          accessToken,
          config.spreadsheet_id,
          config.sheet_tab,
          [submission.meta_lead_id],
          fetchImpl,
        );
        targetRow = found.get(submission.meta_lead_id) ?? null;
      }

      await db
        .from("meta_lead_sheets_queue")
        .update({
          status: "sent",
          last_error: null,
          next_retry_at: nowIso,
          claimed_at: null,
          sheet_row_number: targetRow,
          updated_at: nowIso,
        })
        .eq("id", row.id);
      await db
        .from("meta_lead_sheets_configs")
        .update({
          last_success_at: nowIso,
          last_error: null,
          updated_at: nowIso,
        })
        .eq("account_id", row.account_id);
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAuthSheetsError(err)) {
        await db
          .from("meta_lead_sheets_queue")
          .update({
            status: "queued",
            attempts: row.attempts + 1,
            last_error:
              "Google rejected the request (check sharing + reconnect).".slice(0, 500),
            next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            claimed_at: null,
            updated_at: nowIso,
          })
          .eq("id", row.id);
        await db
          .from("meta_lead_sheets_configs")
          .update({ last_error: message.slice(0, 500), updated_at: nowIso })
          .eq("account_id", row.account_id);
        result.needsReauth += 1;
        result.failed += 1;
      } else if (isTransientSheetsError(err) || err instanceof SheetsApiError) {
        const attempt = row.attempts + 1;
        const retryIn = sheetsRetryDelayMs(attempt);
        await markRowFailed(db, { ...row, attempts: row.attempts }, message, retryIn);
        await db
          .from("meta_lead_sheets_configs")
          .update({ last_error: message.slice(0, 500), updated_at: nowIso })
          .eq("account_id", row.account_id);
        result.failed += 1;
      } else {
        await markRowFailed(db, row, message, sheetsRetryDelayMs(row.attempts + 1));
        result.failed += 1;
      }
      console.error(
        `[meta-sheets] job ${row.id} failed (attempt ${row.attempts + 1}): ${message.slice(0, 200)}`,
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
  sheetTab: string | null;
  autoSync: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending: number;
  failed: number;
}

/** Status for the settings UI (tokens never returned). */
export async function getSheetsSyncStatus(
  db: SupabaseClient,
  accountId: string,
): Promise<SheetsSyncStatus> {
  const [{ data: conn }, { data: config }, { data: queued }, { data: failed }] =
    await Promise.all([
      db
        .from("meta_lead_sheets_connections")
        .select("google_email, last_error")
        .eq("account_id", accountId)
        .maybeSingle(),
      db
        .from("meta_lead_sheets_configs")
        .select(
          "spreadsheet_id, spreadsheet_url, sheet_tab, auto_sync, last_success_at, last_error",
        )
        .eq("account_id", accountId)
        .maybeSingle(),
      db
        .from("meta_lead_sheets_queue")
        .select("id", { count: "exact" })
        .eq("account_id", accountId)
        .in("status", ["queued", "sending"]),
      db
        .from("meta_lead_sheets_queue")
        .select("id", { count: "exact" })
        .eq("account_id", accountId)
        .eq("status", "failed"),
    ]);
  const connection = conn as { google_email: string | null; last_error: string | null } | null;
  const cfg = config as {
    spreadsheet_id: string;
    spreadsheet_url: string | null;
    sheet_tab: string;
    auto_sync: boolean;
    last_success_at: string | null;
    last_error: string | null;
  } | null;
  const pendingCount = Array.isArray(queued) ? queued.length : 0;
  const failedCount = Array.isArray(failed) ? failed.length : 0;
  const lastError = cfg?.last_error ?? connection?.last_error ?? null;
  return {
    configured: metaSheetsOAuthConfiguredSafe(),
    connected: !!connection,
    needsReauth:
      !!connection?.last_error ||
      (lastError ?? "").toLowerCase().includes("reconnect"),
    email: connection?.google_email ?? null,
    spreadsheetId: cfg?.spreadsheet_id ?? null,
    spreadsheetUrl: cfg?.spreadsheet_url ?? null,
    sheetTab: cfg?.sheet_tab ?? null,
    autoSync: cfg?.auto_sync ?? false,
    lastSuccessAt: cfg?.last_success_at ?? null,
    lastError,
    pending: pendingCount,
    failed: failedCount,
  };
}

function metaSheetsOAuthConfiguredSafe(): boolean {
  try {
    return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  } catch {
    return false;
  }
}
