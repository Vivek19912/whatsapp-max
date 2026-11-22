// ============================================================
// Meta CRM feedback — manual-send preview assembly.
//
// Single shared source for the "Send to Meta" flow: both the
// preview endpoint (GET .../preview) and the manual send endpoint
// (POST .../manual-send) assemble state through
// `assembleLeadQualityPreview`. The send path re-assembles from
// live DB state and compares preview ids, so a preview can never
// be replayed after the status, dataset, or lead changed.
//
// Selecting or clearing a Lead Quality status NEVER sends — it
// only stores the value (see the workspace-values route, which
// deliberately contains no CRM hook). Delivery happens solely via
// the explicit send endpoint, which enqueues through the existing
// durable outbox (`enqueueLeadQualityEvent`) and its
// retry/dedup/ledger machinery. Retired CAPI stays untouched.
//
// Privacy: no tokens appear in results, errors, or logs.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { getCrmFeedbackConfig } from "./feedback";
import {
  LEAD_QUALITY_DEFAULT_VALUE,
  buildCrmEventPayload,
  buildCrmRequestBody,
  buildLeadQualityPreviewId,
  isSafeJsonInteger,
  leadQualityToEvent,
  validateMetaLeadId,
  type CrmEventName,
  type CrmEventPayload,
  type CrmRequestBody,
} from "./lead-quality";
import { resolveLeadMatchHashes } from "./matching";

/** Machine-readable gate when a preview is not sendable. */
export type LeadQualitySendGate =
  | "no_column"
  | "unmapped"
  | "no_meta_lead"
  | "disabled"
  | "invalid_lead_id"
  | "invalid_timestamp";

export interface LeadQualityLedgerSnapshot {
  id: string;
  eventName: string;
  /** Actual occurrence time delivered (Unix seconds, as sent). */
  eventTime: number | null;
  status: string;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface LeadQualityPreview {
  /** True when the Send button may be offered. */
  sendable: boolean;
  /** Machine gate when sendable is false. */
  reason: LeadQualitySendGate | null;
  /** Human explanation (gating reason or send summary). */
  message: string;
  flowId: string;
  runId: string;
  /** Effective display status (stored value or the Lead default). */
  status: string;
  /** Explicitly stored value; null when showing the Lead default. */
  stored: string | null;
  eventName: CrmEventName | null;
  datasetId: string | null;
  /** Exact Meta Lead ID digits (un-hashed, matched verbatim). */
  metaLeadId: string | null;
  /**
   * Stage-change (occurrence) time: the stored status-change moment
   * (quality cell update), or the lead creation time for the
   * initial stage. This exact instant is delivered as event_time —
   * never the send moment, never refreshed on retry.
   */
  occurrenceTimeIso: string | null;
  /** Server-generated staleness fingerprint; null when not sendable. */
  previewId: string | null;
  /** The event object from the REAL builder (never invented). */
  payload: CrmEventPayload | null;
  /**
   * The COMPLETE outgoing JSON request body (`{ data: [...] }`),
   * built by the same shared constructor the send path uses.
   */
  requestBody: CrmRequestBody | null;
  /** Non-blocking validation notes (shown in the drawer). */
  warnings: string[];
  /** Whether hashed match identifiers are included (never raw data). */
  matchInfo: { hasEmail: boolean; hasPhone: boolean };
  /** Latest ledger row for this lead (any event), if one exists. */
  lastEvent: LeadQualityLedgerSnapshot | null;
}

export const LEAD_QUALITY_EVENT_TIME_NOTE =
  "event_time is the stage-change (occurrence) time — the moment the status was saved, or the lead creation time for the initial Lead stage — not the moment you press Send. Retries reuse the same occurrence time.";
export const LEAD_QUALITY_EVENT_ID_NOTE =
  "event_id is the ledger row id created at send time (reused for retries); the preview shows the server-generated preview id in its place.";

/**
 * Assemble the send preview from live DB state. Pure reads — never
 * writes, never touches Meta. `db` should be the caller's
 * RLS-scoped client; every query is account-scoped.
 */
export async function assembleLeadQualityPreview(
  db: SupabaseClient,
  args: { accountId: string; flowId: string; runId: string; nowIso?: string },
): Promise<LeadQualityPreview> {
  const nowIso = args.nowIso ?? new Date().toISOString();

  // Run must belong to this account + flow (tenant isolation, same
  // rule as the workspace-values save path). NOTE: flow_runs has NO
  // created_at column — only started_at/last_advanced_at/ended_at.
  // Selecting a non-existent column makes PostgREST fail the whole
  // preview with a 500, so started_at is the run-level fallback.
  const { data: run, error: runErr } = await db
    .from("flow_runs")
    .select("id, started_at")
    .eq("id", args.runId)
    .eq("account_id", args.accountId)
    .eq("flow_id", args.flowId)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run) {
    throw Object.assign(new Error("Run not found."), { status: 404 });
  }

  // The Lead Quality column for this flow (case-insensitive, same
  // rule as the save path).
  const { data: field, error: fieldErr } = await db
    .from("workspace_fields")
    .select("id")
    .eq("account_id", args.accountId)
    .eq("flow_id", args.flowId)
    .ilike("name", "Lead Quality")
    .maybeSingle();
  if (fieldErr) throw fieldErr;
  if (!field) {
    return {
      sendable: false,
      reason: "no_column",
      message: "This table has no Lead Quality column, so there is nothing to send.",
      flowId: args.flowId,
      runId: args.runId,
      status: LEAD_QUALITY_DEFAULT_VALUE,
      stored: null,
      eventName: null,
      datasetId: null,
      metaLeadId: null,
      occurrenceTimeIso: null,
      previewId: null,
      payload: null,
      requestBody: null,
      warnings: [],
      matchInfo: { hasEmail: false, hasPhone: false },
      lastEvent: null,
    };
  }
  const fieldId = (field as { id: string }).id;

  // Only Meta Instant Form leads carry the original Meta Lead ID.
  // meta_created_time is the TRUE lead creation instant (used for
  // the initial stage occurrence); created_at is the ingestion
  // fallback. Read it here so every path below shares it.
  const { data: sub, error: subErr } = await db
    .from("meta_lead_submissions")
    .select("meta_lead_id, meta_created_time, created_at")
    .eq("account_id", args.accountId)
    .eq("flow_run_id", args.runId)
    .maybeSingle();
  if (subErr) throw subErr;
  const submission = sub as {
    meta_lead_id: string;
    meta_created_time: string | null;
    created_at: string;
  } | null;
  const metaLeadId = submission?.meta_lead_id?.trim() ?? "";
  // Fallback chain for the initial-stage occurrence: the TRUE Meta
  // creation instant, then ingestion time, then the run start.
  // (flow_runs.created_at does NOT exist — see the run query above.)
  const runStartedAt = (run as { started_at?: string }).started_at ?? null;
  const leadCreationIso =
    submission?.meta_created_time ?? submission?.created_at ?? runStartedAt ?? nowIso;

  const unmapped = (
    message: string,
    status: string,
    stored: string | null,
    eventName: CrmEventName | null,
  ): LeadQualityPreview => ({
    sendable: false,
    reason: "unmapped",
    message,
    flowId: args.flowId,
    runId: args.runId,
    status,
    stored,
    eventName,
    datasetId: null,
    metaLeadId: metaLeadId || null,
    occurrenceTimeIso: null,
    previewId: null,
    payload: null,
    requestBody: null,
    warnings: [],
    matchInfo: { hasEmail: false, hasPhone: false },
    lastEvent: null,
  });

  const { data: valueRow, error: valueErr } = await db
    .from("workspace_values")
    .select("value_text, updated_at")
    .eq("account_id", args.accountId)
    .eq("field_id", fieldId)
    .eq("flow_run_id", args.runId)
    .maybeSingle();
  if (valueErr) throw valueErr;
  const value = valueRow as { value_text: string | null; updated_at: string } | null;
  const stored = value?.value_text ?? null;
  const status = stored ?? LEAD_QUALITY_DEFAULT_VALUE;

  const eventName = leadQualityToEvent(status);
  if (!eventName) {
    const p = unmapped(
      `“${status}” is not a Meta CRM status, so it can never be sent. Pick one of the Lead Quality options.`,
      status,
      stored,
      null,
    );
    p.lastEvent = await readLastEvent(db, args.accountId, args.runId);
    return p;
  }

  if (!metaLeadId) {
    return {
      sendable: false,
      reason: "no_meta_lead",
      message: "This lead did not come from a Meta Instant Form, so there is no Meta Lead ID to send.",
      flowId: args.flowId,
      runId: args.runId,
      status,
      stored,
      eventName,
      datasetId: null,
      metaLeadId: null,
      occurrenceTimeIso: null,
      previewId: null,
      payload: null,
      requestBody: null,
      warnings: [],
      matchInfo: { hasEmail: false, hasPhone: false },
      lastEvent: await readLastEvent(db, args.accountId, args.runId),
    };
  }

  // Hard gate: the identifier must be digits-only and bounded.
  // Anything else (internal ids, form ids, garbage) is rejected —
  // never coerced, never hashed, never substituted.
  let leadDigits: string;
  try {
    leadDigits = validateMetaLeadId(metaLeadId);
  } catch {
    return {
      sendable: false,
      reason: "invalid_lead_id",
      message:
        "The stored Meta Lead ID is not a valid numeric identifier, so sending is blocked. Fix the lead record before sending.",
      flowId: args.flowId,
      runId: args.runId,
      status,
      stored,
      eventName,
      datasetId: null,
      metaLeadId,
      occurrenceTimeIso: null,
      previewId: null,
      payload: null,
      requestBody: null,
      warnings: [],
      matchInfo: { hasEmail: false, hasPhone: false },
      lastEvent: await readLastEvent(db, args.accountId, args.runId),
    };
  }

  // Occurrence (stage-change) time: the stored status-change moment
  // (the value row's update instant, maintained by the DB trigger),
  // or the lead creation time for the initial, never-saved stage.
  // This exact instant is delivered as event_time — never the send
  // moment, never refreshed on retry.
  const occurrenceTimeIso = value?.updated_at ?? leadCreationIso;

  // Hard gate: future occurrences are rejected (clock skew beyond
  // the builder tolerance can never be delivered).
  if (Date.parse(occurrenceTimeIso) > Date.parse(nowIso) + 5 * 60_000) {
    return {
      sendable: false,
      reason: "invalid_timestamp",
      message:
        "The status-change time is in the future, so sending is blocked. Re-save the status to record a valid time.",
      flowId: args.flowId,
      runId: args.runId,
      status,
      stored,
      eventName,
      datasetId: null,
      metaLeadId: leadDigits,
      occurrenceTimeIso,
      previewId: null,
      payload: null,
      requestBody: null,
      warnings: [],
      matchInfo: { hasEmail: false, hasPhone: false },
      lastEvent: await readLastEvent(db, args.accountId, args.runId),
    };
  }

  const config = await getCrmFeedbackConfig(db, args.accountId);
  if (!config || !config.enabled || !config.dataset_id) {
    return {
      sendable: false,
      reason: "disabled",
      message: "Meta CRM feedback is not enabled for this workspace, so sending is disabled.",
      flowId: args.flowId,
      runId: args.runId,
      status,
      stored,
      eventName,
      datasetId: config?.dataset_id ?? null,
      metaLeadId: leadDigits,
      occurrenceTimeIso,
      previewId: null,
      payload: null,
      requestBody: null,
      warnings: [],
      matchInfo: { hasEmail: false, hasPhone: false },
      lastEvent: await readLastEvent(db, args.accountId, args.runId),
    };
  }

  // Hashed matching identifiers (server-side only; raw values never
  // leave the resolver). Missing data never blocks when the valid
  // lead_id minimum is satisfied.
  const match = await resolveLeadMatchHashes(db, {
    accountId: args.accountId,
    runId: args.runId,
  });

  const warnings: string[] = [];
  if (stored === null) {
    warnings.push(
      "No saved status — showing the initial Lead stage with the lead creation time as the occurrence.",
    );
  }
  if (Date.parse(occurrenceTimeIso) < Date.parse(leadCreationIso) - 60_000) {
    warnings.push("The occurrence is before the lead was created — Meta may discard this event.");
  }
  if (Date.parse(nowIso) - Date.parse(occurrenceTimeIso) > 7 * 24 * 60 * 60_000) {
    warnings.push("The occurrence is older than 7 days — Meta rejects events that old.");
  }
  if (leadDigits.length < 15 || leadDigits.length > 17) {
    warnings.push(`The Meta Lead ID has an unexpected length (${leadDigits.length} digits; Meta documents 15–17).`);
  }
  if (!isSafeJsonInteger(leadDigits)) {
    warnings.push(
      `The Meta Lead ID exceeds the safe integer range and is sent as an exact digit string (precision preserved, never rounded).`,
    );
  }
  if (match.emailInvalid) warnings.push("The stored email address is malformed and was omitted from matching.");
  if (match.phoneInvalid) warnings.push("The stored phone number could not be normalized and was omitted from matching.");
  if (match.em.length === 0 && match.ph.length === 0) {
    warnings.push("No hashed email/phone available — matching relies on the Meta Lead ID alone.");
  }

  const previewId = buildLeadQualityPreviewId({
    accountId: args.accountId,
    flowId: args.flowId,
    runId: args.runId,
    eventName,
    toQuality: status,
    datasetId: config.dataset_id,
    metaLeadId: leadDigits,
    occurrenceTimeIso,
    matchEm: match.em,
    matchPh: match.ph,
  });
  // The preview payload comes from the SAME builder the send and
  // drain paths use, with the occurrence fixed above.
  const payload = buildCrmEventPayload({
    eventName,
    eventTimeIso: occurrenceTimeIso,
    metaLeadId: leadDigits,
    eventUuid: previewId,
    match: { em: match.em, ph: match.ph },
  });
  // The COMPLETE outgoing body from the shared constructor — the
  // same object shape the HTTP layer serializes and posts.
  const requestBody = buildCrmRequestBody(payload);

  return {
    sendable: true,
    reason: null,
    message: `Ready to send ${eventName} for “${status}”.`,
    flowId: args.flowId,
    runId: args.runId,
    status,
    stored,
    eventName,
    datasetId: config.dataset_id,
    metaLeadId: leadDigits,
    occurrenceTimeIso,
    previewId,
    payload,
    requestBody,
    warnings,
    matchInfo: { hasEmail: match.em.length > 0, hasPhone: match.ph.length > 0 },
    lastEvent: await readLastEvent(db, args.accountId, args.runId),
  };
}

async function readLastEvent(
  db: SupabaseClient,
  accountId: string,
  runId: string,
): Promise<LeadQualityLedgerSnapshot | null> {
  const { data, error } = await db
    .from("meta_crm_events")
    .select("id, event_name, event_time, status, last_error, sent_at, created_at")
    .eq("account_id", accountId)
    .eq("flow_run_id", runId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    id: string;
    event_name: string;
    event_time: string | null;
    status: string;
    last_error: string | null;
    sent_at: string | null;
    created_at: string;
  };
  const ms = row.event_time ? Date.parse(row.event_time) : NaN;
  return {
    id: row.id,
    eventName: row.event_name,
    eventTime: Number.isNaN(ms) ? null : Math.floor(ms / 1000),
    status: row.status,
    lastError: row.last_error,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

/**
 * Latest stored quality for a lead, chained for the ledger's
 * from_quality. Falls back to "" (implicit initial) when this
 * lead has no sent event yet.
 */
export async function resolveManualFromQuality(
  db: SupabaseClient,
  args: { accountId: string; runId: string },
): Promise<string> {
  const { data, error } = await db
    .from("meta_crm_events")
    .select("to_quality")
    .eq("account_id", args.accountId)
    .eq("flow_run_id", args.runId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const to = (data as { to_quality: string } | null)?.to_quality;
  return typeof to === "string" ? to : "";
}
