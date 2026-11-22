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
 * Stored "Lead Quality" display values, in dropdown order. All five
 * CRM states are user-selectable, including the initial "Lead" —
 * every send is manual (an explicit Send to Meta action), so an
 * explicitly saved "Lead" can never duplicate an automatic event.
 */
export const LEAD_QUALITY_OPTIONS: readonly string[] = [
  "Lead",
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
  "Classify each travel enquiry based on genuine customer interest and booking progress. Saving a status never sends anything — use the Send to Meta button in the lead drawer to deliver the event when CRM feedback is enabled.";

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

/**
 * CRM tool name reported in custom_data.lead_event_source (REQUIRED
 * by the Conversion Leads payload spec: "the name of the tool where
 * the leads are coming from").
 */
export const CRM_LEAD_EVENT_SOURCE = "WhatsApp Max";

/** custom_data.event_source value REQUIRED for Conversion Leads events. */
export const CRM_EVENT_SOURCE = "crm";

/** Graph version for CRM event sends (same pin as dataset creation). */
export { META_CRM_GRAPH_VERSION } from "./datasets";

export function buildCrmEventsUrl(datasetId: string): string {
  // NOTE: dataset ids are numeric strings; keep as text (no Number()).
  // Documented send path: POST graph.facebook.com/{VERSION}/{DATASET_ID}/events
  return `https://graph.facebook.com/v27.0/${datasetId.trim()}/events`;
}

export interface CrmUserData {
  /**
   * Exact Meta Lead ID digits (un-hashed — Meta matches CRM events
   * on it verbatim). Kept as the exact digit string in memory so
   * no precision is ever lost; the JSON serializer emits it as a
   * JSON number (Meta's documented integer type) whenever the
   * digits convert to a JS number with zero precision loss, and
   * preserves the exact digit string otherwise.
   */
  lead_id: string;
  /** SHA-256 hex of the Meta-normalized email (server-hashed). */
  em?: string[];
  /** SHA-256 hex of the Meta-normalized phone (server-hashed). */
  ph?: string[];
}

export interface CrmEventPayload {
  event_name: CrmEventName;
  /** Unix seconds — the actual business-event (stage-change) time, never fabricated. */
  event_time: number;
  action_source: typeof CRM_ACTION_SOURCE;
  user_data: CrmUserData;
  /**
   * REQUIRED by the Conversion Leads payload spec: the CRM tool
   * name plus event_source "crm". Without these, Meta cannot
   * attribute the event to Conversion Leads optimization.
   */
  custom_data: { lead_event_source: string; event_source: "crm" };
  /**
   * NOTE: no `event_id` is sent to Meta, by product decision.
   * Duplicate prevention is enforced application-side by the
   * durable ledger (UNIQUE per transition + targeted pending-only
   * drain), and every row keeps its internal `event_uuid` for
   * history, retries, and auditing — it just never leaves our
   * servers. Trade-off: Meta-side dedup of an uncertain/retried
   * delivery is weaker, so the drain only retries genuinely
   * unacknowledged rows.
   */
}

/**
 * Outgoing Conversions API request body for CRM events: Meta's
 * documented structure wraps event objects inside a top-level
 * `data` array, posted to `/{DATASET_ID}/events`.
 */
export interface CrmRequestBody {
  data: [CrmEventPayload];
}

/** Build the exact outgoing request body (single shared constructor). */
export function buildCrmRequestBody(event: CrmEventPayload): CrmRequestBody {
  return { data: [event] };
}

/** Upper bound for Meta Lead ID digits (docs: 15–17 digits; 20 caps abuse without blocking valid ids). */
export const MAX_META_LEAD_ID_LENGTH = 20;

/**
 * Validate a Meta Lead ID: digits only, non-empty, bounded length.
 * Returns the exact digit string. Throws (never coerces, never
 * hashes, never substitutes another id) on anything else.
 */
export function validateMetaLeadId(raw: unknown): string {
  const digits = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+$/.test(digits) || digits.length > MAX_META_LEAD_ID_LENGTH) {
    throw new MetaCrmError({
      code: "invalid_input",
      message:
        "Refusing to send a CRM event without a valid numeric Meta Lead ID (digits only).",
      status: 400,
    });
  }
  return digits;
}

/**
 * True when the digit string converts to a JS number with zero
 * precision loss. Larger identifiers stay exact strings — never
 * imprecise numbers.
 */
export function isSafeJsonInteger(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  try {
    return BigInt(digits) <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

/**
 * Serialize the outgoing request body. `lead_id` is emitted as a
 * JSON number (Meta's documented integer type) exactly when the
 * digits are exactly representable; otherwise the exact digit
 * string is preserved rather than corrupted by float precision.
 */
export function serializeCrmRequestBody(body: CrmRequestBody): string {
  return JSON.stringify(body, (key, value: unknown) =>
    key === "lead_id" &&
    typeof value === "string" &&
    /^\d+$/.test(value) &&
    isSafeJsonInteger(value)
      ? Number(value)
      : value,
  );
}

/** Parse one validated request body back (tests/diagnostics only). */
export function parseCrmRequestBody(text: string): CrmRequestBody {
  return JSON.parse(text) as CrmRequestBody;
}

/** Clock skew tolerated when rejecting future event times. */
const EVENT_TIME_FUTURE_TOLERANCE_MS = 5 * 60_000;

export function buildCrmEventPayload(args: {
  eventName: CrmEventName;
  eventTimeIso: string;
  metaLeadId: string;
  /**
   * Optional pre-hashed matching identifiers (server-side SHA-256
   * of Meta-normalized values). Raw contact data must never reach
   * this builder — hashing happens in server-only code.
   */
  match?: { em?: string[]; ph?: string[] };
}): CrmEventPayload {
  const ms = Date.parse(args.eventTimeIso);
  if (Number.isNaN(ms)) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Refusing to send a CRM event with an invalid event time.",
      status: 400,
    });
  }
  // The timestamp must be the actual occurrence (stage-change)
  // time — never the future. Retries reuse the stored occurrence,
  // so a historical payload is never "refreshed".
  if (ms > Date.now() + EVENT_TIME_FUTURE_TOLERANCE_MS) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Refusing to send a CRM event with a future event time.",
      status: 400,
    });
  }
  const leadId = validateMetaLeadId(args.metaLeadId);
  const em = (args.match?.em ?? []).filter((s) => typeof s === "string" && s !== "");
  const ph = (args.match?.ph ?? []).filter((s) => typeof s === "string" && s !== "");
  return {
    event_name: args.eventName,
    event_time: Math.floor(ms / 1000),
    action_source: CRM_ACTION_SOURCE,
    user_data: {
      lead_id: leadId,
      ...(em.length > 0 ? { em } : {}),
      ...(ph.length > 0 ? { ph } : {}),
    },
    custom_data: { lead_event_source: CRM_LEAD_EVENT_SOURCE, event_source: CRM_EVENT_SOURCE },
  };
}

export interface LeadQualityPreviewFingerprint {
  accountId: string;
  flowId: string;
  runId: string;
  eventName: CrmEventName;
  toQuality: string;
  datasetId: string;
  metaLeadId: string;
  /**
   * Stage-change (occurrence) time: the send must deliver the event
   * with this exact timestamp, so a re-save (new occurrence) or a
   * contact-data change invalidates the preview.
   */
  occurrenceTimeIso: string;
  /** SHA-256 match hashes included in the payload (never raw data). */
  matchEm: readonly string[];
  matchPh: readonly string[];
}

/**
 * Server-generated preview id: a stable fingerprint of everything a
 * manual send depends on. The send endpoint recomputes it from live
 * DB state and rejects mismatches (HTTP 409 + fresh preview), so a
 * preview can never be replayed after the lead, dataset, event
 * mapping, occurrence time, or match data changed underneath it.
 * No Meta-facing `event_id` exists anymore — staleness is checked
 * on the inputs above; the ledger `event_uuid` stays internal and
 * is never part of the fingerprint or the payload.
 */
export function buildLeadQualityPreviewId(
  fingerprint: LeadQualityPreviewFingerprint,
): string {
  // Canonical key order keeps the fingerprint stable for identical
  // inputs. cyrb53 (public-domain, dependency-free) is plenty for
  // a staleness check — it is NOT a security boundary, only a
  // change detector. Pure JS so this module stays importable from
  // client components (the tooltip lives here too).
  const canonical = JSON.stringify({
    accountId: fingerprint.accountId,
    datasetId: fingerprint.datasetId,
    eventName: fingerprint.eventName,
    flowId: fingerprint.flowId,
    matchEm: [...fingerprint.matchEm],
    matchPh: [...fingerprint.matchPh],
    metaLeadId: fingerprint.metaLeadId,
    occurrenceTimeIso: fingerprint.occurrenceTimeIso,
    runId: fingerprint.runId,
    toQuality: fingerprint.toQuality,
  });
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < canonical.length; i++) {
    const ch = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
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
 * event — retries resend the identical stored payload (same
 * occurrence, same transition), and the ledger guarantees a row is
 * only ever delivered while pending.
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
      // The exact outgoing body: event objects wrapped in the
      // documented top-level `data` array, lead_id numerically
      // serialized only when exactly representable.
      body: serializeCrmRequestBody(buildCrmRequestBody(args.payload)),
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
