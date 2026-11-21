// Meta CRM Integration — dataset creation client contracts.
//
// Pins: single POST to v27.0/{business}/ads_dataset with Bearer auth,
// is_crm=true, safe error mapping, and no token leakage.

import { describe, expect, it, vi } from "vitest";

import {
  META_CRM_GRAPH_VERSION,
  MetaCrmError,
  buildCrmDatasetUrl,
  createCrmDataset,
} from "./datasets";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildCrmDatasetUrl", () => {
  it("pins the v27.0 ads_dataset endpoint", () => {
    expect(META_CRM_GRAPH_VERSION).toBe("v27.0");
    expect(buildCrmDatasetUrl("1171141236081090")).toBe(
      "https://graph.facebook.com/v27.0/1171141236081090/ads_dataset",
    );
  });
});

describe("createCrmDataset", () => {
  it("sends one POST with Bearer auth and is_crm=true", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ id: "123456789012345" });
    }) as unknown as typeof fetch;

    const created = await createCrmDataset({
      businessPortfolioId: "1171141236081090",
      datasetName: "Interscale Marketing",
      accessToken: "USER_TOKEN",
      fetchImpl,
    });

    expect(created).toEqual({ id: "123456789012345", name: "Interscale Marketing" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://graph.facebook.com/v27.0/1171141236081090/ads_dataset",
    );
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer USER_TOKEN");
    expect(String(calls[0].init.body)).toContain("name=Interscale+Marketing");
    expect(String(calls[0].init.body)).toContain("is_crm=true");
  });

  it("maps Meta #200 to a permission error preserving codes", async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        {
          error: {
            message: "Insufficient permission.",
            type: "OAuthException",
            code: 200,
            error_subcode: 123,
          },
        },
        400,
      )) as unknown as typeof fetch;

    const err = await createCrmDataset({
      businessPortfolioId: "1171141236081090",
      datasetName: "Interscale Marketing",
      accessToken: "USER_TOKEN",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect((err as MetaCrmError).code).toBe("forbidden");
    expect((err as MetaCrmError).status).toBe(403);
    expect((err as MetaCrmError).metaCode).toBe(200);
    expect((err as MetaCrmError).metaSubcode).toBe(123);
    expect((err as Error).message).not.toContain("USER_TOKEN");
  });

  it("maps invalid tokens to 401 without leaking the token", async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: { message: "Invalid OAuth access token.", code: 190 } },
        400,
      )) as unknown as typeof fetch;

    const err = await createCrmDataset({
      businessPortfolioId: "1171141236081090",
      datasetName: "Interscale Marketing",
      accessToken: "BAD_TOKEN_VALUE",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect((err as MetaCrmError).status).toBe(401);
    expect((err as Error).message).not.toContain("BAD_TOKEN_VALUE");
  });

  it("rejects a success response missing the dataset id", async () => {
    const fetchImpl = (async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    const err = await createCrmDataset({
      businessPortfolioId: "1171141236081090",
      datasetName: "Interscale Marketing",
      accessToken: "USER_TOKEN",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect((err as MetaCrmError).code).toBe("missing_dataset_id");
  });

  it("surfaces network failures as 502 without retrying", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const err = await createCrmDataset({
      businessPortfolioId: "1171141236081090",
      datasetName: "Interscale Marketing",
      accessToken: "USER_TOKEN",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect((err as MetaCrmError).status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
