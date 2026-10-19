// Meta Lead Ads — OAuth Page selection route.
//
// Pins the multi-tenant OAuth selection contract:
//   * only Pages from the caller's own verified session are accepted;
//   * foreign sessions and unlisted Pages are rejected before Meta;
//   * a duplicate Page maps to the generic conflict;
//   * successful selection saves an OAuth connection and clears the session;
//   * tokens never appear in responses.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "user-1",
  session: null as {
    account_id: string;
    user_id: string;
    access_token: string;
    token_expiry: string | null;
    scopes: string[];
    meta_user_id: string | null;
    meta_user_name: string | null;
    pages: Array<{ id: string; name: string | null; tasks: string[] }>;
  } | null,
  connection: null as { dataset_id: string | null } | null,
  foreign: [] as Array<Record<string, unknown>>,
  connectError: null as unknown,
  connectedChecks: [{ name: "Token app", ok: true, detail: "ok" }],
  connectCalls: 0,
  saved: [] as Array<Record<string, unknown>>,
  deleted: 0,
  debug: { isValid: true, appId: "1", type: "USER" },
}));

function adminClient() {
  function builder() {
    const b = {
      select: () => b,
      eq: () => b,
      neq: () => b,
      limit: async () => ({ data: h.foreign, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: h.foreign, error: null }).then(res, rej),
    };
    return b;
  }
  return { from: () => builder() };
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => ({ accountId: h.accountId, userId: h.userId, supabase: {} }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => adminClient(),
}));

vi.mock("@/lib/contacts/dedupe", () => ({
  isUniqueViolation: (error: unknown) =>
    (error as { code?: string }).code === "23505",
}));

vi.mock("@/lib/meta-lead-ads/graph-client", () => ({
  debugToken: async () => h.debug,
}));

vi.mock("@/lib/meta-lead-ads/connect-page", () => ({
  connectPage: async (_db: unknown, _config: unknown, args: { pageId: string }) => {
    h.connectCalls += 1;
    if (h.connectError) throw h.connectError;
    return {
      pageId: args.pageId,
      pageName: "One",
      subscribed: true,
      webhookVerified: true,
      warning: null,
      checks: h.connectedChecks,
    };
  },
}));

vi.mock("@/lib/meta-lead-ads/store", () => ({
  getOAuthSession: async () => h.session,
  getConnection: async () => h.connection,
  saveOAuthConnection: async (
    _db: unknown,
    accountId: string,
    input: Record<string, unknown>,
  ) => {
    h.saved.push({ accountId, ...input });
  },
  deleteOAuthSession: async () => {
    h.deleted += 1;
  },
}));

const { POST } = await import("./route");

function post(body: unknown) {
  return new Request(
    "https://whatsappmax.in/api/integrations/meta-lead-ads/oauth/pages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.session = {
    account_id: "acct-1",
    user_id: "user-1",
    access_token: "session-user-token",
    token_expiry: null,
    scopes: ["pages_show_list"],
    meta_user_id: "U1",
    meta_user_name: "Olive",
    pages: [{ id: "1029384756", name: "One", tasks: ["MANAGE"] }],
  };
  h.connection = { dataset_id: "D1" };
  h.foreign = [];
  h.connectError = null;
  h.connectCalls = 0;
  h.saved = [];
  h.deleted = 0;
  h.debug = { isValid: true, appId: "1", type: "USER" };
  process.env.META_LEAD_ADS_APP_ID = "1";
  process.env.META_LEAD_ADS_APP_SECRET = "platform-secret";
  process.env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.META_GRAPH_VERSION = "v26.0";
});

describe("POST /oauth/pages", () => {
  it("rejects Pages that were not authorized in this session", async () => {
    const res = await POST(post({ page_ids: ["1029384756", "1029384757"] }));

    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe(
      "unauthorized_page_selection",
    );
    expect(h.connectCalls).toBe(0);
    expect(h.saved).toHaveLength(0);
    expect(h.deleted).toBe(0);
  });

  it("rejects a session that belongs to another account", async () => {
    h.session = h.session
      ? { ...h.session, account_id: "acct-2", user_id: "user-9" }
      : h.session;

    const res = await POST(post({ page_ids: ["1029384756"] }));

    expect(res.status).toBe(409);
    expect(h.connectCalls).toBe(0);
    expect(h.saved).toHaveLength(0);
  });

  it("maps a duplicate Page to the generic conflict", async () => {
    h.foreign = [{ account_id: "acct-2" }];

    const res = await POST(post({ page_ids: ["1029384756"] }));
    const json = (await res.json()) as {
      ok: boolean;
      pages: Array<{ code: string; checks: unknown[] }>;
    };

    expect(json.ok).toBe(false);
    expect(json.pages[0].code).toBe("page_already_connected");
    expect(h.connectCalls).toBe(0);
    expect(h.saved).toHaveLength(0);
    expect(h.deleted).toBe(0);
  });

  it("saves an OAuth connection, clears the session, and never returns the token", async () => {
    const res = await POST(post({ page_ids: ["1029384756"] }));
    const json = (await res.json()) as {
      ok: boolean;
      connection: { setupSource: string };
      pages: Array<{ pageId: string; checks: unknown[] }>;
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.connection.setupSource).toBe("oauth");
    expect(json.pages[0].checks).toHaveLength(1);
    expect(h.connectCalls).toBe(1);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      accountId: "acct-1",
      tokenAppId: "1",
      datasetId: "D1",
    });
    expect(h.deleted).toBe(1);
    expect(JSON.stringify(json)).not.toContain("session-user-token");
  });

  it("keeps the session when every selected Page fails", async () => {
    h.connectError = Object.assign(new Error("Meta refused the Page"), {
      code: "permission_denied",
    });

    const res = await POST(post({ page_ids: ["1029384756"] }));
    const json = (await res.json()) as { ok: boolean };

    expect(json.ok).toBe(false);
    expect(h.saved).toHaveLength(0);
    expect(h.deleted).toBe(0);
  });
});
