// Meta Lead Ads — Pages route tenant guard.
//
// Covers the multi-tenant rules for connecting/disconnecting a
// Facebook Page:
//   * a Page already owned by another account is REJECTED (generic
//     409 — no leak of the other account) and nothing is subscribed;
//   * a connection that can't be verified is NOT persisted (no
//     partial subscription / inconsistent record) and is rolled back;
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
  pages: [] as Array<Record<string, unknown>>,
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
  listPages: async () => h.pages,
  subscribePageToLeadgen: async () => {
    h.calls.push("subscribe");
    return true;
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
  getConnection: async () => ({ id: "conn-1", account_id: h.accountId }),
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
  h.pages = [{ id: "P1", name: "My Page", access_token: "page-tok", tasks: ["MANAGE"] }];
  h.verified = true;
  h.storedRows = [];
  h.accountFilters = [];
  process.env.META_LEAD_ADS_APP_ID = "1";
  process.env.META_LEAD_ADS_APP_SECRET = "secret";
  process.env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.META_GRAPH_VERSION = "v21.0";
});

describe("POST /pages — duplicate protection", () => {
  it("rejects a Page already connected to another account", async () => {
    h.foreign = [{ account_id: "acct-2" }];

    const res = await POST(post({ page_id: "P1" }));

    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe("page_already_connected");
    // The response must not leak the other account's identity.
    expect(JSON.stringify(json)).not.toContain("acct-2");
    // Refused before any side effect.
    expect(h.calls).not.toContain("subscribe");
    expect(h.upserts).toHaveLength(0);
  });

  it("connects an unclaimed Page and stores it encrypted", async () => {
    const res = await POST(post({ page_id: "P1" }));

    expect(res.status).toBe(200);
    expect(h.calls).toContain("subscribe");
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({
      account_id: "acct-1",
      page_id: "P1",
      subscribed: true,
      webhook_verified: true,
    });
    expect(h.upserts[0].access_token).toBe("enc:page-tok");
  });

  it("leaves NO partial connection when the subscription can't be verified", async () => {
    h.verified = false;

    const res = await POST(post({ page_id: "P1" }));

    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe("subscription_failed");
    expect(h.upserts).toHaveLength(0);
    // Half-open subscription is rolled back.
    expect(h.calls).toContain("unsubscribe");
  });

  it("maps a racing unique violation to the duplicate error", async () => {
    h.upsertError = {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    };

    const res = await POST(post({ page_id: "P1" }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).code).toBe(
      "page_already_connected",
    );
  });
});

describe("DELETE /pages — cross-account safety", () => {
  it("scopes deletion to the caller's account", async () => {
    const res = await DELETE(del("P1"));

    expect(res.status).toBe(200);
    // Only the caller's account is passed to the delete helper, so a
    // like-named Page owned by another account can never be removed.
    expect(h.disconnected).toEqual([{ accountId: "acct-1", pageId: "P1" }]);
  });
});

describe("GET /pages — tenant scoping", () => {
  it("queries stored Pages only for the caller's account", async () => {
    h.storedRows = [
      {
        page_id: "P1",
        account_id: "acct-1",
        page_name: "My Page",
        subscribed: true,
        webhook_verified: true,
        last_error: null,
      },
    ];

    const res = await GET();
    const json = (await res.json()) as { pages: Array<{ pageId: string }> };

    expect(json.pages.map((p) => p.pageId)).toContain("P1");
    expect(h.accountFilters).toContain("acct-1");
  });
});
