// ============================================================
// Meta CRM feedback — config, durable event outbox, and drain
// (Feature: Instant Form lead-quality → Meta Conversions API).
//
// Flow:
//   * "Lead Quality" cell saved -> stores the status ONLY (the
//     workspace-values save path deliberately contains no CRM
//     hook; selecting, clearing, or re-saving never sends).
//   * Explicit Send to Meta (POST .../manual-send, after the user
//     reviews the backend-generated preview from GET .../preview)
//     -> enqueue the mapped event for the CURRENT stored status.
//   * Drain (cron sweep + prompt post-response trigger) sends
//     pending rows server-side with the account's stored Meta
//     connection token. Tokens are never persisted here, never
//     logged, never returned.
//
// This is a NEW, independent integration. It does NOT inspect,
// reuse, or depend on the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.
//
// Deduplication: UNIQUE(account_id, flow_run_id, event_name,
// from_quality, to_quality) — re-saving an unchanged value can
// never create a second event; races collapse to the existing row.
// Retries reuse the row's event_uuid as Meta `event_id`, so Meta
// never sees a duplicate conversion.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getUserToken } from "@/lib/meta-lead-ads/store";

import { isUniqueViolation } from "./store";
import { MetaCrmError, verifyDatasetOwnership } from "./datasets";
import {
  buildCrmEventPayload,
  leadQualityToEvent,
  sendCrmEvent,
  type CrmEventName,
} from "./lead-quality";
import { resolveLeadMatchHashes } from "./matching";

// ---------- config ---------------------------------------------

export interface CrmFeedbackConfig {
  account_id: string;
  dataset_ref: string | null;
  dataset_id: string | null;
  business_portfolio_id: string | null;
  dataset_name: string | null;
  enabled: boolean;
  verified_at: string | null;
  last_error: string | null;
  last_event_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicCrmFeedbackConfig {
  enabled: boolean;
  datasetId: string | null;
  businessPortfolioId: string | null;
  datasetName: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
}

export function toPublicCrmFeedbackConfig(row: CrmFeedbackConfig | null): PublicCrmFeedbackConfig {
  return {
    enabled: row?.enabled ?? false,
    datasetId: row?.dataset_id ?? null,
    businessPortfolioId: row?.business_portfolio_id ?? null,
    datasetName: row?.dataset_name ?? null,
    verifiedAt: row?.verified_at ?? null,
    lastError: row?.last_error ?? null,
    lastEventAt: row?.last_event_at ?? null,
  };
}

export async function getCrmFeedbackConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<CrmFeedbackConfig | null> {
  const { data, error } = await db
    .from("meta_crm_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as CrmFeedbackConfig | null) ?? null;
}

/**
 * Save the per-account feedback config. Enabling requires a
 * dataset that belongs to this account AND passes Meta
 * verification with the account's stored token (fail closed).
 * Disabling (or clearing the dataset) never needs verification.
 */
export async function saveCrmFeedbackConfig(
  db: SupabaseClient,
  args: {
    accountId: string;
    enabled: boolean;
    datasetRowId: string | null;
    actorUserId: string;
    fetchImpl?: typeof fetch;
  },
): Promise<{ config: CrmFeedbackConfig; ownershipVerified: boolean }> {
  const { data: datasets, error: dsErr } = await db
    .from("meta_crm_datasets")
    .select("id, dataset_id, business_portfolio_id, dataset_name")
    .eq("account_id", args.accountId);
  if (dsErr) throw dsErr;
  const rows = (datasets ?? []) as Array<{
    id: string;
    dataset_id: string;
    business_portfolio_id: string;
    dataset_name: string;
  }>;

  if (!args.enabled) {
    const { data, error } = await db
      .from("meta_crm_config")
      .upsert(
        {
          account_id: args.accountId,
          dataset_ref: null,
          dataset_id: null,
          business_portfolio_id: null,
          dataset_name: null,
          enabled: false,
          verified_at: null,
          last_error: null,
          updated_by: args.actorUserId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      )
      .select("*")
      .single();
    if (error || !data) throw error ?? new Error("Failed to save CRM feedback config.");
    return { config: data as CrmFeedbackConfig, ownershipVerified: false };
  }

  const chosen = rows.find((r) => r.id === args.datasetRowId);
  if (!chosen) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Select a CRM dataset from this workspace first.",
      status: 400,
    });
  }

  // Verify with the account's stored credential (never a pasted
  // token here): the dataset must be readable, the business must
  // be accessible, and the listing must show the dataset under
  // that business. Every uncertainty surfaces its own precise
  // error (expired token, missing permission, bad portfolio id,
  // outage) — never the generic ownership message.
  let token: string;
  try {
    token = await getUserToken(db, args.accountId);
  } catch {
    throw new MetaCrmError({
      code: "auth_failed",
      message: "No authorized Meta connection for this workspace. Connect Meta Lead Ads first.",
      status: 409,
    });
  }
  let ownership: { verified: true } | { verified: false; reason: string };
  try {
    ownership = await verifyDatasetOwnership({
      businessPortfolioId: chosen.business_portfolio_id,
      datasetId: chosen.dataset_id,
      accessToken: token,
      fetchImpl: args.fetchImpl ?? fetch,
    });
  } catch (err) {
    // Precise failure (auth / permission / bad id / outage):
    // record it verbatim and stay disabled. Fail closed, but loud.
    const message =
      err instanceof MetaCrmError
        ? err.message
        : "Could not verify dataset ownership with Meta. Try again.";
    const { error: saveErr } = await db
      .from("meta_crm_config")
      .upsert(
        {
          account_id: args.accountId,
          dataset_ref: chosen.id,
          dataset_id: chosen.dataset_id,
          business_portfolio_id: chosen.business_portfolio_id,
          dataset_name: chosen.dataset_name,
          enabled: false,
          verified_at: null,
          last_error: message.slice(0, 500),
          updated_by: args.actorUserId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      );
    if (saveErr) throw saveErr;
    throw err;
  }
  if (!ownership.verified) {
    const { error } = await db
      .from("meta_crm_config")
      .upsert(
        {
          account_id: args.accountId,
          dataset_ref: chosen.id,
          dataset_id: chosen.dataset_id,
          business_portfolio_id: chosen.business_portfolio_id,
          dataset_name: chosen.dataset_name,
          enabled: false,
          verified_at: null,
          last_error: ownership.reason.slice(0, 500),
          updated_by: args.actorUserId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      );
    if (error) throw error;
    throw new MetaCrmError({
      code: "forbidden",
      message: ownership.reason,
      status: 403,
    });
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("meta_crm_config")
    .upsert(
      {
        account_id: args.accountId,
        dataset_ref: chosen.id,
        dataset_id: chosen.dataset_id,
        business_portfolio_id: chosen.business_portfolio_id,
        dataset_name: chosen.dataset_name,
        enabled: true,
        verified_at: now,
        last_error: null,
        updated_by: args.actorUserId,
        updated_at: now,
      },
      { onConflict: "account_id" },
    )
    .select("*")
    .single();
  if (error || !data) throw error ?? new Error("Failed to save CRM feedback config.");
  return { config: data as CrmFeedbackConfig, ownershipVerified: true };
}

// ---------- events ----------------------------------------------

export type CrmEventStatus = "pending" | "sent" | "failed" | "skipped";

export interface CrmEventRow {
  id: string;
  account_id: string;
  flow_id: string | null;
  flow_run_id: string | null;
  submission_id: string | null;
  meta_lead_id: string;
  event_name: string;
  from_quality: string;
  to_quality: string;
  event_time: string;
  event_uuid: string;
  dataset_id: string;
  status: CrmEventStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  meta_response: unknown;
  next_retry_at: string;
  sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueLeadQualityEventArgs {
  accountId: string;
  flowId: string | null;
  runId: string;
  /** Stored display values ("" = implicit initial Lead). */
  fromQuality: string;
  toQuality: string;
  eventTimeIso: string;
  actorUserId: string | null;
  /** Injectable Meta fetch for tests (verification only). */
  fetchImpl?: typeof fetch;
}

export type EnqueueOutcome =
  | { enqueued: true; eventId: string; deduplicated: boolean }
  | { enqueued: false; reason: "unchanged" | "unmapped" | "disabled" | "no_meta_lead" };

/**
 * Enqueue one CRM event for a genuine quality transition. Returns
 * without writing when: nothing changed, the value maps to no
 * event, feedback is disabled/unconfigured, or the run has no
 * original Meta Lead ID (non-Meta leads keep internal status
 * only — never fabricated). Never throws for missing config.
 */
export async function enqueueLeadQualityEvent(
  db: SupabaseClient,
  args: EnqueueLeadQualityEventArgs,
): Promise<EnqueueOutcome> {
  const from = (args.fromQuality ?? "").trim();
  const to = (args.toQuality ?? "").trim();
  if (from.toLowerCase() === to.toLowerCase()) return { enqueued: false, reason: "unchanged" };

  const eventName = leadQualityToEvent(to);
  if (!eventName) return { enqueued: false, reason: "unmapped" };

  // Only Meta Instant Form leads carry the original lead id.
  const { data: sub, error: subErr } = await db
    .from("meta_lead_submissions")
    .select("id, meta_lead_id")
    .eq("account_id", args.accountId)
    .eq("flow_run_id", args.runId)
    .maybeSingle();
  if (subErr) throw subErr;
  const submission = sub as { id: string; meta_lead_id: string } | null;
  if (!submission || !submission.meta_lead_id.trim()) {
    return { enqueued: false, reason: "no_meta_lead" };
  }

  const config = await getCrmFeedbackConfig(db, args.accountId);
  if (!config || !config.enabled || !config.dataset_id) {
    return { enqueued: false, reason: "disabled" };
  }

  const { data, error } = await db
    .from("meta_crm_events")
    .insert({
      account_id: args.accountId,
      flow_id: args.flowId,
      flow_run_id: args.runId,
      submission_id: submission.id,
      meta_lead_id: submission.meta_lead_id,
      event_name: eventName,
      from_quality: from,
      to_quality: to,
      event_time: args.eventTimeIso,
      dataset_id: config.dataset_id,
    })
    .select("id")
    .single();
  if (!error && data) {
    return { enqueued: true, eventId: (data as { id: string }).id, deduplicated: false };
  }
  if (error && isUniqueViolation(error)) {
    const { data: existing } = await db
      .from("meta_crm_events")
      .select("id")
      .eq("account_id", args.accountId)
      .eq("flow_run_id", args.runId)
      .eq("event_name", eventName)
      .eq("from_quality", from)
      .eq("to_quality", to)
      .maybeSingle();
    if (existing) {
      return { enqueued: true, eventId: (existing as { id: string }).id, deduplicated: true };
    }
  }
  throw error ?? new Error("Failed to enqueue CRM event.");
}

/** Bounded exponential backoff: 1m, 2m, 4m … capped at 30m. */
export function crmRetryDelayMs(attempt: number): number {
  const step = Math.max(0, attempt - 1);
  return Math.min(60_000 * 2 ** step, 30 * 60_000);
}

export const CRM_MAX_ATTEMPTS = 8;
export const CRM_DRAIN_LIMIT = 20;

export interface CrmDrainResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Send due pending events. Per-row isolated: one row's failure
 * never affects others. Retries reuse the row's event_uuid as the
 * Meta event_id. Terminal states: sent / failed (attempts spent) /
 * skipped (feedback disabled or misconfigured at send time).
 */
export async function drainCrmEventsQueue(
  db: SupabaseClient,
  opts: { limit?: number; onlyAccountId?: string; fetchImpl?: typeof fetch; eventIds?: string[] } = {},
): Promise<CrmDrainResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? CRM_DRAIN_LIMIT, 100));
  const out: CrmDrainResult = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  let query = db
    .from("meta_crm_events")
    .select("*")
    .eq("status", "pending")
    .lte("next_retry_at", new Date().toISOString())
    .order("next_retry_at", { ascending: true })
    .limit(limit);
  if (opts.onlyAccountId) query = query.eq("account_id", opts.onlyAccountId);
  // Targeted drain for manual sends: restrict to specific rows while
  // keeping the pending-only gate, so an already-sent duplicate can
  // never be re-sent by a concurrent manual click.
  if (opts.eventIds && opts.eventIds.length > 0) {
    query = query.in("id", opts.eventIds.slice(0, 100));
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = ((data ?? []) as CrmEventRow[]).filter((r) => typeof r.id === "string");
  if (rows.length === 0) return out;

  for (const row of rows) {
    out.attempted += 1;
    try {
      const config = await getCrmFeedbackConfig(db, row.account_id);
      if (!config || !config.enabled || !config.dataset_id) {
        await db
          .from("meta_crm_events")
          .update({
            status: "skipped",
            last_error: "CRM feedback disabled or unconfigured at send time.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        out.skipped += 1;
        continue;
      }
      let token: string;
      try {
        token = await getUserToken(db, row.account_id);
      } catch {
        await failRow(db, row, "No authorized Meta connection for this workspace.", false);
        out.failed += 1;
        continue;
      }
      let response: unknown = null;
      try {
        // Built inside the guarded section: a builder rejection
        // (bad id, bad time) lands in the invalid_input branch
        // below (skipped), never in the retry loop.
        const payload = buildCrmEventPayload({
          eventName: row.event_name as CrmEventName,
          eventTimeIso: row.event_time,
          metaLeadId: row.meta_lead_id,
          eventUuid: row.event_uuid,
          // Matching identifiers are resolved from the lead at send
          // time (same resolver the preview uses) — the ledger row
          // keeps the occurrence + identity, never raw PII.
          match: await resolveRowMatchHashes(db, row),
        });
        ({ response } = await sendCrmEvent({
          datasetId: config.dataset_id,
          accessToken: token,
          payload,
          fetchImpl: opts.fetchImpl ?? fetch,
        }));
      } catch (err) {
        if (err instanceof MetaCrmError) {
          // Invalid input (bad id, bad time) can never succeed on
          // retry — park the row as skipped with the reason instead
          // of burning all attempts. Auth/permission failures still
          // retry until attempts are spent (the token may be
          // refreshed or re-granted).
          if (err.code === "invalid_input") {
            await db
              .from("meta_crm_events")
              .update({
                status: "skipped",
                last_error: err.message,
                updated_at: new Date().toISOString(),
              })
              .eq("id", row.id);
            out.skipped += 1;
            continue;
          }
          // Auth/permission failures still retry until attempts are
          // spent (the token may be refreshed or re-granted); the
          // diagnostic is preserved on the row either way.
          await failRow(db, row, err.message, true);
          out.failed += 1;
          continue;
        }
        throw err;
      }
      await db
        .from("meta_crm_events")
        .update({
          status: "sent",
          attempts: row.attempts + 1,
          last_error: null,
          meta_response: (response ?? null) as never,
          sent_at: new Date().toISOString(),
          next_retry_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await db
        .from("meta_crm_config")
        .update({ last_event_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("account_id", row.account_id);
      out.sent += 1;
    } catch (err) {
      console.error(
        "[meta-crm] event drain row failed:",
        err instanceof Error ? err.message : err,
      );
      try {
        await failRow(db, row, "Unexpected delivery error.", true);
      } catch {
        // Best-effort only; the next sweep retries.
      }
      out.failed += 1;
    }
  }
  return out;
}

/**
 * Match hashes for one ledger row at drain time. Best-effort: a
 * resolver failure must never lose the valid lead_id match, so it
 * resolves to no extra identifiers (the payload still carries the
 * exact Meta Lead ID) rather than failing the row.
 */
async function resolveRowMatchHashes(
  db: SupabaseClient,
  row: CrmEventRow,
): Promise<{ em: string[]; ph: string[] }> {
  try {
    const match = await resolveLeadMatchHashes(db, {
      accountId: row.account_id ?? "",
      runId: row.flow_run_id ?? "",
    });
    return { em: match.em, ph: match.ph };
  } catch {
    return { em: [], ph: [] };
  }
}

async function failRow(
  db: SupabaseClient,
  row: CrmEventRow,
  message: string,
  retryable: boolean,
): Promise<void> {
  const attempt = row.attempts + 1;
  const willRetry = retryable && attempt < Math.min(row.max_attempts || CRM_MAX_ATTEMPTS, 32);
  await db
    .from("meta_crm_events")
    .update({
      status: willRetry ? "pending" : "failed",
      attempts: attempt,
      last_error: message.slice(0, 500),
      next_retry_at: new Date(Date.now() + crmRetryDelayMs(attempt)).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
}
