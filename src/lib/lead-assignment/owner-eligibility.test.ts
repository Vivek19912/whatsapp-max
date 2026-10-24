// Owner eligibility regression — the account owner must appear in
// Step 3 and receive leads even without an Admin/Agent role.
//
// Covers: pure eligibility (role `owner` + owner flag), service
// eligibility (role union + accounts.owner_user_id backstop),
// percentage validation with the owner, auto-assignment to the
// owner, manual assignment to the owner, and tenant isolation
// (another account's owner never leaks in).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { eligibleMemberIds, isAssignableRole } from "./members";
import { validateMembersStep, validateRuleInput } from "./validation";

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
  accounts: [] as Array<Record<string, unknown>>,
  seq: 0,
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
    case "accounts": return h.accounts;
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
  };
  const matched = () => {
    let rows = tableRows(state.table).filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
    if (state.orderCol) {
      rows = [...rows].sort(
        (a, b) => Number(a[state.orderCol as string] ?? 0) - Number(b[state.orderCol as string] ?? 0),
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
    upsert: (obj: Record<string, unknown>) => {
      state.upsertObj = obj;
      return api;
    },
    maybeSingle: async () => {
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
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
      return { data: matched()[0] ?? null, error: null };
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
      return api;
    },
  };
}

const service = await import("./service");

function seedSoloOwner() {
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
  h.accounts = [{ id: "acct-1", owner_user_id: "u-owner" }];
  h.profiles = [
    { user_id: "u-owner", account_id: "acct-1", account_role: "owner" },
  ];
  h.seq = 0;
}

beforeEach(seedSoloOwner);

describe("owner pure eligibility", () => {
  it("owner role is assignable; viewer still is not", () => {
    expect(isAssignableRole("owner")).toBe(true);
    expect(isAssignableRole("admin")).toBe(true);
    expect(isAssignableRole("agent")).toBe(true);
    expect(isAssignableRole("viewer")).toBe(false);
  });

  it("solo owner (no Admin/Agent) yields an eligible member, not 'No eligible members'", () => {
    expect(
      eligibleMemberIds([{ user_id: "u-owner", role: "owner" }]),
    ).toEqual(["u-owner"]);
  });

  it("admin/agent eligibility is unchanged", () => {
    expect(
      eligibleMemberIds([
        { user_id: "u-a", role: "admin" },
        { user_id: "u-b", role: "agent" },
        { user_id: "u-v", role: "viewer" },
      ]),
    ).toEqual(["u-a", "u-b"]);
  });
});

describe("owner service eligibility", () => {
  it("listEligibleUserIds keeps the owner by role", async () => {
    const db = fakeSupabase();
    const out = await service.listEligibleUserIds(db as never, "acct-1", [
      { user_id: "u-owner", position: 0, weight: 0 },
    ]);
    expect(out).toEqual(["u-owner"]);
  });

  it("listEligibleUserIds keeps the owner via accounts.owner_user_id even with a non-assignable profile role", async () => {
    h.profiles = [
      { user_id: "u-owner", account_id: "acct-1", account_role: "viewer" },
      { user_id: "u-agent", account_id: "acct-1", account_role: "agent" },
    ];
    const db = fakeSupabase();
    const out = await service.listEligibleUserIds(db as never, "acct-1", [
      { user_id: "u-owner", position: 0, weight: 0 },
      { user_id: "u-agent", position: 1, weight: 0 },
    ]);
    expect(out).toEqual(["u-owner", "u-agent"]);
  });

  it("never leaks another account's owner (tenant isolation)", async () => {
    h.accounts = [
      { id: "acct-1", owner_user_id: "u-owner-1" },
      { id: "acct-2", owner_user_id: "u-owner-2" },
    ];
    h.profiles = [
      { user_id: "u-owner-1", account_id: "acct-1", account_role: "owner" },
      { user_id: "u-owner-2", account_id: "acct-2", account_role: "owner" },
    ];
    const db = fakeSupabase();
    const out = await service.listEligibleUserIds(db as never, "acct-1", [
      { user_id: "u-owner-1", position: 0, weight: 0 },
      { user_id: "u-owner-2", position: 1, weight: 0 },
    ]);
    expect(out).toEqual(["u-owner-1"]);
  });
});

describe("owner percentages + assignment", () => {
  it("SWRR percentages validate for the owner and must total exactly 100", () => {
    expect(
      validateMembersStep({
        mode: "swrr",
        members: [
          { user_id: "u-owner", weight: 60 },
          { user_id: "u-agent", weight: 40 },
        ],
      }),
    ).toBeNull();
    expect(
      validateMembersStep({
        mode: "swrr",
        members: [
          { user_id: "u-owner", weight: 60 },
          { user_id: "u-agent", weight: 30 },
        ],
      }),
    ).toMatch(/exactly 100/);
    const input = validateRuleInput({
      name: "Owner split",
      scope: "specific",
      mode: "swrr",
      status: "active",
      tables: ["form-1"],
      members: [
        { user_id: "u-owner", weight: 50 },
        { user_id: "u-agent", weight: 50 },
      ],
    });
    expect(input.members.map((m) => m.user_id)).toEqual(["u-owner", "u-agent"]);
  });

  it("auto-assigns to the solo owner through the rule", async () => {
    h.rules = [
      {
        id: "rule-1", account_id: "acct-1", name: "R",
        scope: "specific", mode: "round_robin", status: "active",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    h.ruleTables = [{ rule_id: "rule-1", form_id: "form-1" }];
    h.ruleMembers = [{ rule_id: "rule-1", user_id: "u-owner", position: 0, weight: 0 }];
    const db = fakeSupabase();
    const res = await service.assignLead(db as never, {
      accountId: "acct-1", flowId: "flow-1", runId: "run-1", formId: "form-1",
    });
    expect(res).toMatchObject({ outcome: "assigned", userId: "u-owner" });
  });

  it("manual assignment to the owner succeeds and audits", async () => {
    const db = fakeSupabase();
    const res = await service.manualAssign(db as never, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      formId: "form-1",
      newUserId: "u-owner",
      actorUserId: "actor-1",
    });
    expect(res).toEqual({ previous: null, current: "u-owner" });
    expect(h.events[0]).toMatchObject({
      kind: "manual",
      assigned_user_id: "u-owner",
    });
  });
});
