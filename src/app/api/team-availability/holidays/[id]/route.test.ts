import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner",
  accountId: "acct-1",
  holidays: [] as Array<Record<string, unknown>>,
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
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: "owner-1", role: h.role };
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
      updateObj: Record<string, unknown> | null;
    } = { table, filters: [], updateObj: null };
    const matched = () =>
      h.holidays.filter((r) =>
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
      update: (obj: Record<string, unknown>) => {
        state.updateObj = obj;
        return q;
      },
      maybeSingle: async () => {
        if (state.updateObj) {
          const list = matched();
          for (const r of list) Object.assign(r, state.updateObj);
          return { data: list[0] ?? null, error: null };
        }
        return { data: matched()[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
    };
    return q;
  };
  return api;
}

const { PATCH } = await import("./route");
const { POST: cancel } = await import("./cancel/route");

function req(body: unknown) {
  return new Request("http://localhost/api/team-availability/holidays/hol-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.role = "owner";
  h.accountId = "acct-1";
  h.holidays = [
    {
      id: "hol-1", account_id: "acct-1", user_id: "u-pooja",
      start_date: "2026-11-25", end_date: "2026-11-30", reason: "Annual leave", cancelled_at: null,
    },
    {
      id: "hol-2", account_id: "acct-1", user_id: "u-pooja",
      start_date: "2026-12-20", end_date: "2026-12-25", reason: null, cancelled_at: null,
    },
  ];
});

describe("PATCH /api/team-availability/holidays/[id]", () => {
  it("403s for non-owners and 404s for foreign rows", async () => {
    h.role = "agent";
    expect((await PATCH(req({ reason: "x" }), { params: Promise.resolve({ id: "hol-1" }) })).status).toBe(403);
    h.role = "owner";
    h.accountId = "acct-OTHER";
    expect((await PATCH(req({ reason: "x" }), { params: Promise.resolve({ id: "hol-1" }) })).status).toBe(404);
  });

  it("edits dates and reason", async () => {
    const res = await PATCH(req({ end_date: "2026-12-02", reason: "Extended" }), {
      params: Promise.resolve({ id: "hol-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { holiday: Record<string, unknown> };
    expect(body.holiday.end_date).toBe("2026-12-02");
    expect(body.holiday.reason).toBe("Extended");
  });

  it("409s when the edit would overlap another live window", async () => {
    const res = await PATCH(req({ start_date: "2026-12-18", end_date: "2026-12-22" }), {
      params: Promise.resolve({ id: "hol-1" }),
    });
    // hol-2 spans Dec 20–25 for the same user → conflict.
    expect(res.status).toBe(409);
  });

  it("refuses to edit cancelled holidays", async () => {
    h.holidays[0].cancelled_at = "2026-11-24T00:00:00.000Z";
    const res = await PATCH(req({ reason: "x" }), { params: Promise.resolve({ id: "hol-1" }) });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/team-availability/holidays/[id]/cancel", () => {
  it("cancels upcoming and active holidays (idempotent)", async () => {
    const post = (id: string) =>
      cancel(new Request(`http://localhost/x/${id}`, { method: "POST" }), {
        params: Promise.resolve({ id }),
      });
    const res = await post("hol-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { holiday: Record<string, unknown> };
    expect(body.holiday.cancelled_at).toBeTruthy();
    // Second cancel is a no-op success.
    expect((await post("hol-1")).status).toBe(200);
  });

  it("404s for unknown ids", async () => {
    const res = await cancel(new Request("http://localhost/x/nope", { method: "POST" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});
