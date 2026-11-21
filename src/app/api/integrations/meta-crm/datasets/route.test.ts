// POST + GET /api/integrations/meta-crm/datasets — route contracts.
//
// Guarantees: admin-only writes, member-scoped reads, input validation,
// single Meta call with the caller's values, persistent save, safe
// errors, and never returning the token.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "u1",
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
  savedRows: [] as Array<Record<string, unknown>>,
  saveThrows: false,
  listedAccountId: null as string | null,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => {
    if (!h.roleOk) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return { supabase: {}, accountId: h.accountId, userId: h.userId };
  },
  getCurrentAccount: async () => {
    if (!h.roleOk) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return { supabase: {}, accountId: h.accountId, userId: h.userId };
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

vi.mock("@/lib/meta-crm/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-crm/store")>();
  return {
    ...actual,
    saveCrmDataset: async (_db: unknown, input: Record<string, unknown>) => {
      if (h.saveThrows) throw new Error("db down");
      const row = {
        id: "internal-uuid-1",
        account_id: input.accountId,
        business_portfolio_id: input.businessPortfolioId,
        dataset_id: input.datasetId,
        dataset_name: input.datasetName,
        dataset_type: "CRM",
        creation_status: "Created",
        created_by: "u1",
        created_at: "2026-11-22T00:00:00.000Z",
        updated_at: "2026-11-22T00:00:00.000Z",
      };
      h.savedRows.push(input);
      return { row, created: true };
    },
    listCrmDatasets: async (_db: unknown, accountId: string) => {
      h.listedAccountId = accountId;
      return [
        {
          id: "internal-uuid-1",
          account_id: accountId,
          business_portfolio_id: "1171141236081090",
          dataset_id: "1830596054845292",
          dataset_name: "IM 22 Nov",
          dataset_type: "CRM",
          creation_status: "Created",
          created_by: "u1",
          created_at: "2026-11-22T00:00:00.000Z",
          updated_at: "2026-11-22T00:00:00.000Z",
        },
      ];
    },
  };
});

const { POST, GET } = await import("./route");

const post = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-crm/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "u1";
  h.roleOk = true;
  h.createImpl = null;
  h.createCalls = [];
  h.savedRows = [];
  h.saveThrows = false;
  h.listedAccountId = null;
});

describe("POST /api/integrations/meta-crm/datasets", () => {
  it("creates via Meta, saves metadata, and never returns the token", async () => {
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
      stored: boolean;
      dataset: { datasetId: string; datasetName: string; businessPortfolioId: string };
    };
    expect(json.ok).toBe(true);
    expect(json.stored).toBe(true);
    expect(json.dataset.datasetId).toBe("123456789012345");
    expect(json.dataset.datasetName).toBe("Interscale Marketing");
    expect(JSON.stringify(json)).not.toContain("USER_TOKEN_VALUE");

    expect(h.createCalls).toHaveLength(1);
    expect(h.savedRows).toHaveLength(1);
    expect(h.savedRows[0].accountId).toBe("acct-1");
    expect(h.savedRows[0].datasetId).toBe("123456789012345");
  });

  it("preserves the Meta ID when the local save fails (no second Meta POST)", async () => {
    h.saveThrows = true;
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
      stored: boolean;
      saveError?: string;
      dataset: { datasetId: string };
    };
    expect(json.ok).toBe(true);
    expect(json.stored).toBe(false);
    expect(json.dataset.datasetId).toBe("123456789012345");
    expect(typeof json.saveError).toBe("string");
    // Exactly one Meta POST — the retry path must use register, never POST again.
    expect(h.createCalls).toHaveLength(1);
  });

  it("rejects invalid input without calling Meta", async () => {
    const res = await POST(
      post({ datasetName: "  ", businessPortfolioId: "abc", accessToken: "" }),
    );
    expect(res.status).toBe(400);
    expect(h.createCalls).toHaveLength(0);
  });

  it("requires the admin role for writes", async () => {
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
    expect(h.savedRows).toHaveLength(0);
  });
});

describe("GET /api/integrations/meta-crm/datasets", () => {
  it("lists only the caller's account datasets with no secrets", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      datasets: Array<{ datasetId: string; datasetName: string }>;
    };
    expect(json.ok).toBe(true);
    expect(h.listedAccountId).toBe("acct-1");
    expect(json.datasets).toHaveLength(1);
    expect(json.datasets[0].datasetId).toBe("1830596054845292");
    expect(json.datasets[0].datasetName).toBe("IM 22 Nov");
    expect(JSON.stringify(json).toLowerCase()).not.toContain("token");
  });

  it("isolates tenants by resolved account", async () => {
    h.accountId = "acct-2";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(h.listedAccountId).toBe("acct-2");
  });
});
