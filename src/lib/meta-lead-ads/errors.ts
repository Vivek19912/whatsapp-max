// ============================================================
// Meta Lead Ads — error taxonomy.
//
// A single error family so routes can map failures to stable HTTP
// codes and user-facing messages without leaking tokens or raw
// Graph payloads. Messages are deliberately generic; the
// machine-readable `code` is what the UI/telemetry key off.
// ============================================================

export type MetaLeadAdsErrorCode =
  | "not_configured"
  | "bad_state"
  | "expired_state"
  | "account_mismatch"
  | "exchange_failed"
  | "needs_reauth"
  | "permission_denied"
  | "rate_limited"
  | "graph_error"
  | "page_not_found"
  | "form_not_enabled"
  | "no_phone"
  | "db_error"
  | "unknown";

export class MetaLeadAdsError extends Error {
  readonly code: MetaLeadAdsErrorCode;
  readonly status: number;

  constructor(code: MetaLeadAdsErrorCode, message: string, status = 400) {
    super(message);
    this.name = "MetaLeadAdsError";
    this.code = code;
    this.status = status;
  }
}

/** A non-OK response from the Meta Graph API (or an invalid token). */
export class MetaGraphError extends MetaLeadAdsError {
  readonly graphStatus?: number;
  readonly graphType?: string;
  readonly graphCode?: number;
  readonly graphSubcode?: number;

  constructor(args: {
    code?: MetaLeadAdsErrorCode;
    message: string;
    status?: number;
    graphStatus?: number;
    graphType?: string;
    graphCode?: number;
    graphSubcode?: number;
  }) {
    super(args.code ?? "graph_error", args.message, args.status ?? 502);
    this.name = "MetaGraphError";
    this.graphStatus = args.graphStatus;
    this.graphType = args.graphType;
    this.graphCode = args.graphCode;
    this.graphSubcode = args.graphSubcode;
  }
}

/**
 * Graph error codes that mean the TOKEN itself is invalid, expired or
 * revoked. These are the only codes that justify marking the stored
 * credential as needing reauthorization.
 */
const AUTH_GRAPH_CODES = new Set([102, 190, 463]);

export function isAuthGraphCode(code: number | undefined): boolean {
  return code !== undefined && AUTH_GRAPH_CODES.has(code);
}

/**
 * True for Graph errors that mean the token is no longer usable and
 * the account must re-authorize.
 *
 * The Graph `code` is authoritative. Meta labels MANY unrelated
 * failures as `type: "OAuthException"` — including `#100` invalid
 * field/parameter errors and `#200` permission errors — so the type
 * alone must NEVER be treated as a dead token. When Meta returns no
 * code at all, an OAuthException or an HTTP 401 is still treated as an
 * authentication failure.
 */
export function isAuthGraphError(err: unknown): boolean {
  if (!(err instanceof MetaGraphError)) return false;
  if (err.graphCode !== undefined) return isAuthGraphCode(err.graphCode);
  if (err.graphType === "OAuthException") return true;
  return err.graphStatus === 401;
}

/**
 * Actionable, secret-free description of a Graph failure for the
 * Settings UI. Distinguishes a dead token, a valid-but-unauthorized
 * token, and a missing/unreachable asset so the customer knows exactly
 * what to fix in Meta Business Settings. Never includes the token,
 * App Secret or proof.
 */
export function describeMetaGraphError(err: unknown): string {
  if (err instanceof MetaGraphError) {
    if (isAuthGraphError(err)) {
      return (
        "Meta rejected the access token (invalid, expired, or revoked). " +
        "Generate a new System User token with access to this Page and dataset, then paste it again."
      );
    }
    if (err.code === "rate_limited") {
      return "Meta rate limit reached. Wait a minute and try again.";
    }
    if (err.graphCode === 200 || err.graphCode === 10) {
      return (
        "The token is valid but is not authorized for this asset. In Meta Business Settings, " +
        "assign this Page and dataset to the System User, then try again."
      );
    }
    if (err.graphCode === 100) {
      const field = /nonexisting field \(([^)]+)\)/i.exec(err.message)?.[1];
      return field
        ? `Meta rejected the request field "${field}" — it is not valid for this endpoint. ` +
            "This is not a token problem; no need to regenerate the token."
        : `Meta rejected a request parameter. ${err.message} ` +
            "This is not a token problem; no need to regenerate the token.";
    }
    if (err.graphCode === 803) {
      return (
        "Meta could not find that ID, or the token cannot access it. " +
        "Double-check the numeric ID and the System User's asset assignment."
      );
    }
    return err.message;
  }
  if (err instanceof MetaLeadAdsError) return err.message;
  return "Could not reach Meta.";
}
