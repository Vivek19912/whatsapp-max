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

import { graphBase, type MetaLeadAdsConfig } from "./config";
import { MetaGraphError, isAuthGraphError } from "./errors";

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

    lastError = new MetaGraphError({
      code:
        errorBody?.code !== undefined && RATE_LIMIT_GRAPH_CODES.has(errorBody.code)
          ? "rate_limited"
          : "graph_error",
      message: errorBody?.message ?? `Meta Graph request failed (${res.status}).`,
      status:
        errorBody?.type === "OAuthException" || res.status === 401
          ? 401
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
  tasks?: string[];
}

/**
 * Read one Page by id. Manual setup pastes the Page id instead of
 * discovering Pages through `/me/accounts` (a System User token
 * generally cannot list a user's Pages). Requesting `access_token`
 * yields a Page token when the token can act on the Page; when Meta
 * omits it the caller falls back to the pasted token.
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
    params: { fields: "id,name,access_token,tasks" },
    ...opts,
  });
}

export interface MetaForm {
  id: string;
  name?: string;
  status?: string;
  locale?: string;
}

export async function listForms(
  config: MetaLeadAdsConfig,
  pageToken: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<MetaForm[]> {
  const data = await graphRequest<{ data?: MetaForm[] }>(
    `/${pageId}/leadgen_forms`,
    {
      config,
      token: pageToken,
      params: { fields: "id,name,status,locale", limit: 100 },
      ...opts,
    },
  );
  return data.data ?? [];
}

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
  page_id?: string;
  platform?: string;
  ad_id?: string;
  ad_name?: string;
  campaign_name?: string;
  is_organic?: boolean;
}

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
      fields:
        "id,created_time,field_data,form_id,page_id,platform,ad_id,ad_name,campaign_name,is_organic",
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
      fields:
        "id,created_time,field_data,form_id,page_id,platform,ad_id,ad_name,campaign_name,is_organic",
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
  const data = await graphRequest<{ success?: boolean }>(
    `/${pageId}/subscribed_apps`,
    {
      config,
      token: pageToken,
      method: "POST",
      params: { subscribed_fields: "leadgen" },
      ...opts,
    },
  );
  return data.success === true;
}

/**
 * Whether THIS deployment's shared app is subscribed to `leadgen` on
 * the Page. The endpoint can return apps other than ours when the
 * pasted token belongs to a different Meta app, so an entry is only
 * counted when its id matches `config.appId` (or when Meta omits the
 * id entirely).
 */
export async function getPageSubscriptions(
  config: MetaLeadAdsConfig,
  pageToken: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<boolean> {
  const data = await graphRequest<{
    data?: Array<{ id?: string; subscribed_fields?: string[] }>;
  }>(`/${pageId}/subscribed_apps`, {
    config,
    token: pageToken,
    params: { fields: "id,subscribed_fields" },
    ...opts,
  });
  return (data.data ?? []).some(
    (entry) =>
      (entry.id === undefined || entry.id === config.appId) &&
      (entry.subscribed_fields ?? []).includes("leadgen"),
  );
}

/** Unsubscribe our app from `leadgen` on this Page (best-effort). */
export async function unsubscribePageFromLeadgen(
  config: MetaLeadAdsConfig,
  pageToken: string,
  pageId: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<boolean> {
  const data = await graphRequest<{ success?: boolean }>(
    `/${pageId}/subscribed_apps`,
    { config, token: pageToken, method: "DELETE", ...opts },
  );
  return data.success === true;
}

export interface TokenDebugInfo {
  isValid: boolean;
  scopes: string[];
  expiresAt: number | null;
  userId: string | null;
  type: string | null;
  error: string | null;
}

/** Validate a token + read its granted scopes (server-side only). */
export async function debugToken(
  config: MetaLeadAdsConfig,
  inputToken: string,
  opts: Partial<GraphRequestOptions> = {},
): Promise<TokenDebugInfo> {
  const appAccessToken = `${config.appId}|${config.appSecret}`;
  const data = await graphRequest<{
    data?: {
      is_valid?: boolean;
      scopes?: string[];
      expires_at?: number;
      user_id?: string;
      type?: string;
      error?: { message?: string };
    };
  }>("/debug_token", {
    config,
    token: appAccessToken,
    params: { input_token: inputToken },
    ...opts,
  });
  const d = data.data ?? {};
  return {
    isValid: d.is_valid === true,
    scopes: d.scopes ?? [],
    expiresAt: d.expires_at ?? null,
    userId: d.user_id ?? null,
    type: d.type ?? null,
    error: d.error?.message ?? null,
  };
}

export { isAuthGraphError };
