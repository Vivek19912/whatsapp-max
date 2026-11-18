import { beforeEach, describe, expect, it, vi } from "vitest";

// The agent dashboard route is self-scoped: any authenticated member
// may call it, and the RPC derives the member from auth.uid() — no
// member/account_id param exists, so cross-agent reads are
// impossible by construction. We stub the account context and the
// RPC, then assert validation and the exact RPC argument mapping.

const h = vi.hoisted(() => ({
  rpcFn: null as string | null,
  rpcArgs: null as Record<string, unknown> | null,
  rpcData: {} as Record<string, unknown>,
  rpcError: null as { message: string } | null,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        h.rpcFn = fn;
        h.rpcArgs = args;
        return { data: h.rpcData, error: h.rpcError };
      }),
    },
    userId: "user-agent-a",
    accountId: "acct-1",
    role: "agent",
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
  "https://app.test/api/meta-lead-ads/agent-dashboard?start=2026-09-22T00:00:00.000Z&end=2026-09-23T00:00:00.000Z&prevStart=2026-09-21T00:00:00.000Z&prevEnd=2026-09-22T00:00:00.000Z&year=2026&tz=Asia%2FKolkata";

beforeEach(() => {
  h.rpcFn = null;
  h.rpcArgs = null;
  h.rpcData = {
    assignedTotal: 5,
    todayLeads: 2,
    yesterdayLeads: 1,
    daily: [],
    monthly: [],
    stages: [],
  };
  h.rpcError = null;
});

describe("GET /api/meta-lead-ads/agent-dashboard", () => {
  it("calls the agent RPC with caller-local bounds and no member/account id", async () => {
    const res = await GET(new Request(URL));
    expect(res.status).toBe(200);
    expect(h.rpcFn).toBe("get_meta_leads_agent_analytics");
    expect(h.rpcArgs).toMatchObject({
      p_today_start: "2026-09-22T00:00:00.000Z",
      p_today_end: "2026-09-23T00:00:00.000Z",
      p_yest_start: "2026-09-21T00:00:00.000Z",
      p_yest_end: "2026-09-22T00:00:00.000Z",
      p_year: 2026,
      p_tz: "Asia/Kolkata",
    });
    // Self-scoping lives inside the RPC (auth.uid()) — the route
    // must never forward a member or account id.
    expect(h.rpcArgs).not.toHaveProperty("p_member");
    expect(h.rpcArgs).not.toHaveProperty("member");
    expect(h.rpcArgs).not.toHaveProperty("account_id");
    expect(h.rpcArgs).not.toHaveProperty("p_account_id");
  });

  it("returns assignedTotal/stages plus server-derived rolling KPIs with no-store caching", async () => {
    h.rpcData = {
      assignedTotal: 5,
      todayLeads: 2,
      yesterdayLeads: 1,
      daily: [
        { date: "2026-09-20", total: 1, forms: [] },
        { date: "2026-09-21", total: 2, forms: [] },
        { date: "2026-09-22", total: 1, forms: [] },
      ],
      monthly: [],
      stages: [{ stage: "New", leads: 3 }],
    };
    const res = await GET(new Request(URL));
    expect(await res.json()).toMatchObject({
      assignedTotal: 5,
      todayLeads: 2,
      yesterdayLeads: 1,
      last7Leads: 4,
      last30Leads: 4,
      stages: [{ stage: "New", leads: 3 }],
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects missing bounds, bad years, and inverted ranges", async () => {
    const base = "https://app.test/api/meta-lead-ads/agent-dashboard";
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
