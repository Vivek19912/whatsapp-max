// ============================================================
// Meta Lead Ads — server-side configuration.
//
// The integration is DISABLED unless every credential below is
// present in the server environment. Nothing is hardcoded: the
// Graph API version MUST be supplied via META_GRAPH_VERSION so a
// deployment can pin a current, supported version — we never ship
// a baked-in (and eventually outdated) version string.
//
// Required env (set in the deployment / secrets manager, NEVER in
// the browser bundle):
//   META_LEAD_ADS_APP_ID            — the Meta App's numeric App ID
//   META_LEAD_ADS_APP_SECRET        — the Meta App Secret (server only)
//   META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN
//                                   — the token you type into the App
//                                     Dashboard webhook config; used to
//                                     answer Meta's GET challenge
//   META_GRAPH_VERSION              — e.g. "v21.0" (see docs/meta-lead-ads.md)
//
// The App Secret is also used to validate the X-Hub-Signature-256
// header on inbound leadgen webhooks (HMAC-SHA256 over the raw body).
// ============================================================

/** Permissions required for Page discovery, form listing, lead retrieval
 *  and webhook subscription. Requested incrementally at consent time. */
export const META_LEAD_ADS_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "leads_retrieval",
  "business_management",
] as const;

/** Graph API versions look like v21.0 — reject anything else so a
 *  misconfigured value can never be spliced into a Graph URL. */
const GRAPH_VERSION_PATTERN = /^v\d+\.\d+$/;

export interface MetaLeadAdsConfig {
  appId: string;
  appSecret: string;
  webhookVerifyToken: string;
  graphVersion: string;
}

/**
 * Resolve the integration config from the environment. Returns null
 * when any required value is missing or the Graph version is
 * malformed — callers treat null as "not configured" (501) rather
 * than guessing.
 */
export function metaLeadAdsConfig(
  env: NodeJS.ProcessEnv = process.env,
): MetaLeadAdsConfig | null {
  const appId = env.META_LEAD_ADS_APP_ID?.trim();
  const appSecret = env.META_LEAD_ADS_APP_SECRET?.trim();
  const webhookVerifyToken = env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN?.trim();
  const graphVersion = env.META_GRAPH_VERSION?.trim();

  if (!appId || !appSecret || !webhookVerifyToken || !graphVersion) {
    return null;
  }
  if (!GRAPH_VERSION_PATTERN.test(graphVersion)) {
    return null;
  }
  return { appId, appSecret, webhookVerifyToken, graphVersion };
}

export function metaLeadAdsConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return metaLeadAdsConfig(env) !== null;
}

/**
 * The validated Graph API version on its own. Conversions API only
 * needs the version — it never uses the platform Lead Ads App
 * Secret (a customer's System User token may belong to a different
 * Meta app), so it must not be gated on those credentials.
 */
export function metaGraphVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const graphVersion = env.META_GRAPH_VERSION?.trim();
  if (!graphVersion || !GRAPH_VERSION_PATTERN.test(graphVersion)) return null;
  return graphVersion;
}

/** Graph host root for the configured version, e.g. https://graph.facebook.com/v21.0 */
export function graphBase(graphVersion: string): string {
  return `https://graph.facebook.com/${graphVersion}`;
}

/** OAuth dialog host (same versioned base). */
export function oauthBase(graphVersion: string): string {
  return `https://www.facebook.com/${graphVersion}/dialog/oauth`;
}

/**
 * Build the OAuth redirect URI from the incoming request origin.
 * Must be whitelisted in the Meta App Dashboard as a Valid OAuth
 * Redirect URI: `{origin}/api/integrations/meta-lead-ads/callback`.
 */
export function redirectUriFromRequest(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  const base = explicit
    ? explicit.replace(/\/$/, "")
    : originFromHeaders(request);
  return `${base}/api/integrations/meta-lead-ads/callback`;
}

function originFromHeaders(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return `${proto}://${host}`;
}
