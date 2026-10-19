// ============================================================
// Meta Conversions API — delivery engine.
//
// Real Meta CAPI behaviour:
//   * Events are POSTed to the customer's OWN dataset with the
//     customer's OWN token (never the platform app token).
//   * Delivery is idempotent: each logical conversion has a stable
//     `event_id` enforced UNIQUE per account, so retries (and
//     concurrent workers) can never double-count a conversion.
//   * Failed sends are retried with bounded exponential backoff and
//     are never silently dropped — the ledger always shows the truth.
//   * A value-bearing event (Purchase) with no real value/currency is
//     recorded as `skipped`, never sent with an invented amount.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";

import { sendEvents, type CapiPlatform } from "./client";
import { buildUserData } from "./hash";
import {
  buildCapiEvent,
  buildCustomData,
  buildEventId,
  buildRequestPayload,
  matchesMapping,
  valueCriteriaMet,
  type CapiActionEvent,
} from "./payload";
import {
  claimDelivery,
  getConfig,
  getDecryptedToken,
  getDelivery,
  insertDelivery,
  listDueDeliveries,
  listEnabledMappingsForAction,
  markDeliveryFailed,
  markDeliverySent,
} from "./store";
import type { MetaCapiDeliveryRow } from "./types";

export const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 30 * 60_000;

/** Bounded exponential backoff: 1m, 2m, 4m, 8m, capped at 30m. */
export function nextRetryDelayMs(attempt: number): number {
  const step = Math.max(0, attempt - 1);
  return Math.min(RETRY_BASE_MS * 2 ** step, RETRY_CAP_MS);
}

function safeError(err: unknown): string {
  if (err instanceof MetaLeadAdsError) return `${err.code}: ${err.message}`;
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

export interface FireResult {
  fired: number;
  failed: number;
  skipped: number;
}

async function loadCredentials(
  db: SupabaseClient,
  accountId: string,
): Promise<{ datasetId: string; token: string } | null> {
  const config = await getConfig(db, accountId);
  if (!config?.dataset_id || !config.access_token) return null;
  try {
    const token = await getDecryptedToken(db, accountId);
    if (!token) return null;
    return { datasetId: config.dataset_id, token };
  } catch {
    return null;
  }
}

async function attemptDelivery(
  db: SupabaseClient,
  platform: CapiPlatform,
  delivery: MetaCapiDeliveryRow,
  datasetId: string,
  token: string,
): Promise<"sent" | "failed"> {
  const attempts = delivery.attempts + 1;
  const payload = (delivery.request_payload ?? { data: [] }) as Record<string, unknown>;
  try {
    const res = await sendEvents(platform, datasetId, token, payload);
    if ((res.events_received ?? 0) >= 1) {
      await markDeliverySent(db, delivery.id, res as Record<string, unknown>, attempts);
      return "sent";
    }
    throw new MetaLeadAdsError(
      "graph_error",
      "Meta accepted the request but reported 0 events received.",
      502,
    );
  } catch (err) {
    const willRetry = attempts < MAX_DELIVERY_ATTEMPTS;
    await markDeliveryFailed(
      db,
      delivery.id,
      attempts,
      safeError(err),
      willRetry
        ? new Date(Date.now() + nextRetryDelayMs(attempts)).toISOString()
        : null,
    );
    return "failed";
  }
}

/**
 * Evaluate every enabled mapping for this account+action, enqueue and
 * deliver the applicable events. Safe to call from any server-side
 * domain operation — it never throws for "delivery failed" (that is
 * recorded on the ledger); it only throws for genuine programming
 * errors (callers still wrap it defensively, see triggers.ts).
 */
export async function fireCapiForAction(
  db: SupabaseClient,
  platform: CapiPlatform,
  event: CapiActionEvent,
): Promise<FireResult> {
  const result: FireResult = { fired: 0, failed: 0, skipped: 0 };

  const creds = await loadCredentials(db, event.accountId);
  if (!creds) return result;

  const mappings = await listEnabledMappingsForAction(db, event.accountId, event.action);
  if (mappings.length === 0) return result;

  const occurredAt = event.occurredAt ?? new Date();
  const userData = buildUserData(event.matchData ?? {});

  for (const mapping of mappings) {
    if (!matchesMapping(mapping, event)) continue;

    const actionSource = mapping.action_source || "business_messaging";
    const eventId = buildEventId(mapping, event, occurredAt);

    if (!valueCriteriaMet(mapping)) {
      const skipped = await insertDelivery(db, {
        account_id: event.accountId,
        mapping_id: mapping.id,
        flow_run_id: event.flowRunId ?? null,
        contact_id: event.contactId ?? null,
        source_action: event.action,
        source_value: event.value ?? null,
        event_name: mapping.meta_event_name,
        event_id: eventId,
        action_source: actionSource,
        is_test: false,
        status: "skipped",
        last_error: `${mapping.meta_event_name} requires a value and currency; nothing was sent.`,
        request_payload: null,
      });
      if (skipped) result.skipped++;
      continue;
    }

    const eventObject = buildCapiEvent({
      eventName: mapping.meta_event_name,
      eventId,
      actionSource,
      eventTime: occurredAt,
      userData,
      customData: buildCustomData(mapping),
    });

    const delivery = await insertDelivery(db, {
      account_id: event.accountId,
      mapping_id: mapping.id,
      flow_run_id: event.flowRunId ?? null,
      contact_id: event.contactId ?? null,
      source_action: event.action,
      source_value: event.value ?? null,
      event_name: mapping.meta_event_name,
      event_id: eventId,
      action_source: actionSource,
      is_test: false,
      status: "pending",
      request_payload: buildRequestPayload(eventObject),
    });

    // null == the (account_id, event_id) key already exists → this
    // logical conversion was already enqueued. Idempotent no-op.
    if (!delivery) continue;

    const outcome = await attemptDelivery(db, platform, delivery, creds.datasetId, creds.token);
    if (outcome === "sent") result.fired++;
    else result.failed++;
  }

  return result;
}

export interface SweepResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** Retry one specific failed delivery for an account (admin action). */
export async function retryDeliveryById(
  db: SupabaseClient,
  platform: CapiPlatform,
  accountId: string,
  id: string,
): Promise<"sent" | "failed" | "skipped"> {
  const delivery = await getDelivery(db, accountId, id);
  if (!delivery || delivery.status !== "failed") return "skipped";
  const creds = await loadCredentials(db, accountId);
  if (!creds) return "skipped";
  const claimed = await claimDelivery(db, id);
  if (!claimed) return "skipped";
  return attemptDelivery(db, platform, claimed, creds.datasetId, creds.token);
}

/** Retry every failed delivery whose backoff window has elapsed. */
export async function runDueDeliveries(
  db: SupabaseClient,
  platform: CapiPlatform,
  limit = 25,
  accountId?: string,
): Promise<SweepResult> {
  const rows = await listDueDeliveries(db, limit, accountId);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const credsByAccount = new Map<string, { datasetId: string; token: string } | null>();

  for (const row of rows) {
    let creds = credsByAccount.get(row.account_id);
    if (creds === undefined) {
      creds = await loadCredentials(db, row.account_id);
      credsByAccount.set(row.account_id, creds);
    }
    if (!creds) {
      skipped++;
      continue;
    }
    const claimed = await claimDelivery(db, row.id);
    if (!claimed) {
      skipped++;
      continue;
    }
    const outcome = await attemptDelivery(db, platform, claimed, creds.datasetId, creds.token);
    if (outcome === "sent") sent++;
    else failed++;
  }

  return { attempted: rows.length, sent, failed, skipped };
}
