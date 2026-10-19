// Meta Lead Ads — manual Page connection route.
//
// Covers the multi-tenant and manual-setup contracts:
//   * GET lists only this account's stored Pages (no OAuth discovery);
//   * a Page owned by another account is REJECTED with a generic 409
//     before any side effect;
//   * a valid Page is verified with the stored token, subscribed and
//     persisted with an encrypted Page token;
//   * a failed webhook subscription still keeps the valid connection
//     (polling fallback) and reports the warning;
//   * a racing unique violation maps to the same 409;
//   * deletion is scoped to the caller's account.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  foreign: [] as Array<Record<string, unknown>>,
  upsertError: null as Record<string, unknown> | null,
  upserts: [] as Array<Record<string, unknown>>,
  disconnected: [] as Array<{ accountId: string; pageId: string }>,
  calls: [] as string[],
  page: {
    id: "P1",
    name: "My Page",
    access_token: "page-tok",
    tasks: ["MANAGE"],
  } as Record<string, unknown> | null,
  getPageError: null as Error | null,
  tokenAppId: "1" as string | null,
  tokenValid: true,
  appConfigured: true,
  subscribed: true,
  verified: true,
  storedRows: [] as Array<Record<string, unknown>>,
  accountFilters: [] as unknown[],
}));

function rlsClient() {
  function builder() {
    const filters: Array<[string, unknown]> = [];
    const matched = () =>
      h.storedRows.filter((r) => filters.every(([c, v]) => r[c] === v));
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        if (c === "account_id") h.accountFilters.push(v);
        return b;
      },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      upsert: async (p: Record<string, unknown>) => {
        h.upserts.push(p);
        return { data: null, error: h.upsertError };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: matched(), error: null }).then(res, rej),
    };
    return b;
  }
  return { from: () => builder() } as unknown as SupabaseClient;
}

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
  return { from: () => builder() } as unknown as SupabaseClient;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: rlsClient(),
    accountId: h.accountId,
    userId: "user-1",
  }),
  requireRole: async () => ({
    supabase: rlsClient(),
    accountId: h.accountId,
    userId: "user-1",
  }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => adminClient(),
}));

vi.mock("@/lib/meta-lead-ads/graph-client", () => ({
  getPage: async () => {
    if (h.getPageError) throw h.getPageError;
    return h.page;
  },
  listForms: async () => [],
  probeFormLeadAccess: async () => true,
  getDataset: async () => ({ id: "D1" }),
  debugToken: async () => ({
    isValid: h.tokenValid,
    appId: h.tokenAppId,
    scopes: ["pages_show_list"],
    expiresAt: null,
    userId: "u1",
    type: "USER",
    error: null,
  }),
  getAppPageSubscriptions: async () => ({
    configured: h.appConfigured,
    callbackUrl: "https://app.test/api/integrations/meta-lead-ads/webhook",
    fields: h.appConfigured ? ["leadgen"] : [],
  }),
  subscribePageToLeadgen: async () => {
    h.calls.push("subscribe");
    return h.subscribed;
  },
  inspectPageSubscriptions: async () => {
    h.calls.push("verify");
    return {
      subscribed: h.verified,
      appIdMatched: h.verified,
      entries: h.verified
        ? [{ id: "1", name: "App", subscribedFields: ["leadgen"] }]
        : [],
    };
  },
  getPageSubscriptions: async () => {
    h.calls.push("verify");
    return h.verified;
  },
  unsubscribePageFromLeadgen: async () => {
    h.calls.push("unsubscribe");
    return true;
  },
}));

vi.mock("@/lib/meta-lead-ads/store", () => ({
  getUserToken: async () => "user-token",
  getPageToken: async () => "page-token",
  disconnectPage: async (
    _db: unknown,
    accountId: string,
    pageId: string,
  ): Promise<void> => {
    h.disconnected.push({ accountId, pageId });
  },
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  encrypt: (value: string) => `enc:${value}`,
}));

const { GET, POST, DELETE } = await import("./route");

const post = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-lead-ads/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const del = (pageId: string) =>
  new Request(
    `https://app.test/api/integrations/meta-lead-ads/pages?page_id=${encodeURIComponent(pageId)}`,
    { method: "DELETE" },
  );

beforeEach(() => {
  h.accountId = "acct-1";
  h.foreign = [];
  h.upsertError = null;
  h.upserts = [];
  h.disconnected = [];
  h.calls = [];
  h.page = {
    id: "1029384756",
    name: "My Page",
    access_token: "page-tok",
    tasks: ["MANAGE"],
  };
  h.getPageError = null;
  h.tokenAppId = "1";
  h.tokenValid = true;
  h.appConfigured = true;
  h.subscribed = true;
  h.verified = true;
  h.storedRows = [];
  h.accountFilters = [];
  process.env.META_LEAD_ADS_APP_ID = "1";
  process.env.META_LEAD_ADS_APP_SECRET = "secret";
  process.env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.META_GRAPH_VERSION = "v21.0";
});

describe("POST /pages — manual Page connection", () => {
  it("rejects a Page already connected to another account", async () => {
    h.foreign = [{ account_id: "acct-2" }];

    const res = await POST(post({ page_id: "1029384756" }));

    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe("page_already_connected");
    // The response must not leak the other account's identity.
    expect(JSON.stringify(json)).not.toContain("acct-2");
    // Refused before any side effect.
    expect(h.calls).not.toContain("subscribe");
    expect(h.upserts).toHaveLength(0);
  });

  it("verifies, subscribes and stores the Page token encrypted", async () => {
    const res = await POST(post({ page_id: "1029384756" }));

    expect(res.status).toBe(200);
    expect(h.calls).toContain("subscribe");
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({
      account_id: "acct-1",
      page_id: "1029384756",
      page_name: "My Page",
      subscribed: true,
      webhook_verified: true,
    });
    expect(h.upserts[0].access_token).toBe("enc:page-tok");
  });

  it("keeps a valid Page when the webhook cannot be subscribed", async () => {
    h.subscribed = false;
    h.verified = false;

    const res = await POST(post({ page_id: "1029384756" }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      page: { subscribed: boolean; webhookVerified: boolean; warning: string | null };
    };
    expect(json.ok).toBe(true);
    expect(json.page.subscribed).toBe(false);
    expect(json.page.webhookVerified).toBe(false);
    expect(h.upserts[0]).toMatchObject({
      subscribed: false,
      webhook_verified: false,
    });
  });

  it("keeps the connection when app-level leadgen is not configured", async () => {
    h.appConfigured = false;
    h.verified = true;
    h.subscribed = true;

    const res = await POST(post({ page_id: "1029384756" }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      page: { subscribed: boolean; webhookVerified: boolean; warning: string | null };
    };
    expect(json.page.subscribed).toBe(true);
    expect(json.page.webhookVerified).toBe(false);
    expect(json.page.warning ?? "").toContain("App webhook (leadgen)");
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({
      account_id: "acct-1",
      page_id: "1029384756",
      webhook_verified: false,
    });
  });

  it("maps a racing unique violation to the duplicate error", async () => {
    h.upsertError = {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    };

    const res = await POST(post({ page_id: "1029384756" }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).code).toBe(
      "page_already_connected",
    );
  });

  it("rejects a non-numeric Page ID before calling Meta", async () => {
    const res = await POST(post({ page_id: "my-page-name" }));

    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });
});

describe("DELETE /pages — cross-account safety", () => {
  it("scopes deletion to the caller's account", async () => {
    const res = await DELETE(del("P1"));

    expect(res.status).toBe(200);
    expect(h.disconnected).toEqual([{ accountId: "acct-1", pageId: "P1" }]);
  });
});

describe("GET /pages — tenant scoping without discovery", () => {
  it("returns stored Pages only for the caller's account", async () => {
    h.storedRows = [
      {
        page_id: "P1",
        account_id: "acct-1",
        page_name: "My Page",
        subscribed: true,
        webhook_verified: true,
        last_error: null,
        last_synced_at: null,
        last_polled_at: null,
      },
      {
        page_id: "P2",
        account_id: "acct-2",
        page_name: "Other",
        subscribed: true,
        webhook_verified: true,
        last_error: null,
        last_synced_at: null,
        last_polled_at: null,
      },
    ];

    const res = await GET();
    const json = (await res.json()) as { pages: Array<{ pageId: string }> };

    expect(json.pages.map((p) => p.pageId)).toEqual(["P1"]);
    expect(h.accountFilters).toContain("acct-1");
  });
});
