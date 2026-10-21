// Lead Assignment rule APIs — validation, conflicts, permissions,
// tenant isolation. Shared behavior of other features untouched.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "admin",
  accountId: "acct-1",
  userId: "admin-1",
  rules: [] as Array<Record<string, unknown>>,
  ruleTables: [] as Array<Record<string, unknown>>,
  ruleMembers: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  forms: [
    { id: "form-1", account_id: "acct-1" },
    { id: "form-2", account_id: "acct-1" },
  ] as Array<Record<string, unknown>>,
  profiles: [
    { user_id: "u-mohan", account_id: "acct-1" },
    { user_id: "u-sohan", account_id: "acct-1" },
  ] as Array<Record<string, unknown>>,
  seq: 0,
}));

function uid(prefix: string) {
  h.seq += 1;
  return `${prefix}-${h.seq}`;
}

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
  },
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return {
      supabase: fakeSupabase(),
      accountId: h.accountId,
      userId: h.userId,
      role: h.role,
    };
  },
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

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    orderCol: null as string | null,
    insertRows: null as Array<Record<string, unknown>> | null,
    updateObj: null as Record<string, unknown> | null,
    deleteMode: false,
  };
  function rows(): Array<Record<string, unknown>> {
    switch (state.table) {
      case "lead_assignment_rules": return h.rules;
      case "lead_assignment_rule_tables": return h.ruleTables;
      case "lead_assignment_rule_members": return h.ruleMembers;
      case "lead_assignment_table_state": return h.states;
      case "meta_lead_forms": return h.forms;
      case "profiles": return h.profiles;
      default: return [];
    }
  }
  const matched = () => {
    let list = rows().filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
    if (state.orderCol) {
      const col = state.orderCol;
      list = [...list].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv);
        return Number(av ?? 0) - Number(bv ?? 0);
      });
    }
    return list;
  };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      state.filters.push({ col, op: "in", val: vals });
      return api;
    },
    order: (col: string) => {
      state.orderCol = col;
      return api;
    },
    insert: (input: Record<string, unknown> | Array<Record<string, unknown>>) => {
      state.insertRows = Array.isArray(input) ? input : [input];
      return api;
    },
    update: (obj: Record<string, unknown>) => {
      state.updateObj = obj;
      return api;
    },
    delete: () => {
      state.deleteMode = true;
      return api;
    },
    maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
    single: async () => {
      if (state.insertRows) {
        if (state.table === "lead_assignment_rules") {
          const obj = state.insertRows[0];
          if (obj.scope === "all" && obj.status === "active") {
            const dup = h.rules.find(
              (r) => r.account_id === obj.account_id && r.scope === "all" && r.status === "active",
            );
            if (dup) return { data: null, error: { code: "23505", message: "dup" } };
          }
          const row = { id: uid("rule"), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...obj };
          h.rules.push(row);
          return { data: row, error: null };
        }
        const created = state.insertRows.map((o) => ({ id: uid("row"), ...o }));
        rows().push(...created);
        return { data: created[0] ?? null, error: null };
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      const list = matched();
      return { data: list[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.insertRows) {
        const created = state.insertRows.map((o) => ({ id: uid("row"), ...o }));
        rows().push(...created);
        return resolve({ data: created, error: null });
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return resolve({ data: list, error: null });
      }
      if (state.deleteMode) {
        const list = matched();
        const arr = rows();
        for (const r of list) arr.splice(arr.indexOf(r), 1);
        return resolve({ data: list, error: null });
      }
      return resolve({ data: matched(), error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.orderCol = null;
      state.insertRows = null;
      state.updateObj = null;
      state.deleteMode = false;
      return api;
    },
  };
}

const { GET, POST } = await import("./route");

function req(method: string, body?: unknown) {
  return new Request("https://app.test/api/lead-assignment/rules", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const SWRR = {
  name: "Travel",
  scope: "specific",
  mode: "swrr",
  tables: ["form-1"],
  members: [
    { user_id: "u-mohan", weight: 60 },
    { user_id: "u-sohan", weight: 40 },
  ],
};

beforeEach(() => {
  h.authed = true;
  h.role = "admin";
  h.accountId = "acct-1";
  h.userId = "admin-1";
  h.rules = [];
  h.ruleTables = [];
  h.ruleMembers = [];
  h.states = [];
  h.seq = 0;
});

describe("GET /api/lead-assignment/rules", () => {
  it("lists account rules for members", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rules: unknown[] }).rules).toEqual([]);
  });
});

describe("POST /api/lead-assignment/rules", () => {
  it("creates a rule (201) with members and targets", async () => {
    const res = await POST(req("POST", SWRR));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { rule: Record<string, unknown> };
    expect(json.rule).toMatchObject({ name: "Travel", scope: "specific", mode: "swrr", status: "active" });
    expect(json.rule.tables).toEqual(["form-1"]);
    expect(json.rule.members).toEqual([
      { user_id: "u-mohan", position: 0, weight: 60 },
      { user_id: "u-sohan", position: 1, weight: 40 },
    ]);
  });

  it("rejects totals != 100 and bad member lists", async () => {
    const bad = await POST(
      req("POST", { ...SWRR, members: [{ user_id: "u-mohan", weight: 60 }, { user_id: "u-sohan", weight: 30 }] }),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/exactly 100/);
    expect(h.rules).toHaveLength(0);
  });

  it("409s overlapping specifics and duplicate fallbacks", async () => {
    expect((await POST(req("POST", SWRR))).status).toBe(201);
    const overlap = await POST(req("POST", { ...SWRR, name: "Overlap" }));
    expect(overlap.status).toBe(409);
    const json = (await overlap.json()) as { error: string; conflicts: unknown[] };
    expect(json.error).toMatch(/Conflicting/);
    expect(json.conflicts).toHaveLength(1);
    const fallback = await POST(
      req("POST", { ...SWRR, name: "All", scope: "all", tables: [] }),
    );
    expect(fallback.status).toBe(201);
    const dup = await POST(
      req("POST", { ...SWRR, name: "All2", scope: "all", tables: [] }),
    );
    expect(dup.status).toBe(409);
  });

  it("enforces admin role and tenant tables", async () => {
    h.role = "viewer";
    expect((await POST(req("POST", SWRR))).status).toBe(403);
    h.role = "admin";
    const foreign = await POST(req("POST", { ...SWRR, tables: ["form-x"] }));
    expect(foreign.status).toBe(400);
  });
});
