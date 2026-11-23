import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  profiles: [] as Array<Record<string, unknown>>,
  holidays: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  flows: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status },
    );
  },
}));

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const state: { table: string; filters: Filter[]; orderCol: string | null } = {
      table,
      filters: [],
      orderCol: null,
    };
    const store = (): Array<Record<string, unknown>> => {
      if (table === "profiles") return h.profiles;
      if (table === "lead_assignment_holidays") return h.holidays;
      if (table === "lead_assignment_table_configs") return h.configs;
      if (table === "lead_assignment_table_assignees") return h.assignees;
      if (table === "flows") return h.flows;
      return [];
    };
    const matched = () => {
      let list = store().filter((r) =>
        state.filters.every((f) =>
          f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
        ),
      );
      if (state.orderCol) {
        const col = state.orderCol;
        list = [...list].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
      }
      return list;
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        state.filters.push({ col, op: "eq", val });
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        state.filters.push({ col, op: "in", val: vals });
        return q;
      },
      order: (col: string) => {
        state.orderCol = col;
        return q;
      },
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      single: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
    };
    return q;
  };
  return api;
}

const { GET } = await import("./route");

function member(userId: string, role = "agent", fullName?: string) {
  return {
    user_id: userId,
    account_id: "acct-1",
    full_name: fullName ?? userId,
    account_role: role,
  };
}

beforeEach(() => {
  h.authed = true;
  h.role = "owner";
  h.accountId = "acct-1";
  h.userId = "owner-1";
  h.profiles = [
    member("u-pooja", "agent", "Pooja"),
    member("u-rita", "agent", "Rita"),
    member("u-viewer", "viewer", "Viewer"),
  ];
  h.holidays = [
    {
      id: "hol-1", account_id: "acct-1", user_id: "u-pooja",
      start_date: "2000-01-01", end_date: "2999-12-31", reason: "Annual leave", cancelled_at: null,
    },
  ];
  h.configs = [{ id: "cfg-1", account_id: "acct-1", flow_id: "flow-1" }];
  h.assignees = [
    { id: "a-1", config_id: "cfg-1", user_id: "u-pooja" },
    { id: "a-2", config_id: "cfg-1", user_id: "u-rita" },
  ];
  h.flows = [{ id: "flow-1", account_id: "acct-1", name: "Meta Lead Ads · Rajasthan" }];
});

describe("GET /api/team-availability/overview", () => {
  it("403s for admin, agent, and viewer (owner only)", async () => {
    for (const role of ["admin", "agent", "viewer"]) {
      h.role = role;
      const res = await GET();
      expect(res.status).toBe(403);
    }
  });

  it("401s when unauthenticated", async () => {
    h.authed = false;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("derives KPIs from live holiday windows (viewers excluded)", async () => {
    h.role = "owner";
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kpis: Record<string, number>;
      members: Array<Record<string, unknown>>;
    };
    // Viewer is not an eligible team member; Pooja is on holiday.
    expect(body.kpis.totalMembers).toBe(2);
    expect(body.kpis.onHoliday).toBe(1);
    expect(body.kpis.availableToday).toBe(1);
    expect(body.kpis.assignmentsAdjusted).toBe(1);
    const pooja = body.members.find((m) => m.user_id === "u-pooja")!;
    expect(pooja.availability).toBe("on_holiday");
    expect(pooja.affects_tables).toEqual(["Meta Lead Ads · Rajasthan"]);
    expect(body.members.find((m) => m.user_id === "u-rita")!.availability).toBe("available");
  });

  it("completed holidays restore availability; cancelled rows are hidden", async () => {
    h.holidays = [
      {
        id: "hol-past", account_id: "acct-1", user_id: "u-pooja",
        start_date: "2000-01-01", end_date: "2000-01-02", reason: null, cancelled_at: null,
      },
      {
        id: "hol-cancelled", account_id: "acct-1", user_id: "u-rita",
        start_date: "2000-01-01", end_date: "2999-12-31", reason: null,
        cancelled_at: "2026-11-24T00:00:00.000Z",
      },
    ];
    const res = await GET();
    const body = (await res.json()) as {
      kpis: Record<string, number>;
      members: Array<{ user_id: string; holidays: unknown[] }>;
    };
    expect(body.kpis.onHoliday).toBe(0);
    expect(body.kpis.assignmentsAdjusted).toBe(0);
    expect(body.members.find((m) => m.user_id === "u-pooja")!.holidays).toHaveLength(1);
    expect(body.members.find((m) => m.user_id === "u-rita")!.holidays).toHaveLength(0);
  });

  it("isolates tenants", async () => {
    h.accountId = "acct-OTHER";
    const res = await GET();
    const body = (await res.json()) as { kpis: Record<string, number>; members: unknown[] };
    expect(body.members).toHaveLength(0);
    expect(body.kpis.totalMembers).toBe(0);
  });
});
