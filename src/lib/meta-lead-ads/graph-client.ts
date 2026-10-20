// ============================================================
// Meta Lead Ads — Graph API client.
//
// Thin REST wrapper (no SDK) over the versioned Graph host
// configured via META_GRAPH_VERSION and maps Graph error bodies onto
// the shared error taxonomy.
//
// appsecret_proof: the manually-pasted System User token may belong
// to a DIFFERENT Meta app than the platform app whose secret lives in
// META_LEAD_ADS_APP_SECRET. Computing a proof with the wrong secret
// makes every call fail with "Invalid appsecret_proof" (the same bug
// we fixed for the Conversions API). We therefore send a proof only
// when the caller explicitly supplies the matching appSecret; by
// default the token alone authenticates the call, which Meta accepts.
//
// Rate limiting: 429 / usage-limit Graph codes are retried with
// BOUNDED exponential backoff (max attempt count + cap) and then
// surfaced as `rate_limited`; we never retry unbounded.
// ============================================================

import crypto from "node:crypto";

import { appAccessToken, graphBase, type MetaLeadAdsConfig } from "./config";
import { MetaGraphError, isAuthGraphCode, isAuthGraphError } from "./errors";

/** appsecret_proof = HMAC-SHA256(accessToken, appSecret) hex. */
export function appSecretProof(appSecret: string, accessToken: string): string {
  return crypto.createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

export interface GraphRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  params?: Record<string, string | number | boolean | undefined | null>;
  /** Access token to authenticate the call (user or page token). */
  token?: string;
  /**
   * App Secret that issued `token`. When supplied, an
   * `appsecret_proof` is sent. Never pass the platform App Secret for
   * a customer token that belongs to another Meta app.
   */
  appSecret?: string | null;
  config: MetaLeadAdsConfig;
  /** Bounded retry attempts for rate-limit / 5xx (default 3). */
  maxAttempts?: number;
  /** Base backoff in ms (default 500); tests pass 0. */
  backoffBaseMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

const RATE_LIMIT_GRAPH_CODES = new Set([4, 17, 32, 613]);
const MAX_BACKOFF_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

/**
 * Perform a Graph request, retrying rate-limit/5xx responses with
 * bounded backoff. Throws MetaGraphError on any non-recoverable
 * failure. Never logs tokens or response bodies containing PII.
 */
export async function graphRequest<T = Record<string, unknown>>(
  path: string,
  options: GraphRequestOptions,
): Promise<T> {
  const {
    method = "GET",
    params = {},
    token,
    appSecret,
    config,
    maxAttempts = 3,
    backoffBaseMs = 500,
    fetchImpl = fetch,
  } = options;

  const url = new URL(`${graphBase(config.graphVersion)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  if (token) {
    url.searchParams.set("access_token", token);
    if (appSecret) {
      url.searchParams.set("appsecret_proof", appSecretProof(appSecret, token));
    }
  }

  let lastError: MetaGraphError | null = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { method });
    } catch (err) {
      // Network failure — retry within bounds.
      lastError = new MetaGraphError({
        code: "graph_error",
        message: "Could not reach the Meta Graph API.",
        graphStatus: undefined,
      });
      if (attempt < maxAttempts) {
        await sleep(Math.min(backoffBaseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS));
        continue;
      }
      void err;
      break;
    }

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    const errorBody = (body as GraphErrorBody | null)?.error;

    if (res.ok && !errorBody) {
      return (body ?? {}) as T;
    }

    const retryable =
      res.status === 429 ||
      res.status >= 500 ||
      (errorBody?.code !== undefined && RATE_LIMIT_GRAPH_CODES.has(errorBody.code));

    // Classify by Meta's code, never by HTTP status or the error `type`
    // alone: Meta returns `OAuthException` for non-auth failures such as
    // #100 (invalid field) and #200 (missing permission).
    const authFailure =
      errorBody?.code !== undefined
        ? isAuthGraphCode(errorBody.code)
        : errorBody?.type === "OAuthException" || res.status === 401;
    const rateLimited =
      errorBody?.code !== undefined && RATE_LIMIT_GRAPH_CODES.has(errorBody.code);

    lastError = new MetaGraphError({
      code: rateLimited ? "rate_limited" : "graph_error",
      message: errorBody?.message ?? `Meta Graph request failed (${res.status}).`,
      status: authFailure
        ? 401
        : rateLimited
          ? 429
          : res.status >= 500
            ? 502
            : 400,
      graphStatus: res.status,
      graphType: errorBody?.type,
      graphCode: errorBody?.code,
      graphSubcode: errorBody?.error_subcode,
    });

    if (retryable && attempt < maxAttempts) {
      await sleep(Math.min(backoffBaseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS));
      continue;
    }
    break;
  }

  throw lastError ?? new MetaGraphError({ message: "Meta Graph request failed." });
}

// ---------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------

export interface MetaPage {
  id: string;
  name?: string;
  access_token?: string;
}

/**
 * Read one Page by id. Manual setup pastes the Page id instead of
 * discovering Pages through `/me/accounts` (a System User token
 * generally cannot list a user's Pages). Requesting `access_token`
 * yields a Page token when the token can act on the Page; when Meta
 * omits it the caller falls back to the pasted token.
 *
 * Only fields that exist on the Page NODE are requested. `tasks` is a
 * field of the `/me/accounts` USER edge, NOT the Page node, and asking
 * for it here makes Graph reject the whole call with
 * "#100 Tried accessing nonexistent field (tasks)". Never add it back.
 */
export async function getPage(
  config: MetaLeadAdsConfig,
  token: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<MetaPage> {
  return graphRequest<MetaPage>(`/${pageId}`, {
    config,
    token,
    params: { fields: "id,name,access_token" },
    ...opts,
  });
}

/** Read a Dataset/Pixel id to confirm the token can reach it. */
export async function getDataset(
  config: MetaLeadAdsConfig,
  token: string,
  datasetId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<{ id: string; name?: string }> {
  return graphRequest<{ id: string; name?: string }>(`/${datasetId}`, {
    config,
    token,
    params: { fields: "id,name" },
    ...opts,
  });
}

export interface MetaForm {
  id: string;
  name?: string;
  status?: string;
  locale?: string;
}

/** Extract the `after` cursor from a full `paging.next` URL. */
function cursorFromNextUrl(next: string): string | null {
  try {
    return new URL(next).searchParams.get("after");
  } catch {
    return null;
  }
}

/**
 * List the Page's Instant Forms, following pagination up to a bound.
 * A single call returns up to 100 forms; a Page with more must be
 * walked, otherwise `Load My Forms` would silently hide forms.
 */
export async function listForms(
  config: MetaLeadAdsConfig,
  pageToken: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> & { maxPages?: number } = {},
): Promise<MetaForm[]> {
  const { maxPages = 10, ...rest } = opts;
  const forms: MetaForm[] = [];
  let after: string | null = null;

  for (let page = 0; page < Math.max(1, maxPages); page += 1) {
    const data: {
      data?: MetaForm[];
      paging?: { cursors?: { after?: string }; next?: string };
    } = await graphRequest<{
      data?: MetaForm[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`/${pageId}/leadgen_forms`, {
      config,
      token: pageToken,
      params: { fields: "id,name,status,locale", limit: 100, after: after ?? undefined },
      ...rest,
    });

    const batch: MetaForm[] = data.data ?? [];
    forms.push(...batch);

    const next: string | null =
      data.paging?.cursors?.after ??
      (data.paging?.next ? cursorFromNextUrl(data.paging.next) : null);
    if (!next || batch.length === 0) break;
    after = next;
  }

  return forms;
}

/**
 * Confirm the token can actually READ leads for a form. Listing forms
 * does not prove lead access (a token can see a form but not its
 * submissions), so Save & verify probes the first form explicitly.
 * Returns true when Meta answers with a (possibly empty) lead list.
 */
export async function probeFormLeadAccess(
  config: MetaLeadAdsConfig,
  pageToken: string,
  formId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<boolean> {
  const data = await graphRequest<{ data?: unknown[] }>(`/${formId}/leads`, {
    config,
    token: pageToken,
    params: { fields: "id", limit: 1 },
    ...opts,
  });
  return Array.isArray(data.data);
}

/**
 * A multiple-choice option on a Meta Instant Form question. Per
 * Meta's leadgen_forms reference, `value` is the text shown to the
 * person filling the form and `key` is the short unique identifier
 * (also what lands in the lead's `field_data` values) — so display
 * resolution matches submitted values against `key`, never the
 * other way round.
 */
export interface MetaFormQuestionOption {
  key?: string;
  value?: string;
}

export interface MetaFormQuestion {
  key?: string;
  label?: string;
  type?: string;
  options?: MetaFormQuestionOption[];
}

export interface MetaFormDetail {
  id: string;
  name?: string;
  status?: string;
  locale?: string;
  questions?: MetaFormQuestion[];
}

export async function getForm(
  config: MetaLeadAdsConfig,
  pageToken: string,
  formId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<MetaFormDetail> {
  return graphRequest<MetaFormDetail>(`/${formId}`, {
    config,
    token: pageToken,
    params: { fields: "id,name,status,locale,questions" },
    ...opts,
  });
}

export interface MetaLeadFieldDatum {
  name?: string;
  values?: string[];
}

export interface MetaLeadDetail {
  id: string;
  created_time?: string;
  field_data?: MetaLeadFieldDatum[];
  form_id?: string;
  platform?: string;
  ad_id?: string;
  ad_name?: string;
  campaign_name?: string;
  is_organic?: boolean;
}

// Fields that exist on the Lead NODE only. `page_id` looks plausible but
// is NOT part of the Lead object: requesting it makes Graph answer
// `(#100) Tried accessing nonexisting field (page_id)` and the whole
// fetch fails, so a lead is recorded but never becomes a Workspace run.
// The Page is already known from the form/submission; never re-request it.
const LEAD_FIELDS =
  "id,created_time,field_data,form_id,platform,ad_id,ad_name,campaign_name,is_organic";

export async function getLead(
  config: MetaLeadAdsConfig,
  pageToken: string,
  leadId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<MetaLeadDetail> {
  return graphRequest<MetaLeadDetail>(`/${leadId}`, {
    config,
    token: pageToken,
    params: {
      fields: LEAD_FIELDS,
    },
    ...opts,
  });
}

export interface MetaLeadListPage {
  leads: MetaLeadDetail[];
  nextCursor: string | null;
}

/**
 * List the leads already stored for one Instant Form. Used for the
 * historical import (walk pages with `after`) and for the polling
 * fallback when the leadgen webhook is not subscribed. Idempotency is
 * enforced downstream by `meta_lead_submissions`' unique key.
 */
export async function listFormLeads(
  config: MetaLeadAdsConfig,
  pageToken: string,
  formId: string,
  opts: Partial<GraphRequestOptions> & {
    limit?: number;
    after?: string | null;
  } = {},
): Promise<MetaLeadListPage> {
  const { limit = 50, after, ...rest } = opts;
  const data = await graphRequest<{
    data?: MetaLeadDetail[];
    paging?: {
      cursors?: { after?: string };
      next?: string;
    };
  }>(`/${formId}/leads`, {
    config,
    token: pageToken,
    params: {
      fields: LEAD_FIELDS,
      limit,
      after: after ?? undefined,
    },
    ...rest,
  });

  const leads = data.data ?? [];
  let nextCursor = data.paging?.cursors?.after ?? null;
  if (!nextCursor && data.paging?.next) {
    // Older Graph responses omit cursors but include a full next URL.
    try {
      nextCursor = new URL(data.paging.next).searchParams.get("after");
    } catch {
      nextCursor = null;
    }
  }
  return { leads, nextCursor: leads.length > 0 ? nextCursor : null };
}

export async function subscribePageToLeadgen(
  config: MetaLeadAdsConfig,
  pageToken: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<boolean> {
  const data = await graphRequest<{ success?: boolean | string }>(
    `/${pageId}/subscribed_apps`,
    {
      config,
      token: pageToken,
      method: "POST",
      params: { subscribed_fields: "leadgen" },
      ...opts,
    },
  );
  return data.success === true || data.success === "true";
}

export interface PageSubscriptionEntry {
  id?: string;
  name?: string;
  subscribedFields: string[];
}

export interface PageSubscriptionInspection {
  /** True only when our app id has `leadgen` in its readback entry. */
  subscribed: boolean;
  appIdMatched: boolean;
  entries: PageSubscriptionEntry[];
}

/**
 * Read back which apps are installed on a Page. Meta returns an entry
 * per installed app; an entry counts for this deployment only when its
 * id equals `config.appId`. A readback without our app id is reported
 * as not verified, never assumed to be ours.
 */
export async function inspectPageSubscriptions(
  config: MetaLeadAdsConfig,
  pageToken: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<PageSubscriptionInspection> {
  const data = await graphRequest<{
    data?: Array<{
      id?: string;
      name?: string;
      subscribed_fields?: unknown;
    }>;
  }>(`/${pageId}/subscribed_apps`, {
    config,
    token: pageToken,
    params: { fields: "id,name,subscribed_fields" },
    ...opts,
  });
  const entries: PageSubscriptionEntry[] = (data.data ?? []).map((entry) => ({
    id: typeof entry.id === "string" ? entry.id : undefined,
    name: typeof entry.name === "string" ? entry.name : undefined,
    subscribedFields: Array.isArray(entry.subscribed_fields)
      ? entry.subscribed_fields.filter(
          (field): field is string => typeof field === "string",
        )
      : [],
  }));
  const appIdMatched = entries.some(
    (entry) =>
      entry.id === config.appId &&
      entry.subscribedFields.includes("leadgen"),
  );
  return { subscribed: appIdMatched, appIdMatched, entries };
}

/**
 * Whether THIS deployment's shared app is subscribed to `leadgen` on
 * the Page. The endpoint can return apps other than ours when the
 * supplied token belongs to a different Meta app.
 */
export async function getPageSubscriptions(
  config: MetaLeadAdsConfig,
  pageToken: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<boolean> {
  const inspection = await inspectPageSubscriptions(
    config,
    pageToken,
    pageId,
    opts,
  );
  return inspection.subscribed;
}

/** Unsubscribe our app from `leadgen` on this Page (best-effort). */
export async function unsubscribePageFromLeadgen(
  config: MetaLeadAdsConfig,
  pageToken: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<boolean> {
  const data = await graphRequest<{ success?: boolean | string }>(
    `/${pageId}/subscribed_apps`,
    { config, token: pageToken, method: "DELETE", ...opts },
  );
  return data.success === true || data.success === "true";
}

export interface TokenDebugInfo {
  isValid: boolean;
  appId: string | null;
  scopes: string[];
  expiresAt: number | null;
  userId: string | null;
  type: string | null;
  error: string | null;
}

/**
 * Validate a token + read its granted scopes (server-side only).
 *
 * NOTE: `debug_token` can only inspect a token issued by the app whose
 * access token is used here (the platform app). A token from ANOTHER
 * Meta app cannot be introspected this way. OAuth tokens are issued by
 * the shared app, so this succeeds for the supported flow; manual
 * foreign-app tokens are handled as unverifiable, not valid.
 */
export async function debugToken(
  config: MetaLeadAdsConfig,
  inputToken: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<TokenDebugInfo> {
  const data = await graphRequest<{
    data?: {
      is_valid?: boolean;
      app_id?: string;
      scopes?: string[];
      expires_at?: number;
      user_id?: string;
      type?: string;
      error?: { message?: string };
    };
  }>("/debug_token", {
    config,
    token: appAccessToken(config),
    params: { input_token: inputToken },
    ...opts,
  });
  const d = data.data ?? {};
  return {
    isValid: d.is_valid === true,
    appId: d.app_id ?? null,
    scopes: d.scopes ?? [],
    expiresAt: d.expires_at ?? null,
    userId: d.user_id ?? null,
    type: d.type ?? null,
    error: d.error?.message ?? null,
  };
}

export interface MetaOAuthUser {
  id: string;
  name?: string;
}

/** Read the user identity behind an OAuth user token (server-side only). */
export async function getOAuthUser(
  config: MetaLeadAdsConfig,
  userToken: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<MetaOAuthUser> {
  return graphRequest<MetaOAuthUser>(`/me`, {
    config,
    token: userToken,
    params: { fields: "id,name" },
    ...opts,
  });
}

export interface MetaManagedPage {
  id: string;
  name?: string;
  tasks?: string[];
}

/**
 * List Pages accessible to an OAuth user token. Page access tokens are
 * deliberately not requested here: the callback stores page metadata
 * only, and a Page token is fetched later for an explicitly selected
 * Page.
 */
export async function listManagedPages(
  config: MetaLeadAdsConfig,
  userToken: string,
  opts: Partial<GraphRequestOptions> & { maxPages?: number } = {},
): Promise<MetaManagedPage[]> {
  const { maxPages = 10, ...rest } = opts;
  const pages: MetaManagedPage[] = [];
  let after: string | null = null;

  for (let page = 0; page < Math.max(1, maxPages); page += 1) {
    const data: {
      data?: Array<{ id?: unknown; name?: unknown; tasks?: unknown }>;
      paging?: { cursors?: { after?: string }; next?: string };
    } = await graphRequest(`/me/accounts`, {
      config,
      token: userToken,
      params: { fields: "id,name,tasks", limit: 100, after: after ?? undefined },
      ...rest,
    });

    const batch: MetaManagedPage[] = (data.data ?? [])
      .map((row) => ({
        id: String(row.id ?? ""),
        name: typeof row.name === "string" ? row.name : undefined,
        tasks: Array.isArray(row.tasks)
          ? row.tasks.filter((task): task is string => typeof task === "string")
          : [],
      }))
      .filter((row) => row.id !== "");
    pages.push(...batch);

    const next: string | null =
      data.paging?.cursors?.after ??
      (data.paging?.next ? cursorFromNextUrl(data.paging.next) : null);
    if (!next || batch.length === 0) break;
    after = next;
  }

  return pages;
}

export interface AppWebhookSubscription {
  /** True only when the Page object has the `leadgen` field at app level. */
  configured: boolean;
  callbackUrl: string | null;
  fields: string[];
}

/**
 * Check the shared app's own webhook configuration. This is the
 * app-level half of leadgen delivery; Page-level installation alone is
 * not enough. Enabling the field remains a manual App Dashboard action.
 */
export async function getAppPageSubscriptions(
  config: MetaLeadAdsConfig,
  opts: Partial<GraphRequestOptions> = {},
): Promise<AppWebhookSubscription> {
  const data = await graphRequest<{
    data?: Array<{
      object?: string;
      callback_url?: string;
      fields?: Array<string | { name?: string }>;
    }>;
  }>(`/${config.appId}/subscriptions`, {
    config,
    token: appAccessToken(config),
    ...opts,
  });

  const pageSubscriptions = (data.data ?? []).filter(
    (entry) => entry.object === "page",
  );
  const fields = [
    ...new Set(
      pageSubscriptions.flatMap((entry) =>
        (entry.fields ?? [])
          .map((field) => (typeof field === "string" ? field : field.name ?? ""))
          .filter((field) => field !== ""),
      ),
    ),
  ];
  return {
    configured: fields.includes("leadgen"),
    callbackUrl: pageSubscriptions[0]?.callback_url ?? null,
    fields,
  };
}

export interface OAuthTokenGrant {
  accessToken: string;
  tokenType: string | null;
  expiresAt: string | null;
  scopes: string[];
}

interface OAuthTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  scope?: string;
  error?: { message?: string; type?: string; code?: number };
}

function oauthExpiry(expiresIn: number | string | undefined): string | null {
  const seconds = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function requestOAuthToken(
  config: MetaLeadAdsConfig,
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenGrant> {
  const url = new URL(`${graphBase(config.graphVersion)}/oauth/access_token`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetchImpl(url.toString(), { method: "GET" });
  const text = await res.text();
  let body: OAuthTokenResponse | null = null;
  try {
    body = text ? (JSON.parse(text) as OAuthTokenResponse) : null;
  } catch {
    body = null;
  }

  if (!res.ok || !body?.access_token) {
    const message = body?.error?.message ?? `Meta OAuth token request failed (${res.status}).`;
    throw new MetaGraphError({
      code: "exchange_failed",
      message: message.slice(0, 300),
      status: res.status === 400 ? 400 : 502,
      graphStatus: res.status,
      graphType: body?.error?.type,
      graphCode: body?.error?.code,
    });
  }

  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? null,
    expiresAt: oauthExpiry(body.expires_in),
    scopes:
      body.scope
        ?.split(/[,\s]+/)
        .map((scope) => scope.trim())
        .filter((scope) => scope !== "") ?? [],
  };
}

/** Exchange a one-time OAuth authorization code for a user token. */
export async function exchangeCodeForToken(
  config: MetaLeadAdsConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenGrant> {
  return requestOAuthToken(
    config,
    {
      client_id: config.appId,
      redirect_uri: redirectUri,
      client_secret: config.appSecret,
      code,
    },
    fetchImpl,
  );
}

/**
 * Exchange a short-lived user token for a long-lived token. Callers
 * should treat failure as non-fatal: the short-lived token can still
 * finish page selection, but expiry must be tracked.
 */
export async function exchangeForLongLivedToken(
  config: MetaLeadAdsConfig,
  shortLivedToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenGrant> {
  return requestOAuthToken(
    config,
    {
      grant_type: "fb_exchange_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: shortLivedToken,
    },
    fetchImpl,
  );
}

export { isAuthGraphError };
