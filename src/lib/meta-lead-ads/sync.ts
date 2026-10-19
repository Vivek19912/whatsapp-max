// ============================================================
// Meta Lead Ads — historical import + continuous polling.
//
// Two ways leads arrive without the OAuth flow:
//
//   1. Historical import — when a form is enabled (or "Import
//      existing leads" is clicked) we page through Meta's stored
//      leads for that form and feed each one through the SAME
//      idempotent pipeline as the webhook.
//   2. Polling fallback — the cron sweeps enabled forms and picks
//      up new leads. This keeps working when the `leadgen` webhook
//      cannot be subscribed (e.g. the token lacks
//      `pages_manage_metadata`), so lead capture never depends on a
//      single delivery mechanism.
//
// Both paths are bounded per invocation: the cron/route returns
// quickly and the import cursor is persisted, so the next sweep
// resumes exactly where this one stopped. Duplicate leads are always
// a no-op thanks to `meta_lead_submissions`' unique key.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MetaLeadAdsConfig } from "./config";
import { MetaLeadAdsError } from "./errors";
import { listFormLeads } from "./graph-client";
import { processSubmissionById, recordLeadgenNotification } from "./process-lead";
import { getPageToken } from "./store";

export const IMPORT_PAGE_SIZE = 50;
export const IMPORT_MAX_PAGES_PER_RUN = 4;
export const POLL_PAGE_SIZE = 25;
/** Newest-first pages walked per poll so a burst larger than one page
 *  is not silently missed. */
export const POLL_MAX_PAGES = 5;

export interface SyncFormRow {
  id: string;
  account_id: string;
  page_id: string;
  form_id: string;
  form_name: string | null;
  enabled: boolean;
  import_status: "idle" | "importing" | "done" | "error" | string;
  import_cursor: string | null;
  imported_count: number;
  last_lead_at: string | null;
  last_polled_at: string | null;
}

export interface ImportResult {
  imported: number;
  processed: number;
  failed: number;
  hasMore: boolean;
  error: string | null;
}

function safeError(err: unknown): string {
  const text =
    err instanceof MetaLeadAdsError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return text.slice(0, 500);
}

function newestIso(
  current: string | null,
  createdTime: string | undefined,
): string | null {
  if (!createdTime) return current;
  const next = Date.parse(createdTime);
  if (Number.isNaN(next)) return current;
  const currentMs = current ? Date.parse(current) : Number.NaN;
  if (Number.isNaN(currentMs) || next > currentMs) {
    return new Date(next).toISOString();
  }
  return current;
}

interface IngestResult {
  recorded: boolean;
  processed: boolean;
  failed: boolean;
}

/** Record + process one Meta lead through the shared pipeline. */
async function ingestLead(
  db: SupabaseClient,
  config: MetaLeadAdsConfig,
  args: { pageId: string; formId: string; leadId: string },
): Promise<IngestResult> {
  const rec = await recordLeadgenNotification(db, {
    pageId: args.pageId,
    formId: args.formId,
    leadgenId: args.leadId,
  });
  if (rec.outcome === "no_page" || rec.outcome === "ignored") {
    return { recorded: rec.inserted, processed: false, failed: false };
  }
  if (rec.outcome === "duplicate" || !rec.submissionId) {
    return { recorded: rec.inserted, processed: false, failed: false };
  }
  const out = await processSubmissionById(db, config, rec.submissionId);
  return {
    recorded: rec.inserted,
    processed: out.outcome === "processed",
    failed: out.outcome === "failed",
  };
}

const FORM_COLUMNS =
  "id, account_id, page_id, form_id, form_name, enabled, import_status, import_cursor, imported_count, last_lead_at, last_polled_at";

async function loadForm(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<SyncFormRow | null> {
  const { data, error } = await db
    .from("meta_lead_forms")
    .select(FORM_COLUMNS)
    .eq("account_id", accountId)
    .eq("form_id", formId)
    .maybeSingle();
  if (error) throw error;
  return (data as SyncFormRow | null) ?? null;
}

/**
 * Import the leads Meta already holds for one form. Bounded by
 * `maxPages`; the cursor is persisted after every page so a later
 * sweep continues where this one stopped.
 */
export async function importFormLeads(
  db: SupabaseClient,
  config: MetaLeadAdsConfig,
  args: {
    accountId: string;
    form: SyncFormRow;
    maxPages?: number;
    pageSize?: number;
  },
): Promise<ImportResult> {
  const maxPages = Math.max(1, args.maxPages ?? IMPORT_MAX_PAGES_PER_RUN);
  const pageSize = Math.max(1, args.pageSize ?? IMPORT_PAGE_SIZE);

  let cursor = args.form.import_cursor;
  let imported = 0;
  let processed = 0;
  let failed = 0;

  if (args.form.enabled !== true) {
    return { imported, processed, failed, hasMore: false, error: null };
  }

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const pageToken = await getPageToken(
        db,
        args.accountId,
        args.form.page_id,
      );
      const result = await listFormLeads(config, pageToken, args.form.form_id, {
        limit: pageSize,
        after: cursor,
      });

      for (const lead of result.leads) {
        const outcome = await ingestLead(db, config, {
          pageId: args.form.page_id,
          formId: args.form.form_id,
          leadId: lead.id,
        });
        if (outcome.recorded) imported += 1;
        if (outcome.processed) processed += 1;
        if (outcome.failed) failed += 1;
      }

      cursor = result.nextCursor;
      await db
        .from("meta_lead_forms")
        .update({
          import_cursor: cursor,
          import_status: cursor ? "importing" : "done",
          imported_count: args.form.imported_count + imported,
          last_polled_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", args.form.id)
        .eq("account_id", args.accountId);

      if (!cursor) {
        return { imported, processed, failed, hasMore: false, error: null };
      }
    }
  } catch (err) {
    const error = safeError(err);
    await db
      .from("meta_lead_forms")
      .update({
        import_status: "error",
        last_error: error,
        last_polled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.form.id)
      .eq("account_id", args.accountId);
    return { imported, processed, failed, hasMore: true, error };
  }

  return { imported, processed, failed, hasMore: true, error: null };
}

export interface PollFormResult {
  received: number;
  processed: number;
  failed: number;
  error: string | null;
}

/** Poll one enabled form for new leads (bounded). */
export async function pollFormLeads(
  db: SupabaseClient,
  config: MetaLeadAdsConfig,
  form: SyncFormRow,
): Promise<PollFormResult> {
  let received = 0;
  let processed = 0;
  let failed = 0;
  let newest = form.last_lead_at;

  try {
    const pageToken = await getPageToken(db, form.account_id, form.page_id);
    let cursor: string | null = null;

    // Meta returns leads newest-first. Walk pages until a page adds no
    // NEW leads (we have caught up to what we already stored) or the
    // bounded page budget runs out, so a burst > POLL_PAGE_SIZE between
    // sweeps cannot be missed.
    for (let page = 0; page < POLL_MAX_PAGES; page += 1) {
      const result = await listFormLeads(config, pageToken, form.form_id, {
        limit: POLL_PAGE_SIZE,
        after: cursor,
      });
      if (result.leads.length === 0) break;

      let newOnPage = 0;
      for (const lead of result.leads) {
        newest = newestIso(newest, lead.created_time);
        const outcome = await ingestLead(db, config, {
          pageId: form.page_id,
          formId: form.form_id,
          leadId: lead.id,
        });
        if (outcome.recorded) {
          received += 1;
          newOnPage += 1;
        }
        if (outcome.processed) processed += 1;
        if (outcome.failed) failed += 1;
      }

      cursor = result.nextCursor;
      if (!cursor || newOnPage === 0) break;
    }

    const now = new Date().toISOString();
    await db
      .from("meta_lead_forms")
      .update({
        last_polled_at: now,
        last_lead_at: newest,
        last_error: null,
        updated_at: now,
      })
      .eq("id", form.id)
      .eq("account_id", form.account_id);
    await db
      .from("meta_lead_pages")
      .update({ last_polled_at: now, updated_at: now })
      .eq("account_id", form.account_id)
      .eq("page_id", form.page_id);

    return { received, processed, failed, error: null };
  } catch (err) {
    const error = safeError(err);
    await db
      .from("meta_lead_forms")
      .update({
        last_polled_at: new Date().toISOString(),
        last_error: error,
        updated_at: new Date().toISOString(),
      })
      .eq("id", form.id)
      .eq("account_id", form.account_id);
    return { received, processed, failed, error };
  }
}

/**
 * Sweep enabled forms: resume an interrupted historical import first,
 * then poll for new leads. Bounded so the cron invocation stays fast.
 */
export async function runLeadPolls(
  db: SupabaseClient,
  config: MetaLeadAdsConfig,
  limit = 10,
): Promise<{
  forms: number;
  imported: number;
  received: number;
  processed: number;
  failed: number;
  errors: number;
}> {
  const { data, error } = await db
    .from("meta_lead_forms")
    .select(FORM_COLUMNS)
    .eq("enabled", true)
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;

  const forms = (data ?? []) as SyncFormRow[];
  let imported = 0;
  let received = 0;
  let processed = 0;
  let failed = 0;
  let errors = 0;

  for (const form of forms) {
    try {
      if (form.import_status === "importing" || form.import_status === "idle") {
        const result = await importFormLeads(db, config, {
          accountId: form.account_id,
          form: { ...form, import_status: "importing" },
          maxPages: 1,
        });
        imported += result.imported;
        processed += result.processed;
        failed += result.failed;
        if (result.error) errors += 1;
        // Finish the current import batch before polling, otherwise a
        // large form would starve the new-lead path.
        if (result.hasMore) continue;
      }

      const poll = await pollFormLeads(db, config, form);
      received += poll.received;
      processed += poll.processed;
      failed += poll.failed;
      if (poll.error) errors += 1;
    } catch (err) {
      errors += 1;
      console.error(
        "[meta-lead-ads] sync failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { forms: forms.length, imported, received, processed, failed, errors };
}

/** Load one form for an explicit "Import existing leads" action. */
export async function getFormForImport(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<SyncFormRow | null> {
  return loadForm(db, accountId, formId);
}
