// POST /api/integrations/meta-crm/datasets — route contracts.
//
// Guarantees: admin-only, input validation, single Meta call with the
// caller's values, safe errors, and never returning the token.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  roleOk: true,
  createImpl: null as null | ((args: {
    businessPortfolioId: string;
    datasetName: string;
    accessToken: string;
  }) => Promise<{ id: string; name: string }>),
  createCalls: [] as Array<{
    businessPortfolioId: string;
    datasetName: string;
    accessToken: string;
  }>,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => {
    if (!h.roleOk) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return { supabase: {}, accountId: h.accountId, userId: "u1" };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

vi.mock("@/lib/meta-crm/datasets", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta-crm/datasets")>();
  return {
    ...actual,
    createCrmDataset: async (args: {
      businessPortfolioId: string;
      datasetName: string;
      accessToken: string;
    }) => {
      h.createCalls.push({ ...args });
      if (h.createImpl) return h.createImpl(args);
      return { id: "123456789012345", name: args.datasetName };
    },
  };
});

const { POST } = await import("./route");

const post = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-crm/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.accountId = "acct-1";
  h.roleOk = true;
  h.createImpl = null;
  h.createCalls = [];
});

describe("POST /api/integrations/meta-crm/datasets", () => {
  it("creates a dataset from the caller's values and never returns the token", async () => {
    const res = await POST(
      post({
        datasetName: "Interscale Marketing",
        businessPortfolioId: "1171141236081090",
        accessToken: "USER_TOKEN_VALUE",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      dataset: { id: string; name: string; businessPortfolioId: string; type: string; status: string };
    };
    expect(json.ok).toBe(true);
    expect(json.dataset.id).toBe("123456789012345");
    expect(json.dataset.name).toBe("Interscale Marketing");
    expect(json.dataset.businessPortfolioId).toBe("1171141236081090");
    expect(json.dataset.type).toBe("CRM");
    expect(JSON.stringify(json)).not.toContain("USER_TOKEN_VALUE");

    // Backend forwards the caller's dynamic values (nothing hardcoded).
    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toEqual({
      businessPortfolioId: "1171141236081090",
      datasetName: "Interscale Marketing",
      accessToken: "USER_TOKEN_VALUE",
    });
  });

  it("rejects invalid input without calling Meta", async () => {
    const res = await POST(
      post({ datasetName: "  ", businessPortfolioId: "abc", accessToken: "" }),
    );
    expect(res.status).toBe(400);
    expect(h.createCalls).toHaveLength(0);
  });

  it("requires the admin role (tenant-scoped auth)", async () => {
    h.roleOk = false;
    const res = await POST(
      post({
        datasetName: "Interscale Marketing",
        businessPortfolioId: "1171141236081090",
        accessToken: "USER_TOKEN_VALUE",
      }),
    );
    expect(res.status).toBe(403);
    expect(h.createCalls).toHaveLength(0);
  });

  it("passes Meta permission errors through with codes and no token", async () => {
    const { MetaCrmError } = await import("@/lib/meta-crm/datasets");
    h.createImpl = async () => {
      throw new MetaCrmError({
        code: "forbidden",
        message: "Meta refused: insufficient permissions (code 200).",
        status: 403,
        metaCode: 200,
        metaSubcode: null,
      });
    };
    const res = await POST(
      post({
        datasetName: "Interscale Marketing",
        businessPortfolioId: "1171141236081090",
        accessToken: "SECRET_TOKEN_XYZ",
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.metaCode).toBe(200);
    expect(JSON.stringify(json)).not.toContain("SECRET_TOKEN_XYZ");
  });
});
