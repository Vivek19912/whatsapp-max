// ============================================================
// Meta Conversions API — Graph client.
//
// The Lead Ads `graphRequest` helper only performs GET/DELETE with
// query params; CAPI needs a JSON POST body, so this is a small,
// purpose-built wrapper. It still reuses the shared Google/Meta
// conventions: versioned host from config, `appsecret_proof` on every
// call, a bounded timeout, and the SAME error taxonomy
// (MetaGraphError / MetaLeadAdsError) so routes map failures
// identically. Tokens and response bodies are never logged.
// ============================================================

import { graphBase } from "@/lib/meta-lead-ads/config";
import { MetaGraphError } from "@/lib/meta-lead-ads/errors";
import { appSecretProof } from "@/lib/meta-lead-ads/graph-client";

/** The subset of the shared Meta app config CAPI needs. */
export interface CapiPlatform {
  graphVersion: string;
  appSecret: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export interface CapiRequestOptions {
  method?: "GET" | "POST";
  params?: Record<string, string | number | undefined | null>;
  token?: string;
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
    url.searchParams.set("appsecret_proof", appSecretProof(platform.appSecret, token));
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

  throw new MetaGraphError({
    code: "graph_error",
    message: errorBody?.message ?? `Meta request failed (${res.status}).`,
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
