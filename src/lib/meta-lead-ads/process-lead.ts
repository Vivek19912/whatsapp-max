// ============================================================
// Meta Lead Ads — lead webhook processing.
//
// Flow: a `leadgen` webhook entry is RECORDED idempotently (one
// `meta_lead_submissions` row keyed by (account_id, meta_lead_id)),
// then PROCESSED asynchronously: fetch the full lead from Graph,
// normalize the dynamic field_data, materialize the form's virtual
// Workspace flow, resolve/attach a contact by phone, and write a
// normal `flow_runs` row (vars = answers). That row IS the lead in
// the Workspace.
//
// Reliability:
//   * Duplicate deliveries are a no-op (unique key + processed check).
//   * Concurrent workers can't double-process (claimed_at claim).
//   * A Graph failure leaves a 'failed' row with bounded-backoff
//     next_retry_at — never silently dropped.
//   * Webhook-success-but-retrieval-failure is exactly the 'failed'
//     path, retried by the cron / manual retry endpoint.
//
// Privacy: raw field_data is stored (it IS the lead) but error
// strings are truncated and never include tokens; no logging of
// phone/email values.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { findExistingContact, isUniqueViolation } from "@/lib/contacts/dedupe";
import { resolveAuditUserId } from "@/lib/api/v1/contacts";
import { isValidE164, sanitizePhoneForMeta } from "@/lib/whatsapp/phone-utils";

import type { MetaLeadAdsConfig } from "./config";
import { isAuthGraphError, MetaLeadAdsError } from "./errors";
import { getLead } from "./graph-client";
import { normalizeLeadFieldData, sourceFromPlatform, inferSourceFromQuestions } from "./normalize";
import { getPageToken, markNeedsReauth } from "./store";
import { ensureVirtualFlow, META_SOURCE_COLUMN_KEY, parseFormQuestions } from "./virtual-flow";

export const MAX_LEAD_ATTEMPTS = 5;
const STALE_CLAIM_MS = 5 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 30 * 60_000;

/** Bounded exponential backoff: 1m, 2m, 4m, 8m, capped at 30m. */
export function nextRetryDelayMs(attempt: number): number {
  const step = Math.max(0, attempt - 1);
  return Math.min(RETRY_BASE_MS * 2 ** step, RETRY_CAP_MS);
}

function sourceLabel(source: "facebook" | "instagram" | "unknown"): string {
  if (source === "facebook") return "Facebook";
  if (source === "instagram") return "Instagram";
  return "Other";
}

function isoOrNow(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/** PII-free, bounded error summary for storage. */
function safeError(err: unknown): string {
  if (err instanceof MetaLeadAdsError) {
    return `${err.code}: ${err.message}`.slice(0, 500);
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

export type RecordOutcome = "received" | "duplicate" | "ignored" | "no_page";

/**
 * Idempotently record an inbound `leadgen` notification. Resolves the
 * tenant from the Page (never trusts a client-supplied account) and
 * refuses to process forms that are not enabled. The Meta lead id is
 * the idempotency key.
 */
export async function recordLeadgenNotification(
  db: SupabaseClient,
  input: { pageId: string; formId: string | null; leadgenId: string },
): Promise<{ outcome: RecordOutcome; submissionId: string | null; accountId: string | null }> {
  // A Page is connected to at most one account (global unique index,
  // migration 120), but resolve defensively: read EVERY match and pick
  // the earliest deterministically. The old `.maybeSingle()` collapsed
  // multiple matches to `null`, which silently DROPPED the lead — never
  // acceptable. Ambiguity is now impossible post-migration, but if it
  // somehow recurs we still route (to the earliest connection) and log.
  const { data: pageRows, error: pageErr } = await db
    .from("meta_lead_pages")
    .select("account_id, created_at")
    .eq("page_id", input.pageId)
    .order("created_at", { ascending: true });
  if (pageErr) throw pageErr;
  const matches = (pageRows ?? []) as Array<{
    account_id: string;
    created_at: string;
  }>;
  if (matches.length === 0) {
    // No account has claimed this Page — there is nowhere to store the
    // lead. Report it (never silent) so an unexpected Page is visible.
    console.warn(
      `[meta-lead-ads] leadgen for unconnected page ${input.pageId} ignored`,
    );
    return { outcome: "no_page", submissionId: null, accountId: null };
  }
  if (matches.length > 1) {
    console.warn(
      `[meta-lead-ads] ambiguous page mapping for ${input.pageId} ` +
        `(${matches.length} connections); routing to earliest`,
    );
  }
  const accountId = matches[0].account_id;

  const { data: form } = await db
    .from("meta_lead_forms")
    .select("*")
    .eq("account_id", accountId)
    .eq("form_id", input.formId ?? "")
    .maybeSingle();
  const formRow = form as
    | { id: string; form_name: string | null; enabled: boolean }
    | null;
  const enabled = formRow?.enabled === true;

  const { error: insertErr } = await db.from("meta_lead_submissions").insert({
    account_id: accountId,
    meta_lead_id: input.leadgenId,
    page_id: input.pageId,
    form_id: input.formId,
    form_name: formRow?.form_name ?? null,
    status: enabled ? "received" : "ignored",
    field_data: [],
    answers: {},
  });

  if (insertErr && !isUniqueViolation(insertErr)) throw insertErr;

  const { data: row } = await db
    .from("meta_lead_submissions")
    .select("id, status")
    .eq("account_id", accountId)
    .eq("meta_lead_id", input.leadgenId)
    .maybeSingle();
  const submission = row as { id: string; status: string } | null;

  if (!enabled) {
    return { outcome: "ignored", submissionId: submission?.id ?? null, accountId };
  }
  if (insertErr && submission?.status === "processed") {
    return { outcome: "duplicate", submissionId: submission.id, accountId };
  }
  return { outcome: "received", submissionId: submission?.id ?? null, accountId };
}

async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  phone: string,
  name: string | null,
  email: string | null,
): Promise<string> {
  const existing = await findExistingContact(db, accountId, phone);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (name && name !== existing.name) patch.name = name;
    const existingEmail = (existing as { email?: string | null }).email;
    if (email && !existingEmail) patch.email = email;
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      await db.from("contacts").update(patch).eq("id", existing.id);
    }
    return existing.id;
  }

  const { data, error } = await db
    .from("contacts")
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
      email: email ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) return raced.id;
    }
    throw error ?? new Error("contact insert failed");
  }
  return (data as { id: string }).id;
}

export type ProcessOutcome = "processed" | "failed" | "ignored" | "skipped";

/**
 * Process one recorded submission. Claims it (so concurrent workers
 * serialize), then performs the Graph fetch + Workspace write. Always
 * leaves a terminal or retryable state — never a silent drop.
 */
export async function processSubmissionById(
  db: SupabaseClient,
  config: MetaLeadAdsConfig,
  submissionId: string,
): Promise<{ outcome: ProcessOutcome }> {
  const staleIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data: claimed } = await db
    .from("meta_lead_submissions")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", submissionId)
    .neq("status", "processed")
    .or(`claimed_at.is.null,claimed_at.lt.${staleIso}`)
    .select("*")
    .maybeSingle();

  const submission = claimed as
    | {
        id: string;
        account_id: string;
        meta_lead_id: string;
        page_id: string | null;
        form_id: string | null;
        form_name: string | null;
        attempts: number;
      }
    | null;
  if (!submission) return { outcome: "skipped" };

  try {
    if (!submission.page_id) throw new Error("submission has no page id");

    const pageToken = await getPageToken(db, submission.account_id, submission.page_id);
    const lead = await getLead(config, pageToken, submission.meta_lead_id);
    const normalized = normalizeLeadFieldData(lead.field_data);

    const { data: form } = await db
      .from("meta_lead_forms")
      .select("*")
      .eq("account_id", submission.account_id)
      .eq("form_id", submission.form_id ?? "")
      .maybeSingle();
    const formRow = form as
      | { id: string; form_id: string; form_name: string | null; questions: unknown; enabled: boolean }
      | null;
    if (!formRow || formRow.enabled !== true) {
      await db
        .from("meta_lead_submissions")
        .update({ status: "ignored", claimed_at: null })
        .eq("id", submissionId);
      return { outcome: "ignored" };
    }

    // Meta usually reports `platform`; when it is absent, fall back to a
    // conservative signal derived from the form's own questions.
    const platformSource = sourceFromPlatform(lead.platform);
    const source =
      platformSource !== "unknown"
        ? platformSource
        : inferSourceFromQuestions(
            parseFormQuestions(formRow.questions).map((q) => q.key ?? q.label ?? ""),
          );

    const ownerUserId = await resolveAuditUserId(db, submission.account_id);
    const flowId = await ensureVirtualFlow(db, {
      accountId: submission.account_id,
      ownerUserId,
      form: {
        id: formRow.id,
        form_id: formRow.form_id,
        form_name: formRow.form_name,
        questions: formRow.questions,
      },
    });

    let contactId: string | null = null;
    const rawPhone = normalized.standard.phone;
    if (rawPhone) {
      const phone = sanitizePhoneForMeta(rawPhone);
      if (isValidE164(phone)) {
        contactId = await findOrCreateContact(
          db,
          submission.account_id,
          ownerUserId,
          phone,
          normalized.standard.name,
          normalized.standard.email,
        );
      }
    }

    const startedAt = isoOrNow(lead.created_time);
    const vars: Record<string, string> = {
      ...normalized.answers,
      [META_SOURCE_COLUMN_KEY]: sourceLabel(source),
    };

    const { data: run, error: runErr } = await db
      .from("flow_runs")
      .insert({
        flow_id: flowId,
        user_id: ownerUserId,
        account_id: submission.account_id,
        contact_id: contactId,
        conversation_id: null,
        status: "completed",
        current_node_key: null,
        vars,
        started_at: startedAt,
        last_advanced_at: startedAt,
        ended_at: startedAt,
        end_reason: "meta_lead_ads",
      })
      .select("id")
      .single();
    if (runErr || !run) throw runErr ?? new Error("flow run insert failed");

    await db
      .from("meta_lead_submissions")
      .update({
        status: "processed",
        attempts: submission.attempts + 1,
        processed_at: new Date().toISOString(),
        flow_run_id: (run as { id: string }).id,
        contact_id: contactId,
        source,
        answers: normalized.answers,
        field_data: lead.field_data ?? [],
        form_name: formRow.form_name ?? submission.form_name,
        last_error: null,
        next_retry_at: null,
        claimed_at: null,
      })
      .eq("id", submissionId);

    return { outcome: "processed" };
  } catch (err) {
    const attempts = submission.attempts + 1;
    const willRetry = attempts < MAX_LEAD_ATTEMPTS;

    if (
      isAuthGraphError(err) ||
      (err instanceof MetaLeadAdsError && err.code === "needs_reauth")
    ) {
      // Token is dead — flag the connection so the UI asks for
      // reauthorization; keep the row retryable.
      await markNeedsReauth(
        db,
        submission.account_id,
        "Meta authorization expired or was revoked.",
      );
    }

    await db
      .from("meta_lead_submissions")
      .update({
        status: "failed",
        attempts,
        last_error: safeError(err),
        next_retry_at: willRetry
          ? new Date(Date.now() + nextRetryDelayMs(attempts)).toISOString()
          : null,
        claimed_at: null,
      })
      .eq("id", submissionId);

    return { outcome: "failed" };
  }
}

/** Retry every failed submission whose backoff window has elapsed. */
export async function runDueRetries(
  db: SupabaseClient,
  config: MetaLeadAdsConfig,
  limit = 10,
  accountId?: string,
): Promise<{ attempted: number; processed: number; failed: number; skipped: number }> {
  let query = db
    .from("meta_lead_submissions")
    .select("id")
    .eq("status", "failed")
    .lte("next_retry_at", new Date().toISOString())
    .is("claimed_at", null)
    .order("next_retry_at", { ascending: true })
    .limit(limit);
  if (accountId) query = query.eq("account_id", accountId);
  const { data } = await query;

  const rows = (data ?? []) as Array<{ id: string }>;
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = await processSubmissionById(db, config, row.id);
    if (result.outcome === "processed") processed++;
    else if (result.outcome === "failed") failed++;
    else skipped++;
  }
  return { attempted: rows.length, processed, failed, skipped };
}
