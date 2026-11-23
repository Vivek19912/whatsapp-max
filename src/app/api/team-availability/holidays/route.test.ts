import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  profiles: [] as Array<Record<string, unknown>>,
  holidays: [] as Array<Record<string, unknown>>,
  seq: 0,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
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
    const state: {
      table: string;
      filters: Filter[];
      insertRow: Record<string, unknown> | null;
    } = { table, filters: [], insertRow: null };
    const store = (): Array<Record<string, unknown>> =>
      table === "profiles" ? h.profiles : table === "lead_assignment_holidays" ? h.holidays : [];
    const matched = () =>
      store().filter((r) =>
        state.filters.every((f) =>
          f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
        ),
      );
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
      insert: (obj: Record<string, unknown>) => {
        state.insertRow = obj;
        return q;
      },
      single: async () => {
        if (state.insertRow) {
          const row = { id: `hol-${++h.seq}`, cancelled_at: null, ...state.insertRow };
          if (state.table === "lead_assignment_holidays") h.holidays.push(row);
          return { data: row, error: null };
        }
        return { data: matched()[0] ?? null, error: null };
      },
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
    };
    return q;
  };
  return api;
}

const { POST } = await import("./route");

function req(body: unknown) {
  return new Request("http://localhost/api/team-availability/holidays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.role = "owner";
  h.accountId = "acct-1";
  h.userId = "owner-1";
  h.seq = 0;
  h.profiles = [
    { user_id: "u-pooja", account_id: "acct-1", account_role: "agent", full_name: "Pooja" },
    { user_id: "u-ext", account_id: "acct-1", account_role: "viewer", full_name: "Viewer" },
  ];
  h.holidays = [];
});

describe("POST /api/team-availability/holidays", () => {
  it("403s for non-owners", async () => {
    h.role = "admin";
    const res = await POST(req({ user_id: "u-pooja", start_date: "2026-11-25", end_date: "2026-11-30" }));
    expect(res.status).toBe(403);
  });

  it("creates a holiday for an eligible member", async () => {
    const res = await POST(
      req({ user_id: "u-pooja", start_date: "2026-11-25", end_date: "2026-11-30", reason: "Annual leave" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { holiday: Record<string, unknown> };
    expect(body.holiday.user_id).toBe("u-pooja");
    expect(body.holiday.start_date).toBe("2026-11-25");
    expect(body.holiday.reason).toBe("Annual leave");
    expect(h.holidays).toHaveLength(1);
  });

  it("rejects ineligible members, bad dates, and inverted ranges", async () => {
    // Viewer is not assignable; unknown id has no profile.
    for (const user_id of ["u-ext", "u-ghost"]) {
      const res = await POST(req({ user_id, start_date: "2026-11-25", end_date: "2026-11-30" }));
      expect(res.status).toBe(400);
    }
    const badDate = await POST(req({ user_id: "u-pooja", start_date: "2026-13-01", end_date: "2026-11-30" }));
    expect(badDate.status).toBe(400);
    const inverted = await POST(req({ user_id: "u-pooja", start_date: "2026-12-01", end_date: "2026-11-30" }));
    expect(inverted.status).toBe(400);
    expect(h.holidays).toHaveLength(0);
  });

  it("409s on overlapping live windows but allows completed history", async () => {
    h.holidays = [
      {
        id: "hol-live", account_id: "acct-1", user_id: "u-pooja",
        start_date: "2000-01-01", end_date: "2999-12-31", reason: null, cancelled_at: null,
      },
      {
        id: "hol-past", account_id: "acct-1", user_id: "u-pooja",
        start_date: "2000-01-01", end_date: "2000-01-02", reason: null, cancelled_at: null,
      },
    ];
    const overlap = await POST(req({ user_id: "u-pooja", start_date: "2026-11-25", end_date: "2026-11-30" }));
    expect(overlap.status).toBe(409);
    expect(h.holidays).toHaveLength(2);
  });
});
