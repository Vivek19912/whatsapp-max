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
// The primary onboarding flow is per-tenant Facebook Login (OAuth):
// the customer authorizes their own Pages through the shared app.
// The legacy manual System User token path remains available, but a
// foreign-app token cannot install our shared webhook app.
//
// The App Secret is also used to validate the X-Hub-Signature-256
// header on inbound leadgen webhooks (HMAC-SHA256 over the raw body).
// ============================================================

/** Permissions required for Page discovery, Instant Form/lead
 *  retrieval and Page-level leadgen webhook installation.
 *
 *  `ads_management` is required by Meta's leadgen webhook docs in
 *  addition to `pages_manage_metadata`; `pages_show_list` and
 *  `pages_read_engagement` cover discovery/forms. These permissions
 *  need Advanced Access/App Review before public SaaS onboarding. */
export const META_LEAD_ADS_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "leads_retrieval",
  "ads_management",
] as const;

/** Space-separated scope string for the OAuth dialog. */
export function metaLeadAdsScopeString(): string {
  return META_LEAD_ADS_SCOPES.join(" ");
}

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

/** App access token used only for app-level diagnostics (never logged). */
export function appAccessToken(config: MetaLeadAdsConfig): string {
  return `${config.appId}|${config.appSecret}`;
}
