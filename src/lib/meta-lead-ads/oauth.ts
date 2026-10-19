// ============================================================
// Meta Lead Ads — per-tenant OAuth handshake helpers.
//
// Facebook Login is used as a server-side authorization-code flow:
// an admin starts from their own workspace, Meta redirects back with
// a one-time code, and the server exchanges it with the app secret.
// The destination account is never accepted from the callback.
//
// CSRF and account binding are enforced with:
//   * a cryptographically random one-time `state` stored by hash;
//   * a same-site HttpOnly browser cookie carrying the raw state;
//   * a required match between the stored state account/user and the
//     authenticated callback caller.
//
// PKCE is intentionally not implemented: the selected web
// authorization-code flow authenticates the confidential server
// client with `client_secret`, binds the grant to an explicit
// redirect URI, and uses a single-use hashed state for CSRF.
// ============================================================

import crypto from "node:crypto";

import {
  metaLeadAdsScopeString,
  type MetaLeadAdsConfig,
} from "./config";

export const META_LEAD_OAUTH_STATE_COOKIE = "wacrm_meta_lead_oauth_state";
export const META_LEAD_OAUTH_CALLBACK_PATH =
  "/api/integrations/meta-lead-ads/oauth/callback";
export const META_LEAD_OAUTH_STATE_TTL_MS = 10 * 60_000;
export const META_LEAD_OAUTH_SESSION_TTL_MS = 15 * 60_000;

/** Cryptographically random OAuth state (base64url, 256 bits). */
export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Hash raw state for database storage. Raw state is never persisted. */
export function hashOAuthState(state: string): string {
  return crypto.createHash("sha256").update(state, "utf8").digest("hex");
}

/** Constant-time raw-state comparison that is safe for length mismatch. */
export function oauthStatesMatch(first: string, second: string): boolean {
  const a = Buffer.from(first, "utf8");
  const b = Buffer.from(second, "utf8");
  return (
    a.length === b.length &&
    a.length > 0 &&
    crypto.timingSafeEqual(a, b)
  );
}

/** Application origin for callbacks and redirects. */
export function siteOriginFromRequest(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return `${proto}://${host}`;
}

export function oauthRedirectUriFromRequest(request: Request): string {
  return `${siteOriginFromRequest(request)}${META_LEAD_OAUTH_CALLBACK_PATH}`;
}

/** Meta OAuth authorization URL. Contains no secrets. */
export function buildOAuthDialogUrl(
  config: MetaLeadAdsConfig,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: metaLeadAdsScopeString(),
    state,
  });
  return `https://www.facebook.com/${config.graphVersion}/dialog/oauth?${params.toString()}`;
}

export type OAuthRedirectStatus =
  | "select"
  | "cancelled"
  | "error";

const SAFE_STATUS: ReadonlySet<OAuthRedirectStatus> = new Set([
  "select",
  "cancelled",
  "error",
]);

const SAFE_REASONS = new Set([
  "missing_code",
  "invalid_state",
  "account_mismatch",
  "token_exchange_failed",
  "invalid_token",
  "wrong_app",
  "page_discovery_failed",
  "session_failed",
  "unexpected",
]);

/** Safe redirect back to Meta settings. Untrusted reasons are rejected. */
export function oauthSettingsRedirect(
  request: Request,
  status: OAuthRedirectStatus,
  reason?: string,
): URL {
  const url = new URL("/settings", siteOriginFromRequest(request));
  url.searchParams.set("tab", "meta-lead-ads");
  url.searchParams.set("meta_oauth", SAFE_STATUS.has(status) ? status : "error");
  if (reason && SAFE_REASONS.has(reason)) {
    url.searchParams.set("meta_oauth_error", reason);
  }
  return url;
}

/** True for Meta authorization-cancellation callbacks. */
export function isOAuthCancellation(value: string | null): boolean {
  return value === "access_denied" || value === "user_denied";
}

/** Normalize/validate explicitly selected page ids from the request body. */
export function normalizeSelectedPageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const pageId = entry.trim();
    if (!/^\d{5,32}$/.test(pageId)) continue;
    seen.add(pageId);
    if (seen.size >= 25) break;
  }
  return [...seen];
}
