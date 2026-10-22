// ============================================================
// Meta CAPI stored responses — capture, sanitize, and normalize.
//
// The delivery ledger keeps the COMPLETE Meta response body per
// attempt (success or failure) in `response_payload`, so Recent
// Deliveries can show the exact Graph answer without ever
// re-calling Meta. Shapes:
//
//   new failure writes : { httpStatus: number | null, body: unknown }
//   legacy success rows: the raw Graph body (e.g. { events_received,
//                        fbtrace_id, ... }) with no envelope.
//
// `normalizeStoredResponse` accepts both, so historical rows keep
// rendering. Nothing here touches credentials: the stored value is
// only ever built from Meta's response (which never contains our
// tokens), and credential-looking keys are redacted defensively.
// Pure and dependency-free — unit tested directly.
// ============================================================

export interface StoredMetaResponse {
  httpStatus: number | null;
  body: unknown;
}

/** Keys that must never reach the browser, matched case-insensitively
 *  (exact or as a contiguous substring — Meta error bodies never
 *  legitimately carry these). */
const SENSITIVE_KEY_PARTS = [
  "access_token",
  "appsecret",
  "app_secret",
  "client_secret",
  "password",
  "secret",
];

const REDACTED = "[redacted]";

function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lowered.includes(part));
}

/**
 * Deep-clone a Meta response body with credential-looking fields
 * redacted. Preserves every other field verbatim — arrays, nesting,
 * long messages, and unknown Graph fields all survive intact.
 * Returns null for values that JSON cannot represent.
 */
export function sanitizeResponseBody(value: unknown, seen = new Set<unknown>()): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") return null;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResponseBody(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeResponseBody(entry, seen);
  }
  return out;
}

/** Envelope for a freshly captured Meta HTTP exchange. */
export function toStoredResponse(
  httpStatus: number | null,
  body: unknown,
): StoredMetaResponse {
  return { httpStatus, body: sanitizeResponseBody(body) };
}

/**
 * Totally defensive extraction of a complete, storable response
 * from anything a delivery attempt can throw. Never throws, never
 * leaks tokens (the message/credential search below only ever
 * reads Meta's error shape), and always returns a value so failed
 * deliveries keep their diagnostic body.
 */
export function buildFailureResponse(err: unknown): StoredMetaResponse {
  if (err !== null && typeof err === "object") {
    const maybe = err as { graphStatus?: unknown; graphBody?: unknown };
    // Only the Graph-reported HTTP status counts — never a generic
    // library status code, which would mislabel the exchange.
    const httpStatus =
      typeof maybe.graphStatus === "number" ? maybe.graphStatus : null;
    if (maybe.graphBody !== undefined) {
      return toStoredResponse(httpStatus, maybe.graphBody);
    }
  }
  if (err instanceof Error) {
    return toStoredResponse(null, { message: err.message });
  }
  return toStoredResponse(null, { message: String(err) });
}

/**
 * Normalize a stored `response_payload` for display. Accepts the
 * current envelope shape and legacy raw bodies (pre-envelope
 * success rows). Returns null when there is nothing to show.
 */
export function normalizeStoredResponse(
  stored: unknown,
): StoredMetaResponse | null {
  if (stored === null || stored === undefined) return null;
  if (
    typeof stored === "object" &&
    !Array.isArray(stored) &&
    "httpStatus" in (stored as Record<string, unknown>) &&
    "body" in (stored as Record<string, unknown>)
  ) {
    const envelope = stored as { httpStatus?: unknown; body?: unknown };
    return {
      httpStatus: typeof envelope.httpStatus === "number" ? envelope.httpStatus : null,
      body: envelope.body ?? null,
    };
  }
  if (typeof stored === "object" || typeof stored === "string") {
    return { httpStatus: null, body: stored };
  }
  return null;
}
