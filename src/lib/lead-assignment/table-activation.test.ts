// Activation behavior: auto-activate new valid configs, preserve
// existing state, pause/resume through the persisted flag, owners
// never rewritten, table-scoped, both distribution modes.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveEnabledOnSave } from "@/components/workspace/table-assignment-dialog";
import * as configLib from "./table-config";
import * as engine from "./table-assignment";

const h = vi.hoisted(() => ({
  flows: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  seq: 0,
}));

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function tableRows(table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "flows": return h.flows;
    case "lead_assignment_table_configs": return h.configs;
    case "lead_assignment_table_assignees": return h.assignees;
    case "lead_assignment_table_config_state": return h.states;
    case "workspace_fields": return h.fields;
    case "workspace_values": return h.values;
    case "lead_assignment_events": return h.events;
    case "profiles": return h.profiles;
    default: return [];
  }
}

function applyInsert(table: string, obj: Record<string, unknown>) {
  if (table === "workspace_values") {
    const dup = h.values.find(
      (r) => r.field_id === obj.field_id && r.flow_run_id === obj.flow_run_id,
    );
    if (dup) return { row: null as never, error: { code: "23505", message: "dup" } };
  }
  if (table === "lead_assignment_table_config_state") {
    const dup = h.states.find((r) => r.config_id === obj.config_id);
    if (dup) return { row: null as never, error: { code: "23505", message: "dup" } };
    const row = { rr_cursor: 0, current_weights: {}, version: 0, id: `row-${++h.seq}`, ...obj };
    tableRows(table).push(row);
    return { row, error: null };
  }
  const row = { id: `row-${++h.seq}`, ...obj };
  tableRows(table).push(row);
  return { row, error: null };
}

function applyUpsert(table: string, obj: Record<string, unknown>, onConflict: string) {
  const keys = onConflict.split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length > 0) {
    const existing = tableRows(table).find((r) => keys.every((k) => r[k] === obj[k]));
    if (existing) {
      Object.assign(existing, obj);
      return existing;
    }
  }
  const defaults: Record<string, unknown> =
    table === "lead_assignment_table_config_state"
      ? { rr_cursor: 0, current_weights: {}, version: 0 }
      : {};
  const row = { id: `row-${++h.seq}`, ...defaults, ...obj };
  tableRows(table).push(row);
  return row;
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    orderCol: null as string | null,
    insertRows: null as Array<Record<string, unknown>> | null,
    updateObj: null as Record<string, unknown> | null,
    deleteMode: false,
    upsertObj: null as Record<string, unknown> | null,
    upsertConflict: "",
  };
  const applyPendingInsert = () => {
    const inserted: Array<Record<string, unknown>> = [];
    for (const row of state.insertRows ?? []) {
      const applied = applyInsert(state.table, row);
      if (applied.error) return { rows: [] as Array<Record<string, unknown>>, error: applied.error };
      inserted.push(applied.row);
    }
    return { rows: inserted, error: null };
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
    eq: (c: string, v: unknown) => { state.filters.push({ col: c, op: "eq", val: v }); return api; },
    in: (c: string, v: unknown[]) => { state.filters.push({ col: c, op: "in", val: v }); return api; },
    order: (c: string) => { state.orderCol = c; return api; },
    limit: () => api,
    lte: () => api,
    insert: (o: Record<string, unknown> | Array<Record<string, unknown>>) => { state.insertRows = (Array.isArray(o) ? o : [o]) as Array<Record<string, unknown>>; return api; },
    update: (o: Record<string, unknown>) => { state.updateObj = o; return api; },
    delete: () => { state.deleteMode = true; return api; },
    upsert: (o: Record<string, unknown>, opts?: { onConflict?: string }) => { state.upsertObj = o; state.upsertConflict = opts?.onConflict ?? ""; return api; },
    maybeSingle: async () => {
      if (state.insertRows) {
        const { rows, error } = applyPendingInsert();
        if (error) return { data: null, error };
        return { data: rows[0] ?? null, error: null };
      }
      if (state.updateObj) { const l = matched(); for (const r of l) Object.assign(r, state.updateObj); return { data: l[0] ?? null, error: null }; }
      if (state.deleteMode) { const l = matched(); for (const r of l) { const a = tableRows(state.table); a.splice(a.indexOf(r), 1); } return { data: l[0] ?? null, error: null }; }
      return { data: matched()[0] ?? null, error: null };
    },
    single: async () => {
      if (state.upsertObj) return { data: applyUpsert(state.table, state.upsertObj, state.upsertConflict), error: null };
      if (state.insertRows) {
        const { rows, error } = applyPendingInsert();
        if (error) return { data: null, error };
        return { data: rows[0] ?? null, error: null };
      }
      if (state.updateObj) { const l = matched(); for (const r of l) Object.assign(r, state.updateObj); return { data: l[0] ?? null, error: null }; }
      return { data: matched()[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.upsertObj) return resolve({ data: [applyUpsert(state.table, state.upsertObj, state.upsertConflict)], error: null });
      if (state.insertRows) {
        const { rows, error } = applyPendingInsert();
        if (error) return resolve({ data: null, error });
        return resolve({ data: rows, error: null });
      }
      if (state.updateObj) { const l = matched(); for (const r of l) Object.assign(r, state.updateObj); return resolve({ data: l, error: null }); }
      if (state.deleteMode) { const l = matched(); for (const r of l) { const a = tableRows(state.table); a.splice(a.indexOf(r), 1); } return resolve({ data: l, error: null }); }
      return resolve({ data: matched(), error: null });
    },
  };
  return { from: (t: string) => { state.table = t; state.filters = []; state.orderCol = null; state.insertRows = null; state.updateObj = null; state.deleteMode = false; state.upsertObj = null; state.upsertConflict = ""; return api; } };
}

const db = () => fakeSupabase() as never;
const assignee = (userId: string | null, extra: Record<string, unknown> = {}) => ({
  user_id: userId,
  display_name: userId ?? "Ext",
  email: userId ? null : "ext@example.com",
  ...extra,
});

function seed() {
  h.flows = [
    { id: "flow-a", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "form-1" },
    { id: "flow-b", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "form-2" },
  ];
  h.configs = [];
  h.assignees = [];
  h.states = [];
  h.fields = [{ id: "f-owner", account_id: "acct-1", flow_id: "flow-a", name: "Assigned To" }, { id: "f-owner-b", account_id: "acct-1", flow_id: "flow-b", name: "Assigned To" }];
  h.values = [];
  h.events = [];
  h.profiles = [
    { user_id: "u-1", account_id: "acct-1", account_role: "agent" },
    { user_id: "u-2", account_id: "acct-1", account_role: "agent" },
  ];
  h.seq = 0;
}

beforeEach(seed);

describe("activation UX — save-time enabled resolution", () => {
  it("1. new valid configs automatically activate on save", () => {
    expect(resolveEnabledOnSave({ isNew: true, persistedEnabled: false, hasActiveAssignee: true, weightInvalid: false })).toBe(true);
  });

  it("2. invalid configurations cannot activate", () => {
    // No active assignee, or bad percentage total.
    expect(resolveEnabledOnSave({ isNew: true, persistedEnabled: false, hasActiveAssignee: false, weightInvalid: false })).toBe(false);
    expect(resolveEnabledOnSave({ isNew: true, persistedEnabled: false, hasActiveAssignee: true, weightInvalid: true })).toBe(false);
  });

  it("3. existing paused configs remain paused on ordinary saves", async () => {
    await configLib.saveTableConfig(db(), { accountId: "acct-1", flowId: "flow-a", input: { enabled: false, mode: "round_robin", assignees: [assignee("u-1")] } });
    // Ordinary settings change resubmits persisted enabled=false.
    const detail = await configLib.saveTableConfig(db(), { accountId: "acct-1", flowId: "flow-a", input: { enabled: false, mode: "round_robin", assignees: [assignee("u-1"), assignee("u-2")] } });
    expect(detail.enabled).toBe(false);
    expect(detail.assignees).toHaveLength(2);
  });

  it("4. existing active configs remain active on ordinary saves", async () => {
    await configLib.saveTableConfig(db(), { accountId: "acct-1", flowId: "flow-a", input: { enabled: true, mode: "round_robin", assignees: [assignee("u-1")] } });
    const detail = await configLib.saveTableConfig(db(), { accountId: "acct-1", flowId: "flow-a", input: { enabled: true, mode: "round_robin", assignees: [assignee("u-1"), assignee("u-2")] } });
    expect(detail.enabled).toBe(true);
  });
});

describe("activation UX — pause/resume engine behavior", () => {
  async function save(flowId: string, enabled: boolean, mode: "round_robin" | "percentage" = "round_robin", rows: Array<Record<string, unknown>> = [assignee("u-1"), assignee("u-2")]) {
    return configLib.saveTableConfig(db(), { accountId: "acct-1", flowId, input: { enabled, mode, assignees: rows } });
  }

  it("5. pause actually stops new automatic assignments", async () => {
    await save("flow-a", true);
    await configLib.setTableConfigEnabled(db(), { accountId: "acct-1", flowId: "flow-a", enabled: false });
    const r = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-a", runId: "run-1", formId: "form-1" });
    expect(r.outcome).toBe("no-config");
    expect(r.notifyHandled).toBe(false);
    expect(h.values).toHaveLength(0);
  });

  it("6. resume restores automatic assignment", async () => {
    await save("flow-a", false);
    await configLib.setTableConfigEnabled(db(), { accountId: "acct-1", flowId: "flow-a", enabled: true });
    const r = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-a", runId: "run-1", formId: "form-1" });
    expect(["assigned", "assigned-external"]).toContain(r.outcome);
  });

  it("7. pause/resume never overwrite distribution settings", async () => {
    const before = await save("flow-a", true, "round_robin", [assignee("u-1"), assignee("u-2")]);
    await configLib.setTableConfigEnabled(db(), { accountId: "acct-1", flowId: "flow-a", enabled: false });
    await configLib.setTableConfigEnabled(db(), { accountId: "acct-1", flowId: "flow-a", enabled: true });
    const after = await configLib.getTableConfig(db(), "acct-1", "flow-a");
    expect(after!.mode).toBe(before.mode);
    expect(after!.assignees.map((a) => a.user_id).sort()).toEqual(["u-1", "u-2"]);
    expect(after!.whatsapp_template_name).toBe(before.whatsapp_template_name);
  });

  it("8. existing lead owners are never modified", async () => {
    await save("flow-a", true);
    const first = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-a", runId: "run-1", formId: "form-1" });
    expect(first.outcome).toBe("assigned");
    const ownerCount = h.values.length;
    const second = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-a", runId: "run-1", formId: "form-1" });
    expect(second.outcome).toBe("already-owned");
    expect(h.values.length).toBe(ownerCount);
  });

  it("9. assignment remains scoped to the correct table", async () => {
    await save("flow-a", true);
    await configLib.saveTableConfig(db(), { accountId: "acct-1", flowId: "flow-b", input: { enabled: false, mode: "round_robin", assignees: [assignee("u-1")] } });
    const r = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-b", runId: "run-9", formId: "form-2" });
    expect(r.outcome).toBe("no-config");
    const ok = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-a", runId: "run-9", formId: "form-1" });
    expect(ok.outcome).toBe("assigned");
  });

  it("10. round robin and percentage both distribute after resume", async () => {
    await configLib.saveTableConfig(db(), { accountId: "acct-1", flowId: "flow-a", input: { enabled: false, mode: "round_robin", assignees: [assignee("u-1"), assignee("u-2")] } });
    await configLib.setTableConfigEnabled(db(), { accountId: "acct-1", flowId: "flow-a", enabled: true });
    const r1 = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-a", runId: "rr-1", formId: "form-1" });
    const r2 = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-a", runId: "rr-2", formId: "form-1" });
    expect(r1.outcome).toBe("assigned");
    expect(r2.outcome).toBe("assigned");
    expect(r1.userId).not.toBe(r2.userId);

    await configLib.saveTableConfig(db(), { accountId: "acct-1", flowId: "flow-b", input: { enabled: true, mode: "percentage", assignees: [{ ...assignee("u-1"), weight: 100 }, { ...assignee("u-2"), weight: 0, is_active: false }] } });
    const p = await engine.assignTableLead(db(), { accountId: "acct-1", flowId: "flow-b", runId: "pct-1", formId: "form-2" });
    expect(p.outcome).toBe("assigned");
    expect(p.userId).toBe("u-1");
  });
});
