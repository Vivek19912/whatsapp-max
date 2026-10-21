// Lead Assignment rule detail APIs — read/update/delete,
// conflict re-checks, permissions.

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
    { user_id: "u-rahul", account_id: "acct-1" },
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

const { GET, PATCH, DELETE } = await import("./route");

function seedRule() {
  const rule = {
    id: "rule-1",
    account_id: "acct-1",
    name: "Video",
    scope: "specific",
    mode: "round_robin",
    status: "active",
    created_by: "admin-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  h.rules = [rule];
  h.ruleTables = [{ rule_id: "rule-1", form_id: "form-1" }];
  h.ruleMembers = [
    { rule_id: "rule-1", user_id: "u-mohan", position: 0, weight: 0 },
    { rule_id: "rule-1", user_id: "u-sohan", position: 1, weight: 0 },
  ];
  return rule;
}

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
  seedRule();
});

const PARAMS = { params: Promise.resolve({ id: "rule-1" }) };

describe("rule detail APIs", () => {
  it("GET reads one rule with targets and members", async () => {
    const res = await GET(new Request("https://app.test/x"), PARAMS);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rule: Record<string, unknown> };
    expect(json.rule).toMatchObject({ id: "rule-1", name: "Video" });
    expect(json.rule.tables).toEqual(["form-1"]);
    expect((json.rule.members as unknown[])).toHaveLength(2);
  });

  it("GET 404s foreign rules", async () => {
    h.rules = [];
    const res = await GET(new Request("https://app.test/x"), PARAMS);
    expect(res.status).toBe(404);
  });

  it("PATCH renames and re-targets, pruning leftovers", async () => {
    const res = await PATCH(
      new Request("https://app.test/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Video 2",
          scope: "specific",
          mode: "round_robin",
          status: "active",
          tables: ["form-2"],
          members: [{ user_id: "u-rahul" }],
        }),
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rule: Record<string, unknown> };
    expect(json.rule).toMatchObject({ name: "Video 2", tables: ["form-2"] });
    expect(h.ruleTables).toMatchObject([{ rule_id: "rule-1", form_id: "form-2" }]);
  });

  it("PATCH 409s new overlaps and 400s bad percentages", async () => {
    h.rules.push({
      id: "rule-2", account_id: "acct-1", name: "Other", scope: "specific",
      mode: "round_robin", status: "active", created_by: "a",
      created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
    });
    h.ruleTables.push({ rule_id: "rule-2", form_id: "form-2" });
    const overlap = await PATCH(
      new Request("https://app.test/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Video", scope: "specific", mode: "round_robin",
          tables: ["form-2"], members: [{ user_id: "u-mohan" }],
        }),
      }),
      PARAMS,
    );
    expect(overlap.status).toBe(409);
    const badPct = await PATCH(
      new Request("https://app.test/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Video", scope: "specific", mode: "swrr",
          tables: ["form-1"],
          members: [{ user_id: "u-mohan", weight: 30 }],
        }),
      }),
      PARAMS,
    );
    expect(badPct.status).toBe(400);
  });

  it("DELETE removes the rule; viewers are blocked everywhere", async () => {
    const res = await DELETE(new Request("https://app.test/x", { method: "DELETE" }), PARAMS);
    expect(res.status).toBe(200);
    expect(h.rules).toHaveLength(0);
    seedRule();
    h.role = "viewer";
    expect((await GET(new Request("https://app.test/x"), PARAMS)).status).toBe(200);
    expect(
      (await PATCH(new Request("https://app.test/x", { method: "PATCH", body: "{}" }), PARAMS)).status,
    ).toBe(403);
    expect(
      (await DELETE(new Request("https://app.test/x", { method: "DELETE" }), PARAMS)).status,
    ).toBe(403);
  });
});
