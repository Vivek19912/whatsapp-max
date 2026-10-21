// Lead Assignment rule persistence — conflicts, state pruning,
// coverage, isolation between rules.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rules: [] as Array<Record<string, unknown>>,
  ruleTables: [] as Array<Record<string, unknown>>,
  ruleMembers: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  forms: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  seq: 0,
}));

function uid(prefix: string) {
  h.seq += 1;
  return `${prefix}-${h.seq}`;
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Array<{ col: string; op: string; val: unknown }>,
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
        if (state.table === "lead_assignment_rules") {
          const list = matched();
          const obj = state.updateObj;
          if (obj.scope === "all" && obj.status === "active") {
            const dup = h.rules.find(
              (r) =>
                r.account_id === (list[0]?.account_id ?? obj.account_id) &&
                r.scope === "all" && r.status === "active" &&
                r.id !== list[0]?.id,
            );
            if (dup) return { data: null, error: { code: "23505", message: "dup" } };
          }
          for (const r of list) Object.assign(r, obj);
          return { data: list[0] ?? null, error: null };
        }
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

const rules = await import("./rules");

function seedBase() {
  h.rules = [];
  h.ruleTables = [];
  h.ruleMembers = [];
  h.states = [];
  h.forms = [
    { id: "form-1", account_id: "acct-1" },
    { id: "form-2", account_id: "acct-1" },
    { id: "form-3", account_id: "acct-1" },
  ];
  h.profiles = [
    { user_id: "u-mohan", account_id: "acct-1" },
    { user_id: "u-sohan", account_id: "acct-1" },
    { user_id: "u-rahul", account_id: "acct-1" },
  ];
  h.seq = 0;
}

const VALID = {
  name: "Video Leads",
  scope: "specific" as const,
  mode: "round_robin" as const,
  status: "active" as const,
  tables: ["form-1"],
  members: [
    { user_id: "u-mohan", weight: 0 },
    { user_id: "u-sohan", weight: 0 },
  ],
};

beforeEach(seedBase);

describe("createRule", () => {
  it("persists rule, targets, and renumbered members", async () => {
    const db = fakeSupabase();
    const out = await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "admin-1",
      input: VALID,
    });
    expect(out.name).toBe("Video Leads");
    expect(out.tables).toEqual(["form-1"]);
    expect(out.members).toEqual([
      { user_id: "u-mohan", position: 0, weight: 0 },
      { user_id: "u-sohan", position: 1, weight: 0 },
    ]);
    expect(h.rules).toHaveLength(1);
  });

  it("rejects unknown tables and members", async () => {
    const db = fakeSupabase();
    await expect(
      rules.createRule(db as never, {
        accountId: "acct-1",
        createdBy: "a",
        input: { ...VALID, tables: ["form-x"] },
      }),
    ).rejects.toThrow(/no longer exist/);
    await expect(
      rules.createRule(db as never, {
        accountId: "acct-1",
        createdBy: "a",
        input: { ...VALID, members: [{ user_id: "u-stranger", weight: 0 }] },
      }),
    ).rejects.toThrow(/not in this company/);
  });

  it("409s overlapping active specifics with details", async () => {
    const db = fakeSupabase();
    await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "a",
      input: VALID,
    });
    const err = await rules
      .createRule(db as never, {
        accountId: "acct-1",
        createdBy: "a",
        input: { ...VALID, name: "Overlap", tables: ["form-1", "form-2"] },
      })
      .catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.conflicts[0]).toMatchObject({ rule_name: "Video Leads" });
    expect(h.rules).toHaveLength(1);
  });

  it("409s a second active All Tables fallback", async () => {
    const db = fakeSupabase();
    await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "a",
      input: { ...VALID, scope: "all", tables: [] },
    });
    const err = await rules
      .createRule(db as never, {
        accountId: "acct-1",
        createdBy: "a",
        input: { ...VALID, name: "Other", scope: "all", tables: [] },
      })
      .catch((e) => e);
    expect(err.status).toBe(409);
  });
});

describe("updateRule", () => {
  it("keeps the cursor but prunes removed members' weights", async () => {
    const db = fakeSupabase();
    const created = await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "a",
      input: { ...VALID, mode: "swrr", members: [
        { user_id: "u-mohan", weight: 60 },
        { user_id: "u-sohan", weight: 40 },
      ] },
    });
    h.states.push({
      id: "st-1", rule_id: created.id, form_id: "form-1",
      rr_cursor: 7, current_weights: { "u-mohan": 5, "u-sohan": -5 },
      version: 3,
    });
    const out = await rules.updateRule(db as never, {
      accountId: "acct-1",
      ruleId: created.id,
      input: { ...VALID, mode: "swrr", members: [
        { user_id: "u-mohan", weight: 100 },
        { user_id: "u-rahul", weight: 0 },
      ] },
    });
    expect(out.members.map((m) => m.user_id)).toEqual(["u-mohan", "u-rahul"]);
    const state = h.states.find((s) => s.id === "st-1")!;
    expect(state.rr_cursor).toBe(7);
    expect(state.current_weights).toEqual({ "u-mohan": 5 });
  });

  it("drops state for removed tables and rechecks on activate", async () => {
    const db = fakeSupabase();
    const created = await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "a",
      input: { ...VALID, tables: ["form-1", "form-2"] },
    });
    h.states.push({ id: "st-1", rule_id: created.id, form_id: "form-1", rr_cursor: 1, current_weights: {}, version: 0 });
    h.states.push({ id: "st-2", rule_id: created.id, form_id: "form-2", rr_cursor: 2, current_weights: {}, version: 0 });
    await rules.updateRule(db as never, {
      accountId: "acct-1",
      ruleId: created.id,
      input: { ...VALID, tables: ["form-1"] },
    });
    expect(h.states.map((s) => s.form_id)).toEqual(["form-1"]);
    // Pausing skips conflict checks; activating re-checks.
    await rules.updateRule(db as never, {
      accountId: "acct-1",
      ruleId: created.id,
      input: { ...VALID, tables: ["form-1"], status: "paused" },
    });
    const other = await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "a",
      input: { ...VALID, name: "Other", tables: ["form-1"] },
    });
    expect(other.status).toBe("active");
    const err = await rules
      .updateRule(db as never, {
        accountId: "acct-1",
        ruleId: created.id,
        input: { ...VALID, tables: ["form-1"], status: "active" },
      })
      .catch((e) => e);
    expect(err.status).toBe(409);
  });

  it("editing one rule never touches another rule", async () => {
    const db = fakeSupabase();
    const a = await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "x",
      input: VALID,
    });
    const b = await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "x",
      input: { ...VALID, name: "B", tables: ["form-2"] },
    });
    h.states.push({ id: "st-b", rule_id: b.id, form_id: "form-2", rr_cursor: 9, current_weights: {}, version: 1 });
    const before = JSON.stringify(h.rules.find((r) => r.id === b.id));
    await rules.updateRule(db as never, {
      accountId: "acct-1",
      ruleId: a.id,
      input: { ...VALID, name: "A2", members: [{ user_id: "u-rahul", weight: 0 }] },
    });
    expect(JSON.stringify(h.rules.find((r) => r.id === b.id))).toBe(before);
    expect(h.states.find((s) => s.id === "st-b")?.rr_cursor).toBe(9);
  });
});

describe("deleteRule + getCoverage", () => {
  it("deletes the rule and maps coverage per table", async () => {
    const db = fakeSupabase();
    const specific = await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "a",
      input: VALID,
    });
    const fallback = await rules.createRule(db as never, {
      accountId: "acct-1",
      createdBy: "a",
      input: { ...VALID, name: "Fallback", scope: "all", tables: [] },
    });
    const coverage = await rules.getCoverage(db as never, "acct-1");
    expect(coverage).toEqual([
      { form_id: "form-1", rule_id: specific.id },
      { form_id: "form-2", rule_id: fallback.id },
      { form_id: "form-3", rule_id: fallback.id },
    ]);
    expect(await rules.deleteRule(db as never, "acct-1", specific.id)).toBe(true);
    expect(h.rules.map((r) => r.id)).toEqual([fallback.id]);
    expect(await rules.deleteRule(db as never, "acct-1", "missing")).toBe(false);
  });
});
