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
  buildLeadQualityPreviewId,
  leadQualityToEvent,
  type CrmEventName,
  type CrmEventPayload,
} from "./lead-quality";

/** Machine-readable gate when a preview is not sendable. */
export type LeadQualitySendGate =
  | "no_column"
  | "unmapped"
  | "no_meta_lead"
  | "disabled";

export interface LeadQualityLedgerSnapshot {
  id: string;
  eventName: string;
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
  metaLeadId: string | null;
  /** Server-generated staleness fingerprint; null when not sendable. */
  previewId: string | null;
  /** Full payload JSON from the REAL event builder (never invented). */
  payload: CrmEventPayload | null;
  /** Latest ledger row for this lead (any event), if one exists. */
  lastEvent: LeadQualityLedgerSnapshot | null;
}

export const LEAD_QUALITY_EVENT_TIME_NOTE =
  "event_time is set to the moment you press Send — the preview shows the shape, not the final timestamp.";
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
  // rule as the workspace-values save path).
  const { data: run, error: runErr } = await db
    .from("flow_runs")
    .select("id")
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
      previewId: null,
      payload: null,
      lastEvent: null,
    };
  }
  const fieldId = (field as { id: string }).id;

  const { data: valueRow, error: valueErr } = await db
    .from("workspace_values")
    .select("value_text")
    .eq("account_id", args.accountId)
    .eq("field_id", fieldId)
    .eq("flow_run_id", args.runId)
    .maybeSingle();
  if (valueErr) throw valueErr;
  const stored = (valueRow as { value_text: string | null } | null)?.value_text ?? null;
  const status = stored ?? LEAD_QUALITY_DEFAULT_VALUE;

  const eventName = leadQualityToEvent(status);
  if (!eventName) {
    return {
      sendable: false,
      reason: "unmapped",
      message: `“${status}” is not a Meta CRM status, so it can never be sent. Pick one of the Lead Quality options.`,
      flowId: args.flowId,
      runId: args.runId,
      status,
      stored,
      eventName: null,
      datasetId: null,
      metaLeadId: null,
      previewId: null,
      payload: null,
      lastEvent: await readLastEvent(db, args.accountId, args.runId),
    };
  }

  // Only Meta Instant Form leads carry the original Meta Lead ID.
  const { data: sub, error: subErr } = await db
    .from("meta_lead_submissions")
    .select("meta_lead_id")
    .eq("account_id", args.accountId)
    .eq("flow_run_id", args.runId)
    .maybeSingle();
  if (subErr) throw subErr;
  const metaLeadId = (sub as { meta_lead_id: string } | null)?.meta_lead_id?.trim() ?? "";
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
      previewId: null,
      payload: null,
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
      metaLeadId,
      previewId: null,
      payload: null,
      lastEvent: await readLastEvent(db, args.accountId, args.runId),
    };
  }

  const previewId = buildLeadQualityPreviewId({
    accountId: args.accountId,
    flowId: args.flowId,
    runId: args.runId,
    eventName,
    toQuality: status,
    datasetId: config.dataset_id,
    metaLeadId,
  });
  // The preview payload comes from the SAME builder the send path
  // uses. event_time/event_id are volatile (set at send); the
  // preview id stands in for event_id so the shape stays exact.
  const payload = buildCrmEventPayload({
    eventName,
    eventTimeIso: nowIso,
    metaLeadId,
    eventUuid: previewId,
  });

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
    metaLeadId,
    previewId,
    payload,
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
    .select("id, event_name, status, last_error, sent_at, created_at")
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
    status: string;
    last_error: string | null;
    sent_at: string | null;
    created_at: string;
  };
  return {
    id: row.id,
    eventName: row.event_name,
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
