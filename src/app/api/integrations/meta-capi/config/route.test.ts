// Meta Conversions API — config route.
//
// Guarantees: input validation, tenant scoping, and that a dataset +
// token pair is verified with Meta before being marked connected.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetaGraphError } from "@/lib/meta-lead-ads/errors";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  roleOk: true,
  config: null as Record<string, unknown> | null,
  saved: [] as Array<{ fn: string; args: unknown[] }>,
  verifyThrows: false,
  appSecret: null as string | null,
  verifyOpts: null as Record<string, unknown> | null,
  verifyError: null as unknown,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => {
    if (!h.roleOk) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return { supabase: {}, accountId: h.accountId, userId: "u1" };
  },
  getCurrentAccount: async () => ({
    supabase: {},
    accountId: h.accountId,
    userId: "u1",
  }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

vi.mock("@/lib/meta-capi/triggers", () => ({
  metaCapiPlatform: () => ({ graphVersion: "v21.0" }),
}));

vi.mock("@/lib/meta-capi/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta-capi/client")>();
  return {
    ...actual,
    validateDataset: async (
      _p: unknown,
      datasetId: string,
      _token: string,
      opts?: Record<string, unknown>,
    ) => {
      h.verifyOpts = opts ?? null;
      if (h.verifyError) throw h.verifyError;
      if (h.verifyThrows) throw new Error("bad");
      return { id: datasetId, name: "My Dataset" };
    },
  };
});

vi.mock("@/lib/meta-capi/store", () => ({
  getConfig: async () => h.config,
  getDecryptedToken: async () => "tok",
  getDecryptedAppSecret: async () => h.appSecret,
  saveDataset: async (_db: unknown, accountId: string, datasetId: string) => {
    h.saved.push({ fn: "saveDataset", args: [accountId, datasetId] });
    h.config = { ...(h.config ?? {}), account_id: accountId, dataset_id: datasetId };
  },
  saveToken: async (_db: unknown, accountId: string) => {
    h.saved.push({ fn: "saveToken", args: [accountId] });
    h.config = { ...(h.config ?? {}), account_id: accountId, access_token: "enc" };
  },
  saveAppSecret: async (_db: unknown, accountId: string) => {
    h.saved.push({ fn: "saveAppSecret", args: [accountId] });
    h.config = { ...(h.config ?? {}), app_secret: "enc" };
  },
  clearAppSecret: async () => {
    h.saved.push({ fn: "clearAppSecret", args: [] });
  },
  markConfigStatus: async (
    _db: unknown,
    accountId: string,
    status: string,
    lastError: string | null,
  ) => {
    h.saved.push({ fn: "markConfigStatus", args: [accountId, status, lastError] });
    h.config = { ...(h.config ?? {}), status, last_error: lastError };
  },
  clearCredentials: async () => {
    h.saved.push({ fn: "clearCredentials", args: [] });
    h.config = null;
  },
  clearToken: async () => {},
  saveActionSource: async () => {},
  saveSetupStep: async () => {},
  saveTestEventCode: async () => {},
}));

const { PUT, DELETE } = await import("./route");

const put = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-capi/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.accountId = "acct-1";
  h.roleOk = true;
  h.config = null;
  h.saved = [];
  h.verifyThrows = false;
  h.appSecret = null;
  h.verifyOpts = null;
  h.verifyError = null;
});

describe("PUT /meta-capi/config", () => {
  it("rejects a non-numeric dataset id before saving", async () => {
    const res = await PUT(put({ dataset_id: "not-a-number" }));
    expect(res.status).toBe(400);
    expect(h.saved.some((s) => s.fn === "saveDataset")).toBe(false);
  });

  it("saves the dataset + token (encrypted) and verifies, then marks connected", async () => {
    const res = await PUT(
      put({ dataset_id: "1234567890", access_token: "EAAG-token-value-1234567890" }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { config: { status: string; hasToken: boolean } };
    expect(json.config.status).toBe("connected");
    expect(json.config.hasToken).toBe(true);
    // Tenant scoping: writes carry the caller's account.
    expect(h.saved.find((s) => s.fn === "saveDataset")?.args[0]).toBe("acct-1");
    // Token never returned.
    expect(JSON.stringify(json)).not.toContain("EAAG-token-value");
  });

  it("marks the integration errored when Meta rejects the pair", async () => {
    h.verifyThrows = true;
    const res = await PUT(
      put({ dataset_id: "1234567890", access_token: "EAAG-token-value-1234567890" }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("verification_failed");
    expect(
      h.saved.find((s) => s.fn === "markConfigStatus")?.args[1],
    ).toBe("error");
  });

  it("saves an optional customer App Secret", async () => {
    const res = await PUT(put({ app_secret: "abcdefghijklmnopqrstuvwxyz012345" }));
    expect(res.status).toBe(200);
    expect(h.saved.find((s) => s.fn === "saveAppSecret")?.args[0]).toBe("acct-1");
  });

  it("clears the App Secret when null", async () => {
    const res = await PUT(put({ app_secret: null }));
    expect(res.status).toBe(200);
    expect(h.saved.some((s) => s.fn === "clearAppSecret")).toBe(true);
  });

  it("rejects a malformed App Secret before saving", async () => {
    const res = await PUT(put({ app_secret: "short" }));
    expect(res.status).toBe(400);
    expect(h.saved.some((s) => s.fn === "saveAppSecret")).toBe(false);
  });

  it("uses the stored customer App Secret when verifying", async () => {
    h.appSecret = "customer-app-secret";
    const res = await PUT(
      put({ dataset_id: "1234567890", access_token: "EAAG-token-value-1234567890" }),
    );
    expect(res.status).toBe(200);
    expect(h.verifyOpts).toMatchObject({ appSecret: "customer-app-secret" });
  });

  it("maps Invalid appsecret_proof to an actionable, secret-free error", async () => {
    h.verifyError = new MetaGraphError({
      message: "Invalid appsecret_proof provided in the API argument",
      graphType: "OAuthException",
      graphCode: 1,
      graphStatus: 400,
      status: 400,
    });
    const res = await PUT(
      put({ dataset_id: "1234567890", access_token: "EAAG-token-value-1234567890" }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe("verification_failed");
    expect(json.error).toMatch(/appsecret_proof/i);
    expect(json.error).toMatch(/App Secret/i);
    expect(JSON.stringify(json)).not.toContain("EAAG-token-value");
    expect(h.saved.find((s) => s.fn === "markConfigStatus")?.args[1]).toBe("error");
  });

  it("maps an invalid token to an actionable error", async () => {
    h.verifyError = new MetaGraphError({
      message: "Invalid OAuth access token.",
      graphType: "OAuthException",
      graphCode: 190,
      graphStatus: 400,
      status: 401,
    });
    const res = await PUT(
      put({ dataset_id: "1234567890", access_token: "EAAG-token-value-1234567890" }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid, expired, or revoked/i);
  });

  it("maps insufficient dataset permissions to an actionable error", async () => {
    h.verifyError = new MetaGraphError({
      message: "(#200) Requires ads_management permission",
      graphCode: 200,
      graphStatus: 400,
      status: 400,
    });
    const res = await PUT(
      put({ dataset_id: "1234567890", access_token: "EAAG-token-value-1234567890" }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/lacks permission/i);
  });

  it("requires an admin role", async () => {
    h.roleOk = false;
    const res = await PUT(put({ dataset_id: "1234567890" }));
    expect(res.status).toBe(403);
  });
});

describe("DELETE /meta-capi/config", () => {
  it("clears credentials for the caller's account only", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(h.saved.filter((s) => s.fn === "clearCredentials")).toHaveLength(1);
  });
});
