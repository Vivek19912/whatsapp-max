// Meta Lead Ads — account disconnect tenant guard.
//
// Disconnecting one account must touch ONLY that account: the Page
// lookup is scoped by account_id, every Page is unsubscribed with that
// account's own token, and the teardown helper is called with the
// caller's account id alone.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  pages: [] as Array<{ page_id: string; account_id: string }>,
  unsubscribed: [] as string[],
  disconnectCalls: [] as string[],
  accountFilters: [] as unknown[],
}));

function rlsClient() {
  function builder() {
    const filters: Array<[string, unknown]> = [];
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        if (c === "account_id") h.accountFilters.push(v);
        return b;
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({
          data: h.pages.filter((r) =>
          filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v),
        ),
          error: null,
        }).then(res, rej),
    };
    return b;
  }
  return { from: () => builder() } as unknown as SupabaseClient;
}

vi.mock("@/lib/auth/account", () => ({
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

vi.mock("@/lib/meta-lead-ads/graph-client", () => ({
  unsubscribePageFromLeadgen: async (
    _config: unknown,
    _token: string,
    pageId: string,
  ) => {
    h.unsubscribed.push(pageId);
    return true;
  },
}));

vi.mock("@/lib/meta-lead-ads/store", () => ({
  getPageToken: async () => "page-token",
  disconnectAccount: async (_db: unknown, accountId: string): Promise<void> => {
    h.disconnectCalls.push(accountId);
  },
}));

const { POST } = await import("./route");

beforeEach(() => {
  h.accountId = "acct-1";
  h.pages = [
    { page_id: "P1", account_id: "acct-1" },
    { page_id: "P2", account_id: "acct-2" },
  ];
  h.unsubscribed = [];
  h.disconnectCalls = [];
  h.accountFilters = [];
  process.env.META_LEAD_ADS_APP_ID = "1";
  process.env.META_LEAD_ADS_APP_SECRET = "secret";
  process.env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.META_GRAPH_VERSION = "v21.0";
});

describe("POST /disconnect — tenant isolation", () => {
  it("disconnects only the caller's account", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(h.disconnectCalls).toEqual(["acct-1"]);
  });

  it("unsubscribes only the caller's Pages, never another account's", async () => {
    await POST();

    // Page lookup filtered to the caller's account…
    expect(h.accountFilters).toEqual(["acct-1"]);
    // …so only P1 (acct-1) is unsubscribed; P2 (acct-2) is untouched.
    expect(h.unsubscribed).toEqual(["P1"]);
    expect(h.unsubscribed).not.toContain("P2");
  });
});
