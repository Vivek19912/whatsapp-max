// ============================================================
// Meta Instant Form → WhatsApp Max CRM → Meta Conversions API
// lead-quality feedback (Feature: CRM event delivery).
//
// Five standardized CRM event names, mapped from the Workspace
// "Lead Quality" column's stored display values. This module is
// pure (mapping + payload) plus one thin Meta sender; persistence
// and scheduling live in `./feedback` (durable outbox + cron
// drain), so unit tests never touch Supabase or the network.
//
// This is a NEW, independent integration. It does NOT inspect,
// reuse, or depend on the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.
//
// Privacy: tokens never appear in errors, logs, or return values.
// ============================================================

import { MetaCrmError } from "./datasets";

/** The five standardized CRM event names (Meta + Workspace shared). */
export const CRM_EVENT_NAMES = [
  "Lead",
  "InterestedLead",
  "QualifiedLead",
  "BookingConfirmed",
  "DisqualifiedLead",
] as const;

export type CrmEventName = (typeof CRM_EVENT_NAMES)[number];

export function isCrmEventName(value: unknown): value is CrmEventName {
  return (
    typeof value === "string" &&
    (CRM_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Stored "Lead Quality" display values, in dropdown order. Only the
 * four CRM outcomes are user-selectable; the automatic initial
 * state "Lead" is the provisioned field default (display-only
 * fallback for empty cells) and is intentionally NOT an option,
 * so it can never be saved explicitly or generate a duplicate
 * initial event.
 */
export const LEAD_QUALITY_OPTIONS: readonly string[] = [
  "Interested Lead",
  "Qualified Lead",
  "Booking Confirmed",
  "Disqualified Lead",
];

/** Display default for empty Lead Quality cells (provisioned rows). */
export const LEAD_QUALITY_DEFAULT_VALUE = "Lead";

/**
 * Tooltip explaining the column's CRM purpose (rendered next to
 * the Workspace column heading).
 */
export const LEAD_QUALITY_TOOLTIP =
  "Classify each travel enquiry based on genuine customer interest and booking progress. Changes are sent to Meta to help improve qualified lead optimization when CRM feedback is enabled.";

/**
 * Stored display value → CRM event name. Exact, case-insensitive
 * match on the five known values (storage validates exact option
 * equality; tolerance here is display-only). Legacy or custom
 * values (Hot/Warm/Cold/Fake, …) map to null → no event is ever
 * sent for them.
 */
export function leadQualityToEvent(value: string | null | undefined): CrmEventName | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "lead":
      return "Lead";
    case "interested lead":
      return "InterestedLead";
    case "qualified lead":
      return "QualifiedLead";
    case "booking confirmed":
      return "BookingConfirmed";
    case "disqualified lead":
      return "DisqualifiedLead";
    default:
      return null;
  }
}

/** CAPI action_source for CRM-originated events. */
export const CRM_ACTION_SOURCE = "system_generated";

/** Graph version for CRM event sends (same pin as dataset creation). */
export { META_CRM_GRAPH_VERSION } from "./datasets";

export function buildCrmEventsUrl(datasetId: string): string {
  // NOTE: dataset ids are numeric strings; keep as text (no Number()).
  return `https://graph.facebook.com/v27.0/${datasetId.trim()}/events`;
}

export interface CrmEventPayload {
  event_name: CrmEventName;
  /** Unix seconds — actual business-event time, never fabricated. */
  event_time: number;
  action_source: typeof CRM_ACTION_SOURCE;
  user_data: { lead_id: string };
  /** Stable dedup id (our event row UUID). */
  event_id: string;
}

export function buildCrmEventPayload(args: {
  eventName: CrmEventName;
  eventTimeIso: string;
  metaLeadId: string;
  eventUuid: string;
}): CrmEventPayload {
  const ms = Date.parse(args.eventTimeIso);
  if (Number.isNaN(ms)) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Refusing to send a CRM event with an invalid event time.",
      status: 400,
    });
  }
  const leadId = args.metaLeadId.trim();
  if (leadId === "") {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Refusing to send a CRM event without the original Meta Lead ID.",
      status: 400,
    });
  }
  return {
    event_name: args.eventName,
    event_time: Math.floor(ms / 1000),
    action_source: CRM_ACTION_SOURCE,
    user_data: { lead_id: leadId },
    event_id: args.eventUuid,
  };
}

interface MetaEventsErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

function safeEventsMessage(body: MetaEventsErrorBody | null, status: number): string {
  const raw = body?.error?.message?.trim();
  if (raw && raw.length > 0) return raw.slice(0, 300);
  return `Meta rejected the CRM event (${status}).`;
}

export interface SendCrmEventArgs {
  datasetId: string;
  accessToken: string;
  payload: CrmEventPayload;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface SentCrmEvent {
  /** Raw Meta response (stored for monitoring, never includes secrets). */
  response: unknown;
}

/**
 * Send one CRM event to a dataset's Conversions API edge. Exactly
 * one POST; callers must not retry an uncertain response with a new
 * event — retries reuse the same `event_id`.
 */
export async function sendCrmEvent(args: SendCrmEventArgs): Promise<SentCrmEvent> {
  const datasetId = args.datasetId.trim();
  const accessToken = args.accessToken.trim();
  const fetchImpl = args.fetchImpl ?? fetch;

  if (!/^\d{5,32}$/.test(datasetId)) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Refusing to send a CRM event without a valid dataset ID.",
      status: 400,
    });
  }
  if (accessToken === "") {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Refusing to send a CRM event without an access token.",
      status: 400,
    });
  }

  let res: Response;
  try {
    res = await fetchImpl(buildCrmEventsUrl(datasetId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: [args.payload] }),
    });
  } catch {
    throw new MetaCrmError({
      code: "network_error",
      message: "Could not reach Meta. The event stays queued for retry.",
      status: 502,
    });
  }

  let parsed: unknown = null;
  try {
    const text = await res.text();
    parsed = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = null;
  }

  const data = (parsed ?? {}) as {
    events_received?: unknown;
    error?: MetaEventsErrorBody["error"];
  };
  const metaError = data.error;

  if (!res.ok || metaError) {
    const metaCode = typeof metaError?.code === "number" ? metaError.code : null;
    const metaSubcode =
      typeof metaError?.error_subcode === "number" ? metaError.error_subcode : null;
    const message = safeEventsMessage(metaError ? { error: metaError } : null, res.status);
    if (metaCode === 200) {
      throw new MetaCrmError({
        code: "forbidden",
        message: `Meta refused the CRM event: insufficient permissions (code 200). ${message}`.slice(0, 300),
        status: 403,
        metaCode,
        metaSubcode,
      });
    }
    if (metaCode === 190 || metaCode === 102 || res.status === 401) {
      throw new MetaCrmError({
        code: "auth_failed",
        message: "Meta rejected the access token. It may be expired or invalid.",
        status: 401,
        metaCode,
        metaSubcode,
      });
    }
    throw new MetaCrmError({
      code: "meta_error",
      message,
      status: res.status >= 500 ? 502 : res.status || 502,
      metaCode,
      metaSubcode,
    });
  }

  return { response: parsed };
}
