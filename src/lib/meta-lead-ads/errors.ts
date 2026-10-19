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
 * True for Graph errors that mean the token is no longer usable and
 * the account must re-authorize. Meta returns these as OAuthException
 * type=OAuthException, code 190 (with various subcodes), or a 401.
 */
export function isAuthGraphError(err: unknown): boolean {
  if (!(err instanceof MetaGraphError)) return false;
  if (err.graphStatus === 401) return true;
  if (err.graphType === "OAuthException") return true;
  return err.graphCode === 190 || err.graphCode === 102 || err.graphCode === 463;
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
    if (err.graphCode === 100 || err.graphCode === 803) {
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
