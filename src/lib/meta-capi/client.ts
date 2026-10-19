// ============================================================
// Meta Conversions API — Graph client.
//
// The Lead Ads `graphRequest` helper only performs GET/DELETE with
// query params; CAPI needs a JSON POST body, so this is a small,
// purpose-built wrapper. It still reuses the shared Google/Meta
// conventions: versioned host from config, a bounded timeout, and the
// SAME error taxonomy (MetaGraphError / MetaLeadAdsError) so routes map
// failures identically. Tokens and response bodies are never logged.
//
// appsecret_proof is OPTIONAL on Graph API calls. When we send one it
// MUST be HMAC-SHA256(access_token, <secret of the app that issued the
// token>). A customer's System User token can belong to their own app,
// not the shared platform app, so CAPI NEVER derives the proof from the
// platform META_LEAD_ADS_APP_SECRET. If the customer has not provided
// their matching App Secret, the proof parameter is omitted entirely —
// sending a wrong proof is rejected by Meta ("Invalid appsecret_proof")
// even though omitting it is allowed.
// ============================================================

import { graphBase } from "@/lib/meta-lead-ads/config";
import {
  MetaGraphError,
  MetaLeadAdsError,
  isAuthGraphCode,
  isAuthGraphError,
} from "@/lib/meta-lead-ads/errors";
import { appSecretProof } from "@/lib/meta-lead-ads/graph-client";

/** CAPI only needs the Graph version — never the platform app secret. */
export interface CapiPlatform {
  graphVersion: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export interface CapiRequestOptions {
  method?: "GET" | "POST";
  params?: Record<string, string | number | undefined | null>;
  token?: string;
  /**
   * The App Secret of the Meta app that issued `token`. Only used to
   * compute `appsecret_proof`; when omitted, no proof is sent.
   */
  appSecret?: string | null;
  body?: unknown;
  fetchImpl?: typeof fetch;
  /** Tests pass 0. */
  timeoutMs?: number;
}

export async function capiRequest<T = Record<string, unknown>>(
  path: string,
  platform: CapiPlatform,
  options: CapiRequestOptions = {},
): Promise<T> {
  const {
    method = "GET",
    params = {},
    token,
    appSecret = null,
    body,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const url = new URL(`${graphBase(platform.graphVersion)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  if (token) {
    url.searchParams.set("access_token", token);
    // Only send a proof we can compute with the matching secret. A proof
    // derived from a different app's secret is fatal to the whole call.
    if (appSecret) {
      url.searchParams.set("appsecret_proof", appSecretProof(appSecret, token));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new MetaGraphError({
      code: "graph_error",
      message: "Could not reach the Meta Conversions API.",
      status: 502,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  const errorBody = (parsed as { error?: { message?: string; type?: string; code?: number; error_subcode?: number } } | null)
    ?.error;

  if (res.ok && !errorBody) {
    return (parsed ?? {}) as T;
  }

  const authFailure =
    errorBody?.code !== undefined
      ? isAuthGraphCode(errorBody.code)
      : errorBody?.type === "OAuthException" || res.status === 401;

  throw new MetaGraphError({
    code: "graph_error",
    message: errorBody?.message ?? `Meta request failed (${res.status}).`,
    status: authFailure
      ? 401
      : res.status >= 500
        ? 502
        : 400,
    graphStatus: res.status,
    graphType: errorBody?.type,
    graphCode: errorBody?.code,
    graphSubcode: errorBody?.error_subcode,
  });
}

/**
 * Confirm the customer's dataset/pixel id is reachable with the given
 * token. Returns the dataset id + name so the wizard can show a clear
 * "we found your dataset" confirmation. Throws MetaGraphError otherwise.
 */
export async function validateDataset(
  platform: CapiPlatform,
  datasetId: string,
  token: string,
  opts: Partial<CapiRequestOptions> = {},
): Promise<{ id: string; name?: string }> {
  return capiRequest<{ id: string; name?: string }>(`/${datasetId}`, platform, {
    token,
    params: { fields: "id,name" },
    ...opts,
  });
}

export interface SendEventsResult {
  events_received?: number;
  fbtrace_id?: string;
  messages?: unknown;
}

/**
 * POST one event batch to `/{dataset_id}/events`. `body` is the full
 * CAPI payload (`{ data: [...], test_event_code? }`).
 */
export async function sendEvents(
  platform: CapiPlatform,
  datasetId: string,
  token: string,
  body: Record<string, unknown>,
  opts: Partial<CapiRequestOptions> = {},
): Promise<SendEventsResult> {
  return capiRequest<SendEventsResult>(`/${datasetId}/events`, platform, {
    method: "POST",
    token,
    body,
    ...opts,
  });
}

/**
 * Turn a verification failure into an actionable, secret-free message
 * for Settings. Never includes the token, App Secret or proof.
 */
export function describeCapiVerificationError(err: unknown): string {
  if (err instanceof MetaGraphError) {
    const text = err.message.toLowerCase();
    if (text.includes("appsecret_proof") || text.includes("app secret proof")) {
      return (
        "Meta rejected appsecret_proof. This happens when the access token " +
        "was issued by a different Meta app than the App Secret we used. " +
        "Add the App Secret of the app that issued this token (Step 2), or " +
        "leave it blank so no proof is sent. Do not use this platform app's " +
        "secret for another app's token."
      );
    }
    if (isAuthGraphError(err)) {
      return (
        "Meta rejected the access token (invalid, expired, or revoked). " +
        "Generate a new System User token with access to this dataset and " +
        "paste it again."
      );
    }
    if (
      err.graphCode === 200 ||
      text.includes("permission") ||
      text.includes("(#200)")
    ) {
      return (
        "The token is valid but lacks permission for this dataset. In " +
        "Business Settings, give the System User access to this dataset and " +
        "the business that owns it, then try again."
      );
    }
    return err.message;
  }
  if (err instanceof MetaLeadAdsError) return err.message;
  return "Could not verify these details with Meta.";
}
