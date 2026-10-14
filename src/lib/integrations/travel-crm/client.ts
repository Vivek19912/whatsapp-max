// ============================================================
// Travel CRM server-to-server client (Phase 3: WACRM side).
//
// Server-only: the Bearer secret lives in function arguments and
// request headers — never in errors, logs, or responses (tests
// assert this). All Travel CRM failures surface as TravelCrmError
// with a stable machine code; callers map codes to UI copy.
//
// Contract (audited Travel CRM Phase-2 implementation):
//   POST {base}/api/integrations/wacrm/leads
//   Authorization: Bearer wacrm_<secret>
//   → { success: true, data: { leadId, alreadyExists } }
//   GET  {base}/api/integrations/wacrm/lookups (same auth)
//   → { success: true, data: { ... } }
//   GET  {base}/api/integrations/wacrm/leads/:id (same auth)
//   → { success: true, data: { exists, leadId } } — always 200 when
//   authorized (a missing or foreign-tenant lead reads exists:false,
//   never an error), so callers can tell confirmed absence apart
//   from transport/auth failures, which throw TravelCrmError.
// The lookups GET accepts an optional `assignedToEmail` query locator
// (the calling account's owner email, resolved server-side): Travel
// CRM uses it for first-use credential association when no credential
// row exists yet. The secret itself always travels ONLY in the
// Authorization header — never in the URL, query, or body.
// ============================================================

export type TravelCrmErrorCode =
  | "TRAVEL_CRM_UNAUTHORIZED"
  | "TRAVEL_CRM_VALIDATION_FAILED"
  | "TRAVEL_CRM_CONFLICT"
  | "TRAVEL_CRM_UNAVAILABLE"
  | "TRAVEL_CRM_ERROR"
  | "ASSIGNED_USER_NOT_FOUND";

export class TravelCrmError extends Error {
  readonly code: TravelCrmErrorCode;
  readonly status?: number;
  readonly fields?: Record<string, string[]>;
  constructor(
    code: TravelCrmErrorCode,
    message: string,
    opts?: { status?: number; fields?: Record<string, string[]> },
  ) {
    super(message);
    this.name = "TravelCrmError";
    this.code = code;
    this.status = opts?.status;
    this.fields = opts?.fields;
  }
}

export interface TravelCrmItineraryInput {
  country: string;
  destination: string;
  nights: number;
  sequence: number;
}

/** WACRM draft fields sent to Travel CRM (mirrors its payload schema). */
export interface TravelCrmCreatePayload {
  wacrmAccountId: string;
  flowRunId: string;
  customerName: string;
  phone: string;
  email?: string | null;
  leadSource: string;
  leadType: string;
  leadStage: string;
  assignedToEmail: string;
  dateOfBirth?: string | null;
  travelStartDate?: string | null;
  /** Month-based timing (both set or both null; never with a date). */
  travelMonth?: number | null;
  travelYear?: number | null;
  departureCountry?: string | null;
  departureCity?: string | null;
  rooms?: number | null;
  adults?: number | null;
  childrenWithBed?: number | null;
  childrenWithoutBed?: number | null;
  infants?: number | null;
  /** Optional per-child ages (Travel CRM lead-form age arrays). */
  childrenWithBedAges?: number[];
  childrenWithoutBedAges?: number[];
  infantAges?: number[];
  services: string[];
  itinerary: TravelCrmItineraryInput[];
}

export interface TravelCrmCreateResult {
  leadId: string;
  alreadyExists: boolean;
}

const TIMEOUT_MS = 30_000;

interface TravelCrmEnvelope {
  success?: boolean;
  data?: { leadId?: unknown; alreadyExists?: unknown };
  error?: { code?: unknown; message?: unknown; fields?: unknown };
}

function toFields(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map(String);
    else if (v != null) out[k] = [String(v)];
  }
  return out;
}

async function readEnvelope(res: Response): Promise<TravelCrmEnvelope | null> {
  try {
    const json = (await res.json()) as TravelCrmEnvelope;
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

export async function createTravelCrmLead(
  baseUrl: string,
  secret: string,
  payload: TravelCrmCreatePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<TravelCrmCreateResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/integrations/wacrm/leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TravelCrmError(
      "TRAVEL_CRM_UNAVAILABLE",
      err instanceof Error && err.name === "AbortError"
        ? "Travel CRM request timed out."
        : "Travel CRM is unreachable.",
    );
  }

  const body = await readEnvelope(res);
  if (res.ok) {
    const leadId = body?.data?.leadId;
    if (typeof leadId === "string" && leadId) {
      return { leadId, alreadyExists: body?.data?.alreadyExists === true };
    }
    throw new TravelCrmError(
      "TRAVEL_CRM_ERROR",
      "Travel CRM returned an unreadable success response.",
      { status: res.status },
    );
  }

  const code = body?.error?.code;
  const message =
    typeof body?.error?.message === "string" && body.error.message
      ? body.error.message
      : "Travel CRM rejected the request.";
  const fields = toFields(body?.error?.fields);
  if (res.status === 401) {
    throw new TravelCrmError("TRAVEL_CRM_UNAUTHORIZED", "Travel CRM rejected the integration credential.", {
      status: 401,
    });
  }
  if (code === "ASSIGNED_USER_NOT_FOUND") {
    throw new TravelCrmError("ASSIGNED_USER_NOT_FOUND", message, { status: res.status, fields });
  }
  if (res.status === 409) {
    throw new TravelCrmError("TRAVEL_CRM_CONFLICT", message, { status: 409, fields });
  }
  if (res.status === 400) {
    throw new TravelCrmError("TRAVEL_CRM_VALIDATION_FAILED", message, { status: 400, fields });
  }
  if (res.status >= 500) {
    throw new TravelCrmError("TRAVEL_CRM_UNAVAILABLE", "Travel CRM is unavailable.", {
      status: res.status,
    });
  }
  throw new TravelCrmError("TRAVEL_CRM_ERROR", message, { status: res.status, fields });
}

export interface LookupOption {
  value: string;
  label: string;
}

/**
 * Pull `{value,label}[]` options for one lookups key. Returns null
 * when the shape is unusable — callers fall back to free input and
 * let Travel CRM validate authoritatively.
 */
export function extractLookupOptions(
  data: Record<string, unknown>,
  key: string,
): LookupOption[] | null {
  const raw = data[key];
  if (!Array.isArray(raw)) return null;
  const out: LookupOption[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item) out.push({ value: item, label: item });
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (typeof rec.value === "string" && rec.value) {
        out.push({
          value: rec.value,
          label: typeof rec.label === "string" && rec.label ? rec.label : rec.value,
        });
      }
    }
  }
  return out;
}

export async function fetchTravelCrmLookups(
  baseUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
  opts: { ownerEmail?: string | null } = {},
): Promise<Record<string, unknown>> {
  const ownerEmail =
    typeof opts.ownerEmail === "string" && opts.ownerEmail.trim() ? opts.ownerEmail.trim() : null;
  const url =
    ownerEmail !== null
      ? `${baseUrl}/api/integrations/wacrm/lookups?assignedToEmail=${encodeURIComponent(ownerEmail)}`
      : `${baseUrl}/api/integrations/wacrm/lookups`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TravelCrmError(
      "TRAVEL_CRM_UNAVAILABLE",
      err instanceof Error && err.name === "AbortError"
        ? "Travel CRM request timed out."
        : "Travel CRM is unreachable.",
    );
  }
  if (res.status === 401) {
    throw new TravelCrmError("TRAVEL_CRM_UNAUTHORIZED", "Travel CRM rejected the integration credential.", {
      status: 401,
    });
  }
  const body = await readEnvelope(res);
  if (!res.ok || !body || typeof body.data !== "object" || body.data === null) {
    throw new TravelCrmError("TRAVEL_CRM_ERROR", "Travel CRM returned unreadable lookups.", {
      status: res.status,
    });
  }
  return body.data as Record<string, unknown>;
}

/**
 * Tenant-scoped lead-existence probe for stale-link recovery.
 * Returns the linked lead's existence in the locator-scoped
 * company; only an explicit `exists: false` proves absence.
 * Transport errors, 401s, and unreadable bodies throw
 * TravelCrmError — callers must treat those as inconclusive and
 * keep the stored association (never clear on ambiguity).
 */
export async function verifyTravelCrmLead(
  baseUrl: string,
  secret: string,
  leadId: string,
  fetchImpl: typeof fetch = fetch,
  opts: { ownerEmail?: string | null } = {},
): Promise<{ exists: boolean; leadId: string }> {
  const ownerEmail =
    typeof opts.ownerEmail === "string" && opts.ownerEmail.trim() ? opts.ownerEmail.trim() : null;
  const url =
    ownerEmail !== null
      ? `${baseUrl}/api/integrations/wacrm/leads/${encodeURIComponent(leadId)}?ownerEmail=${encodeURIComponent(ownerEmail)}`
      : `${baseUrl}/api/integrations/wacrm/leads/${encodeURIComponent(leadId)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TravelCrmError(
      "TRAVEL_CRM_UNAVAILABLE",
      err instanceof Error && err.name === "AbortError"
        ? "Travel CRM request timed out."
        : "Travel CRM is unreachable.",
    );
  }
  if (res.status === 401) {
    throw new TravelCrmError("TRAVEL_CRM_UNAUTHORIZED", "Travel CRM rejected the integration credential.", {
      status: 401,
    });
  }
  const body = await readEnvelope(res);
  const data = body && typeof body.data === "object" && body.data !== null
    ? (body.data as Record<string, unknown>)
    : null;
  if (!res.ok || !body || data === null || typeof data.exists !== "boolean") {
    throw new TravelCrmError("TRAVEL_CRM_ERROR", "Travel CRM returned unreadable lead verification.", {
      status: res.status,
    });
  }
  return { exists: data.exists, leadId };
}
