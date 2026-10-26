// ============================================================
// Meta Lead Ads → Google Sheets — durable manual import jobs.
//
// Meta-only. Nothing here is imported by Flow Tables, All Sheets,
// or the generic Google Sheets feature.
//
// Why this exists: the Import Leads route used to classify,
// enqueue, AND drain up to 2000 leads inside a single HTTP
// request — 60s+ of sequential Google API calls, so the gateway
// timed out (504) with partial completion. Import jobs make that
// durable:
//   * POST creates one job row and enqueues its leads with bulk,
//     DB-local operations (returns in seconds), then runs a
//     single bounded worker pass.
//   * The job persists the exact submission snapshot plus
//     classification totals; pumps process bounded batches and
//     record progress. Status polling is a pure read — it never
//     restarts work.
//   * A partial unique index allows only ONE active job per
//     (account, Meta form); concurrent starters get the existing
//     job (409) and concurrent workers serialize on the row's
//     claimed_at claim (optimistic, stale after 5 minutes).
//   * Matching stays Meta-Lead-ID based in the drain: re-pumps
//     update existing sheet rows in place, never duplicate —
//     resuming after a timeout only completes the remainder.
//   * Quota/backoff behavior is inherited from the drain: quota
//     trips park rows without burning attempts, terminal failures
//     carry a final error, and manual revive clears the budget.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isUniqueViolation } from "@/lib/contacts/dedupe";

import {
  drainSheetsQueue,
  enqueueImportCandidates,
  planImportScope,
  type TableImportRange,
} from "./queue";

export const IMPORT_JOB_STALE_CLAIM_MS = 5 * 60_000;
export const IMPORT_JOB_MAX_AGE_MS = 24 * 60 * 60_000;
export const IMPORT_JOB_MAX_ERRORS = 5;
/** Queue rows drained per worker pass (bounded Google work). */
export const IMPORT_JOB_ROW_BUDGET = 25;
/** Active jobs pumped per cron sweep. */
export const IMPORT_JOB_SWEEP_LIMIT = 2;

export type ImportJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ImportJobRow {
  id: string;
  account_id: string;
  form_id: string;
  flow_id: string | null;
  mode: "all" | "range";
  range_from: string | null;
  range_to: string | null;
  status: ImportJobStatus;
  total: number;
  skipped: number;
  inserted_total: number;
  updated_total: number;
  sent_total: number;
  failed_total: number;
  truncated: boolean;
  submission_ids: string[];
  mapped_ids: string[];
  consecutive_errors: number;
  last_error: string | null;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportJobProgress {
  job: ImportJobRow;
  /** Leads fully written (sent). */
  sent: number;
  /** Leads terminally failed (budget spent or permanent error). */
  failed: number;
  /** Leads failed but scheduled for automatic retry. */
  retrying: number;
  /** Leads still queued/sending. */
  pending: number;
  /** Processed = sent + terminally failed. */
  processed: number;
  done: boolean;
}

/** Another import is already active for this table. */
export class ActiveImportJobError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super("An import is already running for this table.");
    this.name = "ActiveImportJobError";
    this.jobId = jobId;
  }
}

function toJobRow(raw: Record<string, unknown>): ImportJobRow {
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const status = strOrNull(raw.status);
  return {
    id: String(raw.id ?? ""),
    account_id: String(raw.account_id ?? ""),
    form_id: String(raw.form_id ?? ""),
    flow_id: strOrNull(raw.flow_id),
    mode: raw.mode === "range" ? "range" : "all",
    range_from: strOrNull(raw.range_from),
    range_to: strOrNull(raw.range_to),
    status:
      status === "queued" ||
      status === "running" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
        ? status
        : "queued",
    total: num(raw.total),
    skipped: num(raw.skipped),
    inserted_total: num(raw.inserted_total),
    updated_total: num(raw.updated_total),
    sent_total: num(raw.sent_total),
    failed_total: num(raw.failed_total),
    truncated: raw.truncated === true,
    submission_ids: strArray(raw.submission_ids),
    mapped_ids: strArray(raw.mapped_ids),
    consecutive_errors: num(raw.consecutive_errors),
    last_error: strOrNull(raw.last_error),
    created_by: strOrNull(raw.created_by),
    started_at: strOrNull(raw.started_at),
    finished_at: strOrNull(raw.finished_at),
    claimed_at: strOrNull(raw.claimed_at),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  };
}

/** Active (queued/running) job for this table, if any. */
export async function findActiveImportJob(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<ImportJobRow | null> {
  const { data, error } = await db
    .from("meta_lead_sheets_import_jobs")
    .select("*")
    .eq("account_id", accountId)
    .eq("form_id", formId)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toJobRow(data as Record<string, unknown>) : null;
}

/**
 * Start an import job: classify (bulk, DB-local), persist the
 * snapshot, enqueue idempotently, and return promptly. Throws
 * ActiveImportJobError when this table already has an active job
 * (the partial unique index is the backstop for races).
 */
export async function createImportJob(
  db: SupabaseClient,
  args: {
    accountId: string;
    formId: string;
    flowId: string | null;
    mode: "all" | "range";
    range: TableImportRange | null;
    createdBy: string | null;
  },
): Promise<ImportJobRow> {
  const existing = await findActiveImportJob(db, args.accountId, args.formId);
  if (existing) throw new ActiveImportJobError(existing.id);

  const scope = await planImportScope(
    db,
    args.accountId,
    args.formId,
    args.range,
  );
  await enqueueImportCandidates(
    db,
    args.accountId,
    scope.candidates,
  );

  const { data, error } = await db
    .from("meta_lead_sheets_import_jobs")
    .insert({
      account_id: args.accountId,
      form_id: args.formId,
      flow_id: args.flowId,
      mode: args.mode,
      range_from: args.range?.from ?? null,
      range_to: args.range?.to ?? null,
      status: "queued",
      total: scope.total,
      skipped: scope.skipped,
      inserted_total: scope.imported,
      updated_total: scope.updated,
      truncated: scope.truncated,
      submission_ids: scope.candidates.map((c) => c.id),
      mapped_ids: scope.mappedIds,
      created_by: args.createdBy,
    })
    .select("*")
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findActiveImportJob(db, args.accountId, args.formId);
      throw new ActiveImportJobError(raced?.id ?? "");
    }
    throw error;
  }
  if (!data) throw new Error("Import job insert failed.");
  return toJobRow(data as Record<string, unknown>);
}

/** Live progress for one job's snapshot (pure read, no side effects). */
export async function getImportJobProgress(
  db: SupabaseClient,
  job: ImportJobRow,
): Promise<ImportJobProgress> {
  let sent = 0;
  let failed = 0;
  let retrying = 0;
  let pending = 0;
  if (job.submission_ids.length > 0) {
    const { data, error } = await db
      .from("meta_lead_sheets_queue")
      .select("submission_id, status, attempts, max_attempts")
      .eq("account_id", job.account_id)
      .in("submission_id", job.submission_ids);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{
      submission_id: string;
      status: string;
      attempts: number | null;
      max_attempts: number | null;
    }>) {
      if (r.status === "sent") sent += 1;
      else if (r.status === "failed") {
        if ((r.attempts ?? 0) < (r.max_attempts ?? 8)) retrying += 1;
        else failed += 1;
      } else pending += 1;
    }
    // Snapshot rows with no queue row yet (enqueue raced or was
    // cleaned) count as pending.
    const seen = new Set(
      ((data ?? []) as Array<{ submission_id: string }>).map(
        (r) => r.submission_id,
      ),
    );
    for (const id of job.submission_ids) {
      if (!seen.has(id)) pending += 1;
    }
  }
  const done =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    // No work left: nothing queued/sending and nothing scheduled
    // for retry. Empty scopes complete on the first pump.
    (pending === 0 && retrying === 0);
  return { job, sent, failed, retrying, pending, processed: sent + failed, done };
}

async function loadJobById(
  db: SupabaseClient,
  jobId: string,
): Promise<ImportJobRow | null> {
  const { data, error } = await db
    .from("meta_lead_sheets_import_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data ? toJobRow(data as Record<string, unknown>) : null;
}

/**
 * Load one job scoped to an account + table form (tenant + table
 * isolation for the nested job routes). Null when missing,
 * foreign, or belonging to another table.
 */
export async function getTableImportJob(
  db: SupabaseClient,
  args: { accountId: string; formId: string; jobId: string },
): Promise<ImportJobRow | null> {
  const { data, error } = await db
    .from("meta_lead_sheets_import_jobs")
    .select("*")
    .eq("id", args.jobId)
    .eq("account_id", args.accountId)
    .eq("form_id", args.formId)
    .maybeSingle();
  if (error) throw error;
  return data ? toJobRow(data as Record<string, unknown>) : null;
}

/**
 * Run one bounded worker pass for a job: claim atomically
 * (stale claims are reclaimable), drain a bounded number of
 * queue rows, refresh progress, and release or complete the job.
 * Safe to call concurrently — only the claim holder works.
 * Never throws for row-level failures; worker-level crashes leave
 * the claim stale for the next pump instead of losing work.
 */
export async function pumpImportJob(
  db: SupabaseClient,
  jobId: string,
  opts: { rowBudget?: number } = {},
): Promise<{ claimed: boolean; progress: ImportJobProgress | null }> {
  const rowBudget = Math.max(1, Math.min(opts.rowBudget ?? IMPORT_JOB_ROW_BUDGET, 100));
  const nowIso = new Date().toISOString();

  const job = await loadJobById(db, jobId);
  if (!job) return { claimed: false, progress: null };
  if (job.status !== "queued" && job.status !== "running") {
    return {
      claimed: false,
      progress: await getImportJobProgress(db, job),
    };
  }
  if (
    job.claimed_at &&
    Date.parse(job.claimed_at) > Date.now() - IMPORT_JOB_STALE_CLAIM_MS
  ) {
    // Another worker holds this job; polling must never restart it.
    return { claimed: false, progress: await getImportJobProgress(db, job) };
  }
  if (job.started_at && Date.parse(job.started_at) < Date.now() - IMPORT_JOB_MAX_AGE_MS) {
    await db
      .from("meta_lead_sheets_import_jobs")
      .update({
        status: "failed",
        last_error: "Import did not finish within 24 hours; start a new import to continue.",
        finished_at: nowIso,
        claimed_at: null,
        updated_at: nowIso,
      })
      .eq("id", jobId);
    const expired = await loadJobById(db, jobId);
    return {
      claimed: true,
      progress: expired ? await getImportJobProgress(db, expired) : null,
    };
  }

  // Optimistic claim: only wins when nobody else claimed first
  // (claimed_at unchanged since our read).
  const { data: claimedRows } = await db
    .from("meta_lead_sheets_import_jobs")
    .update({
      status: "running",
      started_at: job.started_at ?? nowIso,
      claimed_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", jobId)
    .eq("claimed_at", job.claimed_at)
    .select("id");
  if (!claimedRows || (claimedRows as unknown[]).length === 0) {
    return { claimed: false, progress: await getImportJobProgress(db, job) };
  }

  try {
    await drainSheetsQueue(db, {
      onlyAccountId: job.account_id,
      onlyFormId: job.form_id,
      force: true,
      limit: rowBudget,
    });
    const current = (await loadJobById(db, jobId)) ?? job;
    const progress = await getImportJobProgress(db, current);
    const complete = progress.pending === 0 && progress.retrying === 0;
    await db
      .from("meta_lead_sheets_import_jobs")
      .update({
        status: complete ? "completed" : "running",
        sent_total: progress.sent,
        failed_total: progress.failed,
        consecutive_errors: 0,
        last_error: null,
        finished_at: complete ? nowIso : null,
        claimed_at: null,
        updated_at: nowIso,
      })
      .eq("id", jobId);
    const final = (await loadJobById(db, jobId)) ?? current;
    return { claimed: true, progress: await getImportJobProgress(db, final) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errors = job.consecutive_errors + 1;
    const exhausted = errors >= IMPORT_JOB_MAX_ERRORS;
    await db
      .from("meta_lead_sheets_import_jobs")
      .update({
        status: exhausted ? "failed" : "running",
        consecutive_errors: errors,
        last_error: exhausted
          ? `${message.slice(0, 400)} (worker failed ${errors} times; fix the cause and resume)`
          : message.slice(0, 500),
        finished_at: exhausted ? nowIso : null,
        claimed_at: null,
        updated_at: nowIso,
      })
      .eq("id", jobId);
    const final = (await loadJobById(db, jobId)) ?? job;
    return { claimed: true, progress: await getImportJobProgress(db, final) };
  }
}

/**
 * Pump every active import job with bounded work each. Called by
 * the existing 5-minute cron (same sweep, no new scheduler) so
 * imports complete in the background after POST returns. One
 * broken job never stalls the others.
 */
export async function pumpActiveImportJobs(
  db: SupabaseClient,
  opts: { maxJobs?: number; rowBudget?: number } = {},
): Promise<{ jobs: number; pumped: number }> {
  const maxJobs = Math.max(1, Math.min(opts.maxJobs ?? IMPORT_JOB_SWEEP_LIMIT, 10));
  const { data, error } = await db
    .from("meta_lead_sheets_import_jobs")
    .select("id")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(maxJobs);
  if (error) {
    console.error("[meta-sheets] import-job sweep failed:", error.message);
    return { jobs: 0, pumped: 0 };
  }
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  let pumped = 0;
  for (const id of ids) {
    try {
      const { claimed } = await pumpImportJob(db, id, {
        rowBudget: opts.rowBudget,
      });
      if (claimed) pumped += 1;
    } catch (err) {
      console.error(
        `[meta-sheets] import job ${id} pump failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { jobs: ids.length, pumped };
}

/**
 * Revive one job's failed rows (fresh attempt budget, due
 * immediately) and reopen the job so the next pump processes
 * them. Scoped to the job's own snapshot — sent rows are never
 * touched, so synced spreadsheet rows cannot duplicate. Returns
 * the number of revived rows.
 */
export async function reviveImportJobFailures(
  db: SupabaseClient,
  job: ImportJobRow,
): Promise<{ revived: number }> {
  if (job.submission_ids.length === 0) return { revived: 0 };
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("meta_lead_sheets_queue")
    .update({
      status: "queued",
      attempts: 0,
      last_error: null,
      next_retry_at: nowIso,
      claimed_at: null,
      updated_at: nowIso,
    })
    .eq("account_id", job.account_id)
    .in("submission_id", job.submission_ids)
    .eq("status", "failed")
    .select("id");
  if (error) throw error;
  const revived = ((data ?? []) as unknown[]).length;
  if (revived > 0) {
    await db
      .from("meta_lead_sheets_import_jobs")
      .update({
        status: "running",
        finished_at: null,
        last_error: null,
        claimed_at: null,
        updated_at: nowIso,
      })
      .eq("id", job.id);
  }
  return { revived };
}

/**
 * Serialize a job + its live progress for API responses and the
 * dialog. Field names are stable: totals describe the frozen
 * classification snapshot, sent/failed/retrying/pending describe
 * live queue state, processed = sent + terminally failed.
 */
export function serializeImportJob(progress: ImportJobProgress): {
  id: string;
  status: ImportJobStatus;
  mode: "all" | "range";
  range_from: string | null;
  range_to: string | null;
  total: number;
  processed: number;
  sent: number;
  failed: number;
  retrying: number;
  pending: number;
  inserted: number;
  updated: number;
  skipped: number;
  truncated: boolean;
  done: boolean;
  finished_at: string | null;
  last_error: string | null;
} {
  const { job, sent, failed, retrying, pending, processed, done } = progress;
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    range_from: job.range_from,
    range_to: job.range_to,
    total: job.total,
    processed,
    sent,
    failed,
    retrying,
    pending,
    inserted: job.inserted_total,
    updated: job.updated_total,
    skipped: job.skipped,
    truncated: job.truncated,
    done,
    finished_at: job.finished_at,
    last_error: job.last_error,
  };
}

/** Cancel a queued/running job. Terminal jobs are left untouched. */
export async function cancelImportJob(
  db: SupabaseClient,
  job: ImportJobRow,
): Promise<ImportJobRow | null> {
  if (job.status !== "queued" && job.status !== "running") return job;
  const nowIso = new Date().toISOString();
  await db
    .from("meta_lead_sheets_import_jobs")
    .update({ status: "cancelled", finished_at: nowIso, claimed_at: null, updated_at: nowIso })
    .eq("id", job.id);
  return loadJobById(db, job.id);
}
