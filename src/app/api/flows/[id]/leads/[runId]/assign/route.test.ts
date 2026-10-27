// Lead Assignment manual-assign + retry APIs — Meta gate,
// validation, ownership writes, audit, permissions.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "agent-1",
  flows: [
    { id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "form-1" },
  ] as Array<Record<string, unknown>>,
  runs: [
    { id: "run-1", account_id: "acct-1", flow_id: "flow-1" },
  ] as Array<Record<string, unknown>>,
  fields: [
    { id: "f-assign", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To" },
  ] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  profiles: [
    { user_id: "u-mohan", account_id: "acct-1", account_role: "agent" },
    { user_id: "u-sohan", account_id: "acct-1", account_role: "agent" },
    { user_id: "agent-1", account_id: "acct-1", account_role: "agent" },
  ] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  rules: [] as Array<Record<string, unknown>>,
  ruleTables: [] as Array<Record<string, unknown>>,
  ruleMembers: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  seq: 0,
  enqueued: [] as Array<Record<string, unknown>>,
  legacyDisabled: false,
  tableNotifyCalls: [] as Array<Record<string, unknown>>,
  assigneeEnqueueCalls: [] as Array<Record<string, unknown>>,
  drainScheduled: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  submissions: [] as Array<Record<string, unknown>>,
  handoffCalls: [] as Array<Record<string, unknown>>,
  reconcileCalls: [] as Array<Record<string, unknown>>,
  reconcileResult: { cancelled: 0, sent: 0, sending: 0 } as Record<string, unknown>,
  handoffResult: {
    submissionId: "sub-1",
    decision: "start-assignee",
    reason: "no-global-rows",
    cancelled: 0,
    sent: 0,
  } as Record<string, unknown>,
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

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => fakeSupabase(),
}));

vi.mock("@/lib/meta-lead-ads/notify", () => ({
  maybeEnqueueForRun: async (_db: unknown, args: Record<string, unknown>) => {
    if (h.legacyDisabled) {
      h.enqueued.push(args);
      return { enqueued: false, reason: "disabled" as const };
    }
    // Faithful to the legacy UNIQUE(account, submission) ledger: the
    // first call for a run enqueues, repeats are duplicates — this
    // is exactly what lets a reassigned lead's new owner fall
    // through to the per-table outbox.
    const key = `${args.accountId as string}:${args.runId as string}`;
    const seen = h.enqueued.some(
      (e) => `${e.accountId as string}:${e.runId as string}` === key,
    );
    h.enqueued.push(args);
    return seen
      ? { enqueued: false, reason: "duplicate" as const }
      : { enqueued: true, reason: "enqueued" as const };
  },
}));

vi.mock("@/lib/lead-assignment/table-notify", () => ({
  enqueueTableAssignmentNotifications: async (_db: unknown, args: Record<string, unknown>) => {
    h.tableNotifyCalls.push(args);
    return { email: { enqueued: true, reason: "enqueued" }, whatsapp: { enqueued: true, reason: "enqueued" } };
  },
}));

vi.mock("@/lib/meta-lead-whatsapp/queue", () => ({
  maybeEnqueueAssigneeSequence: async (_db: unknown, args: Record<string, unknown>) => {
    h.assigneeEnqueueCalls.push(args);
    return { enqueued: 1, alreadyQueued: 0, skipped: false };
  },
  prepareManualAssigneeHandoff: async (_db: unknown, args: Record<string, unknown>) => {
    h.handoffCalls.push(args);
    return { ...h.handoffResult };
  },
  cancelLateGlobalRows: async (_db: unknown, args: Record<string, unknown>) => {
    h.reconcileCalls.push(args);
    return { ...h.reconcileResult };
  },
}));

vi.mock("@/lib/meta-lead-whatsapp/trigger", () => ({
  scheduleWhatsappDrainSoon: (args: Record<string, unknown>) => {
    h.drainScheduled.push(args ?? {});
  },
}));

type Filter = { col: string; op: string; val: unknown };

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
  function rows(): Array<Record<string, unknown>> {
    switch (state.table) {
      case "flows": return h.flows;
      case "flow_runs": return h.runs;
      case "workspace_fields": return h.fields;
      case "workspace_values": return h.values;
      case "profiles": return h.profiles;
      case "lead_assignment_events": return h.events;
      case "lead_assignment_table_configs": return h.configs;
      case "lead_assignment_table_assignees": return h.assignees;
      case "meta_lead_submissions": return h.submissions;
      case "lead_assignment_rules": return h.rules;
      case "lead_assignment_rule_tables": return h.ruleTables;
      case "lead_assignment_rule_members": return h.ruleMembers;
      case "lead_assignment_table_state": return h.states;
      default: return [];
    }
  }
  const matched = () =>
    rows().filter((r) =>
      state.filters.every((f) =>
        f.op === "eq"
          ? r[f.col] === f.val
          : f.op === "is-null"
            ? r[f.col] == null
            : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    is: (col: string, val: unknown) => {
      state.filters.push({ col, op: val === null ? "is-null" : "eq", val });
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
        const obj = state.insertObj;
        if (state.table === "workspace_values") {
          const dup = h.values.find(
            (r) => r.field_id === obj.field_id && r.flow_run_id === obj.flow_run_id,
          );
          if (dup) return { data: null, error: { code: "23505", message: "dup" } };
        }
        const row =
          state.table === "lead_assignment_table_state"
            ? { id: uid("row"), rr_cursor: 0, current_weights: {}, version: 0, ...obj }
            : { id: uid("row"), ...obj };
        rows().push(row);
        return { data: row, error: null };
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      if (state.upsertObj) {
        const obj = state.upsertObj;
        const keys = ["field_id", "flow_run_id"];
        const dup = h.values.find((r) => keys.every((k) => r[k] === obj[k]));
        if (dup) {
          Object.assign(dup, obj);
          return { data: dup, error: null };
        }
        const row = { id: uid("wv"), ...obj };
        h.values.push(row);
        return { data: row, error: null };
      }
      const list = matched();
      return { data: list[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.upsertObj) {
        const obj = state.upsertObj;
        const keys = ["field_id", "flow_run_id"];
        const dup = h.values.find((r) => keys.every((k) => r[k] === obj[k]));
        if (dup) {
          Object.assign(dup, obj);
          return resolve({ data: [dup], error: null });
        }
        const row = { id: uid("wv"), ...obj };
        h.values.push(row);
        return resolve({ data: [row], error: null });
      }
      if (state.insertObj) {
        const row = { id: uid("row"), ...state.insertObj };
        rows().push(row);
        return resolve({ data: [row], error: null });
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
      state.insertObj = null;
      state.updateObj = null;
      state.deleteMode = false;
      state.upsertObj = null;
      return api;
    },
  };
}

const { POST: assignPOST } = await import("./route");
const { POST: retryPOST } = await import(
  "../../../../../lead-assignment/retry/route"
);

const ASSIGN_PARAMS = { params: Promise.resolve({ id: "flow-1", runId: "run-1" }) };

function assignBody(body: unknown) {
  return new Request("https://app.test/api/flows/flow-1/leads/run-1/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.authed = true;
  h.role = "admin";
  h.accountId = "acct-1";
  h.userId = "admin-1";
  h.flows = [
    { id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "form-1" },
  ];
  h.runs = [{ id: "run-1", account_id: "acct-1", flow_id: "flow-1" }];
  h.fields = [
    { id: "f-assign", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To" },
  ];
  h.values = [];
  h.events = [];
  h.rules = [];
  h.ruleTables = [];
  h.ruleMembers = [];
  h.states = [];
  h.seq = 0;
  h.enqueued = [];
  h.legacyDisabled = false;
  h.tableNotifyCalls = [];
  h.assigneeEnqueueCalls = [];
  h.drainScheduled = [];
  h.configs = [];
  h.assignees = [];
  h.submissions = [];
  h.handoffCalls = [];
  h.reconcileCalls = [];
  h.reconcileResult = { cancelled: 0, sent: 0, sending: 0 };
  h.handoffResult = {
    submissionId: "sub-1",
    decision: "start-assignee",
    reason: "no-global-rows",
    cancelled: 0,
    sent: 0,
  };
});

describe("POST assign (manual)", () => {
  it("assigns, audits actor/previous/new, and displays via the cell", async () => {
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      assignment: { previous: null, current: "u-mohan" },
      customer_sequence: { started: true, reason: "no-global-rows", cancelled_global: 0 },
    });
    expect(h.values).toMatchObject([{ value_text: "u-mohan" }]);
    expect(h.events[0]).toMatchObject({
      kind: "manual",
      assigned_user_id: "u-mohan",
      previous_user_id: null,
      created_by: "admin-1",
    });
  });

  it("rejects agents: reassignment is admin-only", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(403);
    expect(h.values).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("clears on null and rejects strangers, Flow Tables, and viewers", async () => {
    h.values.push({
      id: "wv-0", account_id: "acct-1", field_id: "f-assign",
      flow_run_id: "run-1", value_text: "u-mohan",
    });
    const cleared = await assignPOST(assignBody({ user_id: null }), ASSIGN_PARAMS);
    expect(cleared.status).toBe(200);
    expect(h.values).toHaveLength(0);
    const stranger = await assignPOST(assignBody({ user_id: "u-stranger" }), ASSIGN_PARAMS);
    expect(stranger.status).toBe(400);
    h.flows = [{ id: "flow-1", account_id: "acct-1", kind: "whatsapp_flow", meta_form_id: null }];
    const flowTable = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(flowTable.status).toBe(404);
    h.flows = [{ id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "form-1" }];
    h.role = "viewer";
    expect((await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS)).status).toBe(403);
  });

  it("enqueues a notification when a lead is manually assigned, never on clear", async () => {
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    expect(h.enqueued).toEqual([
      { accountId: "acct-1", runId: "run-1", assigneeUserId: "u-mohan" },
    ]);
    const cleared = await assignPOST(assignBody({ user_id: null }), ASSIGN_PARAMS);
    expect(cleared.status).toBe(200);
    expect(h.enqueued).toHaveLength(1);
  });

  it("notifies the new assignee through the per-table outbox on initial manual assignment", async () => {
    h.configs.push({
      id: "cfg-1", account_id: "acct-1", flow_id: "flow-1",
      enabled: true, mode: "round_robin", timezone: "Asia/Kolkata",
    });
    h.assignees.push({
      id: "a-1", config_id: "cfg-1", user_id: "u-mohan", display_name: "Mohan",
      email: null, phone: "+15550001111", position: 0, weight: 0,
      is_active: true, notify_email: true, notify_whatsapp: true,
    });
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    // Legacy email still fires for the genuine initial assignment…
    expect(h.enqueued).toHaveLength(1);
    // …so the per-table email is skipped, but WhatsApp is queued.
    expect(h.tableNotifyCalls).toHaveLength(1);
    expect(h.tableNotifyCalls[0]).toMatchObject({
      accountId: "acct-1",
      runId: "run-1",
      skipEmail: true,
      assignee: expect.objectContaining({ user_id: "u-mohan" }),
    });
    // And the new owner's salesperson sequence starts.
    expect(h.assigneeEnqueueCalls).toHaveLength(1);
    expect(h.assigneeEnqueueCalls[0]).toMatchObject({
      accountId: "acct-1",
      formId: "form-1",
      flowRunId: "run-1",
      assigneeKey: "user:u-mohan",
    });
    expect(h.drainScheduled).toEqual([{ accountId: "acct-1" }]);
  });

  it("sends the per-table email on initial manual assignment when the legacy queue is off", async () => {
    h.configs.push({
      id: "cfg-1", account_id: "acct-1", flow_id: "flow-1",
      enabled: true, mode: "round_robin", timezone: "Asia/Kolkata",
    });
    h.assignees.push({
      id: "a-1", config_id: "cfg-1", user_id: "u-mohan", display_name: "Mohan",
      email: null, phone: "+15550001111", position: 0, weight: 0,
      is_active: true, notify_email: true, notify_whatsapp: true,
    });
    // Account-level email setting off (the production gap): the
    // legacy queue declines, so the per-table outbox must carry the
    // email instead of silently dropping it — still exactly once.
    h.legacyDisabled = true;
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    expect(h.tableNotifyCalls).toHaveLength(1);
    expect(h.tableNotifyCalls[0]).toMatchObject({
      accountId: "acct-1",
      runId: "run-1",
      skipEmail: false,
      assignee: expect.objectContaining({ user_id: "u-mohan" }),
    });
  });

  it("notifies the new assignee on reassign without starting customer templates", async () => {
    h.configs.push({
      id: "cfg-1", account_id: "acct-1", flow_id: "flow-1",
      enabled: true, mode: "round_robin", timezone: "Asia/Kolkata",
    });
    h.assignees.push({
      id: "a-1", config_id: "cfg-1", user_id: "u-mohan", display_name: "Mohan",
      email: null, phone: "+15550001111", position: 0, weight: 0,
      is_active: true, notify_email: true, notify_whatsapp: true,
    });
    h.assignees.push({
      id: "a-2", config_id: "cfg-1", user_id: "u-sohan", display_name: "Sohan",
      email: null, phone: "+15550002222", position: 1, weight: 0,
      is_active: true, notify_email: true, notify_whatsapp: true,
    });
    // Prior initial assignment to someone else.
    h.values.push({
      id: "wv-0", account_id: "acct-1", field_id: "f-assign",
      flow_run_id: "run-1", value_text: "u-mohan",
    });
    h.events.push({
      id: "ev-0", account_id: "acct-1", flow_id: "flow-1", flow_run_id: "run-1",
      kind: "auto", assigned_user_id: "u-mohan", previous_user_id: null,
    });
    // The prior assignment already queued its legacy email, so the
    // legacy ledger dedupes this reassignment.
    h.enqueued.push({ accountId: "acct-1", runId: "run-1", assigneeUserId: "u-mohan" });
    const res = await assignPOST(assignBody({ user_id: "u-sohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).assignment).toMatchObject({ previous: "u-mohan", current: "u-sohan" });
    // New owner is notified through the per-table outbox (both
    // channels: the legacy queue dedupes reassignments).
    const reassigned = h.tableNotifyCalls.filter(
      (c) => (c as { assignee: { user_id: string } }).assignee.user_id === "u-sohan",
    );
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]).toMatchObject({ runId: "run-1", skipEmail: false });
    // No customer-facing templates start on reassignment.
    expect(h.assigneeEnqueueCalls).toHaveLength(0);
    expect(h.drainScheduled).toHaveLength(0);
  });

  it("runs the global handoff before starting customer templates on initial manual assignment", async () => {
    h.handoffResult = {
      submissionId: "sub-1",
      decision: "start-assignee",
      reason: "global-pending-cancelled",
      cancelled: 2,
      sent: 0,
    };
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    // The handoff ran first (scoped to this account + lead)…
    expect(h.handoffCalls).toEqual([{ accountId: "acct-1", flowRunId: "run-1" }]);
    // …then the salesperson sequence started and a drain was scheduled.
    expect(h.assigneeEnqueueCalls).toHaveLength(1);
    expect(h.drainScheduled).toEqual([{ accountId: "acct-1" }]);
    expect(await res.json()).toEqual({
      assignment: { previous: null, current: "u-mohan" },
      customer_sequence: { started: true, reason: "global-pending-cancelled", cancelled_global: 2 },
    });
    // The outcome is recorded on the assignment's own audit event.
    expect(h.events[0]).toMatchObject({
      kind: "manual",
      meta: { customer_sequence: { started: true, cancelled_global: 2 } },
    });
  });

  it("reconciles global rows committed after the handoff scan and refills gaps", async () => {
    h.handoffResult = {
      submissionId: "sub-1",
      decision: "start-assignee",
      reason: "no-global-rows",
      cancelled: 0,
      sent: 0,
    };
    h.reconcileResult = { cancelled: 1, sent: 0, sending: 0 };
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    expect(h.reconcileCalls).toEqual([{ accountId: "acct-1", submissionId: "sub-1" }]);
    // Initial enqueue + idempotent gap-fill after the late cancel.
    expect(h.assigneeEnqueueCalls).toHaveLength(2);
    expect(await res.json()).toEqual({
      assignment: { previous: null, current: "u-mohan" },
      customer_sequence: { started: true, reason: "no-global-rows", cancelled_global: 1 },
    });
  });

  it("reports a raced global send discovered during reconciliation", async () => {
    h.reconcileResult = { cancelled: 0, sent: 1, sending: 0 };
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    // No gap-fill when nothing was cancelled.
    expect(h.assigneeEnqueueCalls).toHaveLength(1);
    expect((await res.json()).customer_sequence).toMatchObject({
      started: true,
      reason: "global-send-raced",
      cancelled_global: 0,
    });
  });

  it("does not start a salesperson sequence when a global message already sent", async () => {
    h.handoffResult = {
      submissionId: "sub-1",
      decision: "keep-global",
      reason: "global-already-sent",
      cancelled: 0,
      sent: 1,
    };
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    expect(h.handoffCalls).toHaveLength(1);
    // No customer-facing templates start — but the salesperson is
    // still notified through the existing channels.
    expect(h.assigneeEnqueueCalls).toHaveLength(0);
    expect(h.drainScheduled).toHaveLength(0);
    expect(h.enqueued).toHaveLength(1);
    expect(await res.json()).toEqual({
      assignment: { previous: null, current: "u-mohan" },
      customer_sequence: { started: false, reason: "global-already-sent", cancelled_global: 0 },
    });
    expect(h.events[0]).toMatchObject({
      meta: { customer_sequence: { started: false, reason: "global-already-sent" } },
    });
  });

  it("reassignment never runs the handoff or touches customer sequences", async () => {
    h.values.push({
      id: "wv-0", account_id: "acct-1", field_id: "f-assign",
      flow_run_id: "run-1", value_text: "u-mohan",
    });
    h.events.push({
      id: "ev-0", account_id: "acct-1", flow_id: "flow-1", flow_run_id: "run-1",
      kind: "auto", assigned_user_id: "u-mohan", previous_user_id: null,
    });
    const res = await assignPOST(assignBody({ user_id: "u-sohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    expect(h.handoffCalls).toHaveLength(0);
    expect(h.assigneeEnqueueCalls).toHaveLength(0);
    expect(h.drainScheduled).toHaveLength(0);
    expect(await res.json()).toEqual({
      assignment: { previous: "u-mohan", current: "u-sohan" },
      customer_sequence: { started: false, reason: "reassignment", cancelled_global: 0 },
    });
  });

  it("duplicate assignment events do not start duplicate customer sequences", async () => {
    const first = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(first.status).toBe(200);
    expect(h.assigneeEnqueueCalls).toHaveLength(1);
    // The redelivery sees the existing owner: a reassignment by
    // definition — notify-only, no handoff, no new templates.
    const second = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(second.status).toBe(200);
    expect(h.handoffCalls).toHaveLength(1);
    expect(h.assigneeEnqueueCalls).toHaveLength(1);
    expect((await second.json()).customer_sequence).toMatchObject({
      started: false,
      reason: "reassignment",
    });
  });

  it("skips per-table notify when clearing or unconfigured, but still starts customer sequences on initial assign", async () => {
    const cleared = await assignPOST(assignBody({ user_id: null }), ASSIGN_PARAMS);
    expect(cleared.status).toBe(200);
    // Clearing never notifies and never starts customer templates.
    expect(h.tableNotifyCalls).toHaveLength(0);
    expect(h.assigneeEnqueueCalls).toHaveLength(0);
    // No table assignment config: legacy notification only for the
    // alert, but a genuine initial assignment still starts the
    // salesperson's customer sequence (form-scoped, independent of
    // the table assignment config).
    const res = await assignPOST(assignBody({ user_id: "u-mohan" }), ASSIGN_PARAMS);
    expect(res.status).toBe(200);
    expect(h.tableNotifyCalls).toHaveLength(0);
    expect(h.enqueued).toHaveLength(1);
    expect(h.assigneeEnqueueCalls).toHaveLength(1);
    expect(h.assigneeEnqueueCalls[0]).toMatchObject({ formId: "form-1", assigneeKey: "user:u-mohan" });
  });
});

describe("POST retry", () => {
  it("assigns unowned leads through the applicable rule", async () => {
    h.rules.push({
      id: "rule-1", account_id: "acct-1", name: "R", scope: "specific",
      mode: "round_robin", status: "active", created_at: "2026-01-01T00:00:00Z",
    });
    h.ruleTables.push({ rule_id: "rule-1", form_id: "form-1" });
    h.ruleMembers.push({ rule_id: "rule-1", user_id: "u-mohan", position: 0, weight: 0 });
    const res = await retryPOST(
      new Request("https://app.test/api/lead-assignment/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow_id: "flow-1", run_id: "run-1" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { assignment: { outcome: string; userId: string } };
    expect(json.assignment).toMatchObject({ outcome: "assigned", userId: "u-mohan" });
    expect(h.enqueued).toEqual([
      { accountId: "acct-1", runId: "run-1", assigneeUserId: "u-mohan" },
    ]);
  });

  it("skips owned leads and rejects non-Meta tables", async () => {
    h.rules.push({
      id: "rule-1", account_id: "acct-1", name: "R", scope: "specific",
      mode: "round_robin", status: "active", created_at: "2026-01-01T00:00:00Z",
    });
    h.ruleTables.push({ rule_id: "rule-1", form_id: "form-1" });
    h.ruleMembers.push({ rule_id: "rule-1", user_id: "u-sohan", position: 0, weight: 0 });
    h.values.push({
      id: "wv-0", account_id: "acct-1", field_id: "f-assign",
      flow_run_id: "run-1", value_text: "u-mohan",
    });
    const before = h.states.length;
    const res = await retryPOST(
      new Request("https://app.test/api/lead-assignment/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow_id: "flow-1", run_id: "run-1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { assignment: { outcome: string } }).assignment.outcome).toBe(
      "already-owned",
    );
    // Manual owner preserved, no state advanced, no new event.
    expect(h.values[0].value_text).toBe("u-mohan");
    expect(h.states.length).toBe(before);
    expect(h.events).toHaveLength(0);
    h.flows = [{ id: "flow-1", account_id: "acct-1", kind: "whatsapp_flow", meta_form_id: null }];
    const bad = await retryPOST(
      new Request("https://app.test/api/lead-assignment/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow_id: "flow-1", run_id: "run-1" }),
      }),
    );
    expect(bad.status).toBe(404);
  });
});
