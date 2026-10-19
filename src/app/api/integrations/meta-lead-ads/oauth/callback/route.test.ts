// Meta Lead Ads — OAuth callback route.
//
// Covers the callback security contract with mocked Meta/store layers:
//   * cancellation is safe and does not require a stored state;
//   * unknown/replayed state is rejected before any token exchange;
//   * account mismatches are rejected;
//   * a valid grant creates a metadata-only session and redirects;
//   * tokens never appear in the redirect or cookies.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "user-1",
  authCalls: 0,
  stateRow: null as { accountId: string; userId: string } | null,
  exchangeCalls: 0,
  longLivedCalls: 0,
  exchangeError: null as unknown,
  debug: {
    isValid: true,
    appId: "1",
    scopes: ["pages_show_list"],
    expiresAt: null,
    userId: "U1",
    type: "USER",
    error: null,
  },
  pages: [{ id: "P1", name: "One", tasks: ["MANAGE"] }],
  sessionArgs: [] as unknown[],
  sessionId: "sess-1",
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => {
    h.authCalls += 1;
    return { accountId: h.accountId, userId: h.userId, supabase: {} };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({}),
}));

vi.mock("@/lib/meta-lead-ads/store", () => ({
  consumeOAuthState: async () => h.stateRow,
  createOAuthSession: async (_db: unknown, input: unknown) => {
    h.sessionArgs.push(input);
    return h.sessionId;
  },
}));

vi.mock("@/lib/meta-lead-ads/graph-client", () => ({
  exchangeCodeForToken: async () => {
    h.exchangeCalls += 1;
    if (h.exchangeError) throw h.exchangeError;
    return {
      accessToken: "short-token",
      tokenType: "bearer",
      expiresAt: null,
      scopes: [],
    };
  },
  exchangeForLongLivedToken: async () => {
    h.longLivedCalls += 1;
    return {
      accessToken: "long-token",
      tokenType: "bearer",
      expiresAt: "2026-04-01T00:00:00.000Z",
      scopes: ["pages_show_list"],
    };
  },
  debugToken: async () => h.debug,
  getOAuthUser: async () => ({ id: "U1", name: "Olive" }),
  listManagedPages: async () => h.pages,
}));

const { GET } = await import("./route");

function callbackUrl(search: string): Request {
  return new Request(
    `https://whatsappmax.in/api/integrations/meta-lead-ads/oauth/callback${search}`,
    { headers: { cookie: "wacrm_meta_lead_oauth_state=raw-state-123" } },
  );
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.authCalls = 0;
  h.stateRow = { accountId: "acct-1", userId: "user-1" };
  h.exchangeCalls = 0;
  h.longLivedCalls = 0;
  h.exchangeError = null;
  h.debug = {
    isValid: true,
    appId: "1",
    scopes: ["pages_show_list"],
    expiresAt: null,
    userId: "U1",
    type: "USER",
    error: null,
  };
  h.pages = [{ id: "P1", name: "One", tasks: ["MANAGE"] }];
  h.sessionArgs = [];
  process.env.META_LEAD_ADS_APP_ID = "1";
  process.env.META_LEAD_ADS_APP_SECRET = "platform-secret";
  process.env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.META_GRAPH_VERSION = "v26.0";
});

describe("GET /oauth/callback", () => {
  it("handles authorization cancellation without touching stored state", async () => {
    const res = await GET(callbackUrl("?error=access_denied"));

    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/settings?tab=meta-lead-ads");
    expect(location).toContain("meta_oauth=cancelled");
    expect(h.authCalls).toBe(0);
    expect(h.exchangeCalls).toBe(0);
    expect(h.sessionArgs).toHaveLength(0);
  });

  it("rejects an unknown or replayed state before exchanging the code", async () => {
    h.stateRow = null;

    const res = await GET(callbackUrl("?code=CODE&state=raw-state-123"));
    const location = res.headers.get("location") ?? "";

    expect(location).toContain("meta_oauth_error=invalid_state");
    expect(h.exchangeCalls).toBe(0);
    expect(h.sessionArgs).toHaveLength(0);
  });

  it("rejects an account mismatch", async () => {
    h.stateRow = { accountId: "acct-2", userId: "user-9" };

    const res = await GET(callbackUrl("?code=CODE&state=raw-state-123"));
    const location = res.headers.get("location") ?? "";

    expect(location).toContain("meta_oauth_error=account_mismatch");
    expect(h.exchangeCalls).toBe(0);
    expect(h.sessionArgs).toHaveLength(0);
  });

  it("creates a metadata-only session and redirects to selection", async () => {
    const res = await GET(callbackUrl("?code=CODE&state=raw-state-123"));

    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/settings?tab=meta-lead-ads");
    expect(location).toContain("meta_oauth=select");
    expect(location).not.toContain("short-token");
    expect(location).not.toContain("long-token");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("long-token");
    expect(h.exchangeCalls).toBe(1);
    expect(h.longLivedCalls).toBe(1);
    expect(h.sessionArgs).toHaveLength(1);
    const input = h.sessionArgs[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      accountId: "acct-1",
      userId: "user-1",
      metaUserId: "U1",
      metaUserName: "Olive",
    });
    expect(input.pages).toEqual([{ id: "P1", name: "One", tasks: ["MANAGE"] }]);
  });

  it("maps a token exchange failure to a safe reason", async () => {
    h.exchangeError = new Error("bad code");

    const res = await GET(callbackUrl("?code=BAD&state=raw-state-123"));
    const location = res.headers.get("location") ?? "";

    expect(location).toContain("meta_oauth_error=token_exchange_failed");
    expect(h.sessionArgs).toHaveLength(0);
  });
});
