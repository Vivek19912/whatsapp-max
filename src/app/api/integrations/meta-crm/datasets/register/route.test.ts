// POST /api/integrations/meta-crm/datasets/register — contracts.
//
// Guarantees: admin-only, verifies via Meta (no Meta creation),
// upserts idempotently, never returns the token.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  roleOk: true,
  verifyImpl: null as null | ((args: {
    datasetId: string;
    businessPortfolioId: string;
    accessToken: string;
  }) => Promise<{ id: string; name: string; businessId: string | null; ownershipVerified: boolean }>),
  verifyCalls: [] as Array<Record<string, unknown>>,
  savedInputs: [] as Array<Record<string, unknown>>,
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
  const actual = await importOriginal<typeof import("@/lib/meta-crm/datasets")>();
  return {
    ...actual,
    verifyExistingCrmDataset: async (args: {
      datasetId: string;
      businessPortfolioId: string;
      accessToken: string;
    }) => {
      h.verifyCalls.push({ ...args, accessToken: "[redacted-for-count]" });
      if (h.verifyImpl) return h.verifyImpl(args);
      return {
        id: args.datasetId,
        name: "IM 22 Nov",
        businessId: args.businessPortfolioId,
        ownershipVerified: false,
      };
    },
  };
});

vi.mock("@/lib/meta-crm/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-crm/store")>();
  return {
    ...actual,
    saveCrmDataset: async (_db: unknown, input: Record<string, unknown>) => {
      h.savedInputs.push(input);
      return {
        row: {
          id: "internal-uuid-9",
          account_id: input.accountId,
          business_portfolio_id: input.businessPortfolioId,
          dataset_id: input.datasetId,
          dataset_name: input.datasetName,
          dataset_type: "CRM",
          creation_status: "Registered",
          created_by: "u1",
          created_at: "2026-11-22T00:00:00.000Z",
          updated_at: "2026-11-22T00:00:00.000Z",
        },
        created: true,
      };
    },
  };
});

const { POST } = await import("./route");

const post = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-crm/datasets/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.accountId = "acct-1";
  h.roleOk = true;
  h.verifyImpl = null;
  h.verifyCalls = [];
  h.savedInputs = [];
});

describe("POST /api/integrations/meta-crm/datasets/register", () => {
  it("verifies via Meta and saves without creating in Meta", async () => {
    const res = await POST(
      post({
        datasetId: "1830596054845292",
        businessPortfolioId: "1171141236081090",
        accessToken: "USER_TOKEN_VALUE",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      dataset: { datasetId: string; datasetName: string; creationStatus: string };
    };
    expect(json.ok).toBe(true);
    expect(json.dataset.datasetId).toBe("1830596054845292");
    expect(json.dataset.datasetName).toBe("IM 22 Nov");
    expect(json.dataset.creationStatus).toBe("Registered");
    expect(JSON.stringify(json)).not.toContain("USER_TOKEN_VALUE");
    expect(h.verifyCalls).toHaveLength(1);
    expect(h.savedInputs).toHaveLength(1);
    expect(h.savedInputs[0].accountId).toBe("acct-1");
  });

  it("rejects invalid ids without verifying", async () => {
    const res = await POST(
      post({ datasetId: "abc", businessPortfolioId: "", accessToken: "" }),
    );
    expect(res.status).toBe(400);
    expect(h.verifyCalls).toHaveLength(0);
    expect(h.savedInputs).toHaveLength(0);
  });

  it("requires admin and isolates tenants", async () => {
    h.roleOk = false;
    const res = await POST(
      post({
        datasetId: "1830596054845292",
        businessPortfolioId: "1171141236081090",
        accessToken: "USER_TOKEN_VALUE",
      }),
    );
    expect(res.status).toBe(403);
    expect(h.verifyCalls).toHaveLength(0);
  });

  it("surfaces Meta verification failures with codes and no token", async () => {
    const { MetaCrmError } = await import("@/lib/meta-crm/datasets");
    h.verifyImpl = async () => {
      throw new MetaCrmError({
        code: "forbidden",
        message: "Meta refused: this token cannot access that dataset (code 200).",
        status: 403,
        metaCode: 200,
        metaSubcode: null,
      });
    };
    const res = await POST(
      post({
        datasetId: "1830596054845292",
        businessPortfolioId: "1171141236081090",
        accessToken: "SECRET_XYZ",
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.metaCode).toBe(200);
    expect(JSON.stringify(json)).not.toContain("SECRET_XYZ");
    expect(h.savedInputs).toHaveLength(0);
  });
});
