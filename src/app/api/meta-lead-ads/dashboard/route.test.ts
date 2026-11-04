import { beforeEach, describe, expect, it, vi } from "vitest";

// The Meta dashboard route resolves the caller via getCurrentAccount
// and runs get_meta_leads_analytics with caller-local day bounds.
// We stub the account context and the RPC, then assert validation
// and the exact RPC argument mapping (no account_id ever sent).

const h = vi.hoisted(() => ({
  rpcArgs: null as Record<string, unknown> | null,
  rpcData: {} as Record<string, unknown>,
  rpcError: null as { message: string } | null,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: {
      rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
        h.rpcArgs = args;
        return { data: h.rpcData, error: h.rpcError };
      }),
    },
    userId: "user-1",
    accountId: "acct-1",
    role: "owner",
    account: { id: "acct-1", name: "Acme" },
  }),
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

const { GET } = await import("./route");

const URL =
  "https://app.test/api/meta-lead-ads/dashboard?start=2026-09-22T00:00:00.000Z&end=2026-09-23T00:00:00.000Z&prevStart=2026-09-21T00:00:00.000Z&prevEnd=2026-09-22T00:00:00.000Z&year=2026&tz=Asia%2FKolkata";

beforeEach(() => {
  h.rpcArgs = null;
  h.rpcData = { todayLeads: 3, yesterdayLeads: 1, daily: [], monthly: [] };
  h.rpcError = null;
});

describe("GET /api/meta-lead-ads/dashboard", () => {
  it("passes caller-local bounds, year, and tz to the RPC (never an account id)", async () => {
    const res = await GET(new Request(URL));
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({
      p_today_start: "2026-09-22T00:00:00.000Z",
      p_today_end: "2026-09-23T00:00:00.000Z",
      p_yest_start: "2026-09-21T00:00:00.000Z",
      p_yest_end: "2026-09-22T00:00:00.000Z",
      p_year: 2026,
      p_tz: "Asia/Kolkata",
    });
    expect(h.rpcArgs).not.toHaveProperty("account_id");
    expect(h.rpcArgs).not.toHaveProperty("p_account_id");
  });

  it("returns the RPC payload verbatim with no-store caching", async () => {
    const res = await GET(new Request(URL));
    expect(await res.json()).toMatchObject({ todayLeads: 3, yesterdayLeads: 1 });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects missing bounds, bad years, and inverted ranges", async () => {
    const base = "https://app.test/api/meta-lead-ads/dashboard";
    expect((await GET(new Request(`${base}?year=2026`))).status).toBe(400);
    const badYear = `${base}?start=2026-09-22T00:00:00.000Z&end=2026-09-23T00:00:00.000Z&prevStart=2026-09-21T00:00:00.000Z&prevEnd=2026-09-22T00:00:00.000Z&year=1999`;
    expect((await GET(new Request(badYear))).status).toBe(400);
    const inverted = `${base}?start=2026-09-23T00:00:00.000Z&end=2026-09-22T00:00:00.000Z&prevStart=2026-09-21T00:00:00.000Z&prevEnd=2026-09-22T00:00:00.000Z&year=2026`;
    expect((await GET(new Request(inverted))).status).toBe(400);
  });

  it("surfaces RPC failures as 500 without leaking internals", async () => {
    h.rpcError = { message: "db down" };
    const res = await GET(new Request(URL));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load Meta Lead Ads analytics" });
  });
});
