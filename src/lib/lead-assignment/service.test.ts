// Lead Assignment service — resolution, eligibility, idempotent
// assignment, CAS concurrency, manual assignment, audit.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rules: [] as Array<Record<string, unknown>>,
  ruleTables: [] as Array<Record<string, unknown>>,
  ruleMembers: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  flows: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  seq: 0,
  bumpVersionOnStateRead: false,
}));

function uid(prefix: string) {
  h.seq += 1;
  return `${prefix}-${h.seq}`;
}

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function tableRows(table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "lead_assignment_rules": return h.rules;
    case "lead_assignment_rule_tables": return h.ruleTables;
    case "lead_assignment_rule_members": return h.ruleMembers;
    case "lead_assignment_table_state": return h.states;
    case "workspace_fields": return h.fields;
    case "workspace_values": return h.values;
    case "lead_assignment_events": return h.events;
    case "flows": return h.flows;
    case "flow_runs": return h.runs;
    case "profiles": return h.profiles;
    default: return [];
  }
}

function applyInsert(table: string, obj: Record<string, unknown>) {
  const withId = ("id" in obj && obj.id ? obj : { id: uid("row"), ...obj });
  if (table === "workspace_values") {
    const dup = h.values.find(
      (r) => r.field_id === withId.field_id && r.flow_run_id === withId.flow_run_id,
    );
    if (dup) return { row: null as never, error: { code: "23505", message: "dup" } };
    const row = { ...withId };
    h.values.push(row);
    return { row, error: null };
  }
  if (table === "lead_assignment_table_state") {
    const dup = h.states.find(
      (r) => r.rule_id === withId.rule_id && r.form_id === withId.form_id,
    );
    if (dup) return { row: null as never, error: { code: "23505", message: "dup" } };
    const row = { rr_cursor: 0, current_weights: {}, version: 0, ...withId };
    h.states.push(row);
    return { row, error: null };
  }
  if (table === "lead_assignment_events") {
    const row = { ...withId };
    h.events.push(row);
    return { row, error: null };
  }
  const row = { ...withId };
  tableRows(table).push(row);
  return { row, error: null };
}

function applyUpsert(obj: Record<string, unknown>) {
  const keys = ["field_id", "flow_run_id"];
  const dup = h.values.find((r) => keys.every((k) => r[k] === obj[k]));
  if (dup) {
    Object.assign(dup, obj);
    return dup;
  }
  const row = { id: uid("wv"), ...obj };
  h.values.push(row);
  return row;
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    orderCol: null as string | null,
    insertObj: null as Record<string, unknown> | null,
    updateObj: null as Record<string, unknown> | null,
    deleteMode: false,
    upsertObj: null as Record<string, unknown> | null,
    upsertConflict: "",
  };
  const matched = () => {
    let rows = tableRows(state.table).filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
    if (state.orderCol) {
      rows = [...rows].sort((a, b) =>
        Number(a[state.orderCol as string] ?? 0) - Number(b[state.orderCol as string] ?? 0),
      );
    }
    return rows;
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
    insert: (obj: Record<string, unknown>) => {
      state.insertObj = obj;
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
    upsert: (obj: Record<string, unknown>, opts?: { onConflict?: string }) => {
      state.upsertObj = obj;
      state.upsertConflict = opts?.onConflict ?? "";
      return api;
    },
    maybeSingle: async () => {
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      const list = matched();
      if (state.table === "lead_assignment_table_state" && h.bumpVersionOnStateRead && list[0]) {
        h.bumpVersionOnStateRead = false;
        list[0].version = Number(list[0].version) + 1;
      }
      return { data: list[0] ?? null, error: null };
    },
    single: async () => {
      if (state.insertObj) {
        const applied = applyInsert(state.table, state.insertObj);
        if (applied.error) return { data: null, error: applied.error };
        return { data: applied.row, error: null };
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      if (state.upsertObj) {
        return { data: applyUpsert(state.upsertObj), error: null };
      }
      const list = matched();
      return { data: list[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.insertObj) {
        const applied = applyInsert(state.table, state.insertObj);
        if (applied.error) return resolve({ data: null, error: applied.error });
        return resolve({ data: [applied.row], error: null });
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return resolve({ data: list, error: null });
      }
      if (state.upsertObj) {
        return resolve({ data: [applyUpsert(state.upsertObj)], error: null });
      }
      if (state.deleteMode) {
        const list = matched();
        for (const r of list) {
          const arr = tableRows(state.table);
          arr.splice(arr.indexOf(r), 1);
        }
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
      state.insertObj = null;
      state.updateObj = null;
      state.deleteMode = false;
      state.upsertObj = null;
      state.upsertConflict = "";
      return api;
    },
  };
}

const service = await import("./service");

function seedBase() {
  h.rules = [];
  h.ruleTables = [];
  h.ruleMembers = [];
  h.states = [];
  h.fields = [
    { id: "f-assign", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To" },
  ];
  h.values = [];
  h.events = [];
  h.flows = [{ id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads" }];
  h.runs = [{ id: "run-1", account_id: "acct-1", flow_id: "flow-1" }];
  h.profiles = [
    { user_id: "u-mohan", account_id: "acct-1", account_role: "agent" },
    { user_id: "u-sohan", account_id: "acct-1", account_role: "admin" },
    { user_id: "u-viewer", account_id: "acct-1", account_role: "viewer" },
  ];
  h.seq = 0;
  h.bumpVersionOnStateRead = false;
}

function seedRule(opts?: {
  scope?: string;
  mode?: string;
  status?: string;
  tables?: string[];
  members?: Array<{ user_id: string; position: number; weight: number }>;
}) {
  const rule = {
    id: uid("rule"),
    account_id: "acct-1",
    name: "R",
    scope: opts?.scope ?? "specific",
    mode: opts?.mode ?? "round_robin",
    status: opts?.status ?? "active",
    created_at: `2026-01-0${h.seq}T00:00:00Z`,
  };
  h.rules.push(rule);
  for (const formId of opts?.tables ?? ["form-1"]) {
    h.ruleTables.push({ rule_id: rule.id, form_id: formId });
  }
  for (const m of opts?.members ?? [
    { user_id: "u-mohan", position: 0, weight: 0 },
    { user_id: "u-sohan", position: 1, weight: 0 },
  ]) {
    h.ruleMembers.push({ rule_id: rule.id, ...m });
  }
  return rule;
}

beforeEach(seedBase);

describe("resolveAssignmentRule", () => {
  it("prefers a specific-table rule over the All Tables fallback", async () => {
    seedRule({ scope: "all", tables: [] });
    const specific = seedRule({ scope: "specific", tables: ["form-1"] });
    const db = fakeSupabase();
    const resolved = await service.resolveAssignmentRule(db as never, "acct-1", "form-1");
    expect(resolved?.rule.id).toBe(specific.id);
  });

  it("uses the fallback when no specific rule covers the table", async () => {
    const fallback = seedRule({ scope: "all", tables: [] });
    seedRule({ scope: "specific", tables: ["form-9"] });
    const db = fakeSupabase();
    const resolved = await service.resolveAssignmentRule(db as never, "acct-1", "form-1");
    expect(resolved?.rule.id).toBe(fallback.id);
  });

  it("returns null when nothing applies (paused rules ignored)", async () => {
    seedRule({ scope: "specific", tables: ["form-1"], status: "paused" });
    seedRule({ scope: "all", tables: [], status: "paused" });
    const db = fakeSupabase();
    expect(await service.resolveAssignmentRule(db as never, "acct-1", "form-1")).toBeNull();
  });

  it("breaks overlapping specifics deterministically (earliest wins)", async () => {
    const first = seedRule({ scope: "specific", tables: ["form-1"] });
    seedRule({ scope: "specific", tables: ["form-1"] });
    const db = fakeSupabase();
    const resolved = await service.resolveAssignmentRule(db as never, "acct-1", "form-1");
    expect(resolved?.rule.id).toBe(first.id);
  });
});

describe("listEligibleUserIds", () => {
  it("intersects roster roles, preserving configured order", async () => {
    const db = fakeSupabase();
    const out = await service.listEligibleUserIds(db as never, "acct-1", [
      { user_id: "u-viewer", position: 0, weight: 0 },
      { user_id: "u-sohan", position: 1, weight: 0 },
      { user_id: "u-gone", position: 2, weight: 0 },
      { user_id: "u-mohan", position: 3, weight: 0 },
    ]);
    expect(out).toEqual(["u-sohan", "u-mohan"]);
  });
});

describe("assignLead (Round Robin)", () => {
  it("assigns sequentially per table with independent cursors", async () => {
    seedRule({ tables: ["form-1", "form-2"] });
    h.runs.push({ id: "run-2", account_id: "acct-1", flow_id: "flow-1" });
    const db = fakeSupabase();
    const a = await service.assignLead(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-1", formId: "form-1",
    });
    const b = await service.assignLead(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-2", formId: "form-1",
    });
    expect(a).toMatchObject({ outcome: "assigned", userId: "u-mohan" });
    expect(b).toMatchObject({ outcome: "assigned", userId: "u-sohan" });
    // form-2 has its own cursor: starts at Mohan again.
    h.runs.push({ id: "run-3", account_id: "acct-1", flow_id: "flow-1" });
    const c = await service.assignLead(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-3", formId: "form-2",
    });
    expect(c.userId).toBe("u-mohan");
    expect(h.states).toHaveLength(2);
  });

  it("skips owned rows without advancing the cursor", async () => {
    seedRule({ tables: ["form-1"] });
    h.values.push({
      id: "wv-0", account_id: "acct-1", field_id: "f-assign",
      flow_run_id: "run-1", value_text: "u-sohan",
    });
    const db = fakeSupabase();
    const res = await service.assignLead(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-1", formId: "form-1",
    });
    expect(res.outcome).toBe("already-owned");
    expect(h.states).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("leaves unassigned + event when nobody is eligible", async () => {
    seedRule({
      tables: ["form-1"],
      members: [{ user_id: "u-gone", position: 0, weight: 0 }],
    });
    const db = fakeSupabase();
    const res = await service.assignLead(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-1", formId: "form-1",
    });
    expect(res.outcome).toBe("no-eligible");
    expect(h.values).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ kind: "unassigned", assigned_user_id: null });
  });

  it("retries CAS conflicts and still advances exactly once per lead", async () => {
    seedRule({ tables: ["form-1"] });
    h.runs.push({ id: "run-2", account_id: "acct-1", flow_id: "flow-1" });
    const db = fakeSupabase();
    h.bumpVersionOnStateRead = true;
    const a = await service.assignLead(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-1", formId: "form-1",
    });
    h.bumpVersionOnStateRead = false;
    const b = await service.assignLead(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-2", formId: "form-1",
    });
    expect(a.userId).not.toBe(b.userId);
    expect(h.values).toHaveLength(2);
  });
});

describe("assignLead (SWRR)", () => {
  it("distributes 60/40 over 100 leads on one table", async () => {
    seedRule({
      tables: ["form-1"],
      mode: "swrr",
      members: [
        { user_id: "u-mohan", position: 0, weight: 60 },
        { user_id: "u-sohan", position: 1, weight: 40 },
      ],
    });
    const db = fakeSupabase();
    const counts: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      const runId = `run-${i}`;
      h.runs.push({ id: runId, account_id: "acct-1", flow_id: "flow-1" });
      const res = await service.assignLead(db as never, {
        accountId: "acct-1", flowId: "flow-1", runId, formId: "form-1",
      });
      expect(res.outcome).toBe("assigned");
      counts[res.userId as string] = (counts[res.userId as string] ?? 0) + 1;
    }
    expect(counts).toEqual({ "u-mohan": 60, "u-sohan": 40 });
  });
});

describe("manualAssign", () => {
  it("writes the owner and audits actor/previous/new", async () => {
    seedBase();
    const db = fakeSupabase();
    const res = await service.manualAssign(db as never, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      formId: "form-1",
      newUserId: "u-mohan",
      actorUserId: "actor-1",
    });
    expect(res).toEqual({ previous: null, current: "u-mohan" });
    expect(h.values[0]).toMatchObject({ value_text: "u-mohan" });
    expect(h.events[0]).toMatchObject({
      kind: "manual",
      assigned_user_id: "u-mohan",
      previous_user_id: null,
      created_by: "actor-1",
    });
  });

  it("rejects Flow Tables and unknown members, clears on null", async () => {
    seedBase();
    h.flows = [{ id: "flow-1", account_id: "acct-1", kind: "whatsapp_flow" }];
    const db = fakeSupabase();
    await expect(
      service.manualAssign(db as never, {
        accountId: "acct-1", flowId: "flow-1", runId: "run-1",
        formId: null, newUserId: "u-mohan", actorUserId: "actor-1",
      }),
    ).rejects.toMatchObject({ status: 404 });
    h.flows = [{ id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads" }];
    await expect(
      service.manualAssign(db as never, {
        accountId: "acct-1", flowId: "flow-1", runId: "run-1",
        formId: null, newUserId: "u-stranger", actorUserId: "actor-1",
      }),
    ).rejects.toThrow(/team member/);
    h.values.push({
      id: "wv-0", account_id: "acct-1", field_id: "f-assign",
      flow_run_id: "run-1", value_text: "u-mohan",
    });
    const cleared = await service.manualAssign(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-1",
      formId: null, newUserId: null, actorUserId: "actor-1",
    });
    expect(cleared).toEqual({ previous: "u-mohan", current: null });
    expect(h.values).toHaveLength(0);
  });
});
