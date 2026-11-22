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

describe("verifyExistingCrmDataset", () => {
  function verifyFetch(
    handlers: Record<string, (url: string) => Response>,
  ): typeof fetch {
    return (async (url: string) => {
      for (const [prefix, handler] of Object.entries(handlers)) {
        if (url.includes(prefix)) return handler(url);
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  }

  it("verifies identity without creating anything (no POST)", async () => {
    const calls: string[] = [];
    const fetchImpl = verifyFetch({
      "/1830596054845292?": () => jsonResponse({ id: "1830596054845292", name: "IM 22 Nov" }),
      "/1171141236081090?": () => jsonResponse({ id: "1171141236081090", name: "Biz" }),
      "/ads_dataset": () => jsonResponse({ data: [{ id: "1830596054845292" }] }),
    });
    const wrapped = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return fetchImpl(url);
    }) as unknown as typeof fetch;

    const { verifyExistingCrmDataset } = await import("./datasets");
    const out = await verifyExistingCrmDataset({
      datasetId: "1830596054845292",
      businessPortfolioId: "1171141236081090",
      accessToken: "USER_TOKEN",
      fetchImpl: wrapped,
    });
    expect(out.id).toBe("1830596054845292");
    expect(out.name).toBe("IM 22 Nov");
    expect(out.ownershipVerified).toBe(true);
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("rejects name mismatches and never leaks the token", async () => {
    const fetchImpl = verifyFetch({
      "/1830596054845292?": () => jsonResponse({ id: "1830596054845292", name: "Real Name" }),
      "/1171141236081090?": () => jsonResponse({ id: "1171141236081090", name: "Biz" }),
      "/ads_dataset": () => jsonResponse({ data: [] }),
    });
    const { verifyExistingCrmDataset } = await import("./datasets");
    const err = await verifyExistingCrmDataset({
      datasetId: "1830596054845292",
      businessPortfolioId: "1171141236081090",
      accessToken: "SECRET_TOKEN_ABC",
      expectedName: "Wrong Name",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect((err as MetaCrmError).status).toBe(400);
    expect((err as Error).message).not.toContain("SECRET_TOKEN_ABC");
  });

  it("maps dataset access denial to 403 with codes", async () => {
    const fetchImpl = verifyFetch({
      "/1830596054845292?": () =>
        jsonResponse({ error: { message: "Unsupported get request.", code: 100 } }, 400),
    });
    const { verifyExistingCrmDataset } = await import("./datasets");
    const err = await verifyExistingCrmDataset({
      datasetId: "1830596054845292",
      businessPortfolioId: "1171141236081090",
      accessToken: "TOK",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
  });
});

describe("verifyDatasetOwnership", () => {
  function stubFetch(
    handlers: Record<string, (url: string) => Response>,
  ): typeof fetch {
    return (async (url: string) => {
      for (const [prefix, handler] of Object.entries(handlers)) {
        if (url.includes(prefix)) return handler(url);
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  }

  const ARGS = {
    businessPortfolioId: "1171141236081090",
    datasetId: "1169732842278579",
    accessToken: "USER_TOKEN",
  };

  it("verifies ownership when the dataset is listed under the business", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const out = await verifyDatasetOwnership({
      ...ARGS,
      fetchImpl: stubFetch({
        "/1169732842278579?": () =>
          jsonResponse({ id: "1169732842278579", name: "IM CRM" }),
        "/1171141236081090?": () => jsonResponse({ id: "1171141236081090", name: "Biz" }),
        "/ads_dataset": () => jsonResponse({ data: [{ id: "1169732842278579" }] }),
      }),
    });
    expect(out).toEqual({ verified: true });
  });

  it("returns not-owned (never throws) when the listing succeeds without the dataset", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const out = await verifyDatasetOwnership({
      ...ARGS,
      fetchImpl: stubFetch({
        "/1169732842278579?": () =>
          jsonResponse({ id: "1169732842278579", name: "IM CRM" }),
        "/1171141236081090?": () => jsonResponse({ id: "1171141236081090", name: "Biz" }),
        "/ads_dataset": () => jsonResponse({ data: [{ id: "999" }] }),
      }),
    });
    expect(out.verified).toBe(false);
    if (!out.verified) {
      expect(out.reason).toContain("1169732842278579");
      expect(out.reason).toContain("1171141236081090");
    }
  });

  it("throws auth_failed for an expired token instead of blaming ownership", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const err = await verifyDatasetOwnership({
      ...ARGS,
      fetchImpl: stubFetch({
        "/1169732842278579?": () =>
          jsonResponse(
            { error: { message: "Invalid OAuth access token.", code: 190 } },
            400,
          ),
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("auth_failed");
    expect(err.status).toBe(401);
    expect(err.metaCode).toBe(190);
    expect(String(err.message)).not.toContain("USER_TOKEN");
  });

  it("throws forbidden with Meta codes when the token lacks dataset permission", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const err = await verifyDatasetOwnership({
      ...ARGS,
      fetchImpl: stubFetch({
        "/1169732842278579?": () =>
          jsonResponse(
            { error: { message: "Insufficient permission.", type: "OAuthException", code: 200, error_subcode: 33 } },
            400,
          ),
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("forbidden");
    expect(err.status).toBe(403);
    expect(err.metaCode).toBe(200);
    expect(err.metaSubcode).toBe(33);
  });

  it("throws a business-specific error for a wrong portfolio id", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const err = await verifyDatasetOwnership({
      ...ARGS,
      businessPortfolioId: "0000000000000000",
      fetchImpl: stubFetch({
        "/1169732842278579?": () =>
          jsonResponse({ id: "1169732842278579", name: "IM CRM" }),
        "/0000000000000000?": () =>
          jsonResponse(
            { error: { message: "Unsupported get request.", code: 100 } },
            400,
          ),
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.status).toBe(400);
    expect(String(err.message)).not.toContain("USER_TOKEN");
  });

  it("throws meta_error (not false) when the listing edge is unavailable", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const err = await verifyDatasetOwnership({
      ...ARGS,
      fetchImpl: stubFetch({
        "/1169732842278579?": () =>
          jsonResponse({ id: "1169732842278579", name: "IM CRM" }),
        "/1171141236081090?": () => jsonResponse({ id: "1171141236081090", name: "Biz" }),
        "/ads_dataset": () =>
          jsonResponse(
            { error: { message: "Unknown path components.", code: 2500 } },
            404,
          ),
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("meta_error");
    // Uncertain, never a fabricated "not owned" verdict.
    expect(err).not.toMatchObject({ code: "forbidden" });
  });

  it("throws network_error on transport failure instead of blaming ownership", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const err = await verifyDatasetOwnership({
      ...ARGS,
      fetchImpl: (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("network_error");
  });

  it("rejects an empty token without calling Meta", async () => {
    const calls: string[] = [];
    const { verifyDatasetOwnership } = await import("./datasets");
    const err = await verifyDatasetOwnership({
      ...ARGS,
      accessToken: "   ",
      fetchImpl: (async (url: string) => {
        calls.push(url);
        throw new Error("must not call Meta");
      }) as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("reads the documented singular ads_dataset edge (never the plural)", async () => {
    const calls: string[] = [];
    const { verifyDatasetOwnership } = await import("./datasets");
    await verifyDatasetOwnership({
      ...ARGS,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        if (url.includes("/ads_dataset?")) {
          return jsonResponse({ data: [{ id: "1169732842278579" }] });
        }
        if (url.includes("/1169732842278579?")) {
          return jsonResponse({ id: "1169732842278579", name: "IM CRM" });
        }
        return jsonResponse({ id: "1171141236081090", name: "Biz" });
      }) as unknown as typeof fetch,
    });
    const listing = calls.find((u) => u.includes("/ads_dataset"));
    expect(listing).toBeDefined();
    expect(calls.some((u) => u.includes("/ads_datasets"))).toBe(false);
    expect(listing).toContain("/1171141236081090/ads_dataset?fields=id");
  });

  it("maps 1349004 to forbidden with an allowlist/permission message", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const err = await verifyDatasetOwnership({
      ...ARGS,
      fetchImpl: stubFetch({
        "/1169732842278579?": () =>
          jsonResponse({ id: "1169732842278579", name: "IM CRM" }),
        "/1171141236081090?": () => jsonResponse({ id: "1171141236081090", name: "Biz" }),
        "/ads_dataset": () =>
          jsonResponse(
            { error: { message: "No permission.", code: 1349004 } },
            403,
          ),
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("forbidden");
    expect(err.status).toBe(403);
    expect(err.metaCode).toBe(1349004);
    expect(String(err.message)).toContain("business_management");
  });

  it("maps 2282001 to invalid input naming the business id", async () => {
    const { verifyDatasetOwnership } = await import("./datasets");
    const err = await verifyDatasetOwnership({
      ...ARGS,
      businessPortfolioId: "0000000000000000",
      fetchImpl: stubFetch({
        "/1169732842278579?": () =>
          jsonResponse({ id: "1169732842278579", name: "IM CRM" }),
        "/0000000000000000?": () => jsonResponse({ id: "0000000000000000", name: "Biz" }),
        "/ads_dataset": () =>
          jsonResponse(
            { error: { message: "Invalid Business ID.", code: 2282001 } },
            400,
          ),
      }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("invalid_input");
    expect(err.status).toBe(400);
    expect(err.metaCode).toBe(2282001);
    expect(String(err.message)).toContain("0000000000000000");
  });
});
