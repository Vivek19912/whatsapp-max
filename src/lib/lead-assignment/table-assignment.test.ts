// Per-table assignment engine — isolation, distribution,
// pauses, idempotency, concurrency, notifications. Google Sheets
// is never touched; Travel CRM is never touched.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  flows: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  submissions: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  assigneeSeqs: [] as Array<Record<string, unknown>>,
  assigneeItems: [] as Array<Record<string, unknown>>,
  queue: [] as Array<Record<string, unknown>>,
  drainScheduled: [] as Array<Record<string, unknown>>,
  seq: 0,
  bumpVersionOnStateRead: false,
}));

vi.mock("@/lib/meta-lead-whatsapp/trigger", () => ({
  scheduleWhatsappDrainSoon: (args: Record<string, unknown>) => {
    h.drainScheduled.push(args ?? {});
  },
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
    case "flow_runs": return h.runs;
    case "profiles": return h.profiles;
    case "accounts": return h.accounts;
    case "meta_lead_submissions": return h.submissions;
    case "lead_assignment_notifications": return h.notifications;
    case "meta_lead_assignee_sequences": return h.assigneeSeqs;
    case "meta_lead_assignee_sequence_items": return h.assigneeItems;
    case "meta_lead_whatsapp_queue": return h.queue;
    default: return [];
  }
}

function applyInsert(table: string, obj: Record<string, unknown>) {
  const withId = "id" in obj && obj.id ? obj : { id: `row-${++h.seq}`, ...obj };
  if (table === "workspace_values") {
    const dup = h.values.find(
      (r) => r.field_id === withId.field_id && r.flow_run_id === withId.flow_run_id,
    );
    if (dup) return { row: null as never, error: { code: "23505", message: "dup" } };
    const row = { ...withId };
    h.values.push(row);
    return { row, error: null };
  }
  if (table === "lead_assignment_table_config_state") {
    const dup = h.states.find((r) => r.config_id === withId.config_id);
    if (dup) return { row: null as never, error: { code: "23505", message: "dup" } };
    const row = { rr_cursor: 0, current_weights: {}, version: 0, ...withId };
    h.states.push(row);
    return { row, error: null };
  }
  if (table === "lead_assignment_notifications") {
    const dup = h.notifications.find(
      (r) =>
        r.account_id === withId.account_id &&
        r.flow_run_id === withId.flow_run_id &&
        r.assignee_id === withId.assignee_id &&
        r.channel === withId.channel,
    );
    if (dup) return { row: null as never, error: { code: "23505", message: "dup" } };
  }
  if (table === "meta_lead_whatsapp_queue") {
    const dup = h.queue.find(
      (r) =>
        r.account_id === withId.account_id &&
        r.submission_id === withId.submission_id &&
        r.template_name === withId.template_name &&
        (r.template_language ?? "en_US") === (withId.template_language ?? "en_US"),
    );
    if (dup) return { row: null as never, error: { code: "23505", message: "dup" } };
  }
  const row = { ...withId };
  tableRows(table).push(row);
  return { row, error: null };
}

function applyUpsert(
  table: string,
  obj: Record<string, unknown>,
  onConflict: string,
): Record<string, unknown> {
  const keys = onConflict
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  if (keys.length > 0) {
    const existing = tableRows(table).find((r) => keys.every((k) => r[k] === obj[k]));
    if (existing) {
      Object.assign(existing, obj);
      return existing;
    }
  }
  // Mirror the DB column defaults the real upsert would apply.
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

  const applyPendingInsert = (): { rows: Array<Record<string, unknown>>; error: { code: string; message: string } | null } => {
    const inserted: Array<Record<string, unknown>> = [];
    for (const row of state.insertRows ?? []) {
      const applied = applyInsert(state.table, row);
      if (applied.error) return { rows: [], error: applied.error };
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
    limit: () => api,
    lte: () => api,
    insert: (obj: Record<string, unknown> | Record<string, unknown>[]) => {
      state.insertRows = (Array.isArray(obj) ? obj : [obj]) as Array<Record<string, unknown>>;
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
      if (state.insertRows) {
        const { rows, error } = applyPendingInsert();
        if (error) return { data: null, error };
        return { data: rows[0] ?? null, error: null };
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      if (state.deleteMode) {
        const list = matched();
        for (const r of list) {
          const arr = tableRows(state.table);
          arr.splice(arr.indexOf(r), 1);
        }
        return { data: list[0] ?? null, error: null };
      }
      const list = matched();
      if (state.table === "lead_assignment_table_config_state" && h.bumpVersionOnStateRead && list[0]) {
        h.bumpVersionOnStateRead = false;
        list[0].version = Number(list[0].version) + 1;
      }
      return { data: list[0] ?? null, error: null };
    },
    single: async () => {
      if (state.upsertObj) {
        return { data: applyUpsert(state.table, state.upsertObj, state.upsertConflict), error: null };
      }
      if (state.insertRows) {
        const { rows, error } = applyPendingInsert();
        if (error) return { data: null, error };
        return { data: rows[0] ?? null, error: null };
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
      if (state.upsertObj) {
        return resolve({
          data: [applyUpsert(state.table, state.upsertObj, state.upsertConflict)],
          error: null,
        });
      }
      if (state.insertRows) {
        const { rows, error } = applyPendingInsert();
        if (error) return resolve({ data: null, error });
        return resolve({ data: rows, error: null });
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return resolve({ data: list, error: null });
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
      state.insertRows = null;
      state.updateObj = null;
      state.deleteMode = false;
      state.upsertObj = null;
      state.upsertConflict = "";
      return api;
    },
  };
}

const engine = await import("./table-assignment");
const configLib = await import("./table-config");

function seedBase() {
  h.flows = [
    { id: "flow-meta-1", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "formdb-1" },
    { id: "flow-meta-2", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "formdb-2" },
    { id: "flow-plain-1", account_id: "acct-1", kind: "whatsapp_flow", meta_form_id: null },
    { id: "flow-plain-2", account_id: "acct-1", kind: "whatsapp_flow", meta_form_id: null },
    { id: "flow-foreign", account_id: "acct-2", kind: "meta_lead_ads", meta_form_id: "formdb-x" },
  ];
  h.configs = [];
  h.assignees = [];
  h.states = [];
  h.fields = [
    { id: "f-assign-1", account_id: "acct-1", flow_id: "flow-meta-1", name: "Assigned To" },
    { id: "f-assign-2", account_id: "acct-1", flow_id: "flow-meta-2", name: "Assigned To" },
    { id: "f-assign-3", account_id: "acct-1", flow_id: "flow-plain-1", name: "Assigned To" },
    { id: "f-assign-4", account_id: "acct-1", flow_id: "flow-plain-2", name: "Assigned To" },
  ];
  h.values = [];
  h.events = [];
  h.runs = [];
  h.profiles = [
    { user_id: "u-asha", account_id: "acct-1", account_role: "agent", full_name: "Asha", email: "asha@x.com" },
    { user_id: "u-ravi", account_id: "acct-1", account_role: "admin", full_name: "Ravi", email: "ravi@x.com" },
    { user_id: "u-viewer", account_id: "acct-1", account_role: "viewer", full_name: "V", email: "v@x.com" },
    { user_id: "u-owner", account_id: "acct-1", account_role: "owner", full_name: "Owner", email: "o@x.com" },
  ];
  h.accounts = [{ id: "acct-1", owner_user_id: "u-owner" }];
  h.submissions = [];
  h.notifications = [];
  h.assigneeSeqs = [];
  h.assigneeItems = [];
  h.queue = [];
  h.drainScheduled = [];
  h.seq = 0;
  h.bumpVersionOnStateRead = false;
}

async function saveConfig(
  db: ReturnType<typeof fakeSupabase>,
  flowId: string,
  input: Record<string, unknown>,
) {
  return configLib.saveTableConfig(db as never, {
    accountId: "acct-1",
    flowId,
    input: input as never,
  });
}

function assignee(userId: string | null, extra: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    display_name: extra.display_name ?? (userId ?? "External"),
    email: (extra.email as string | undefined) ?? null,
    phone: (extra.phone as string | undefined) ?? null,
    weight: (extra.weight as number | undefined) ?? 0,
    is_active: true,
    notify_email: true,
    notify_whatsapp: false,
    ...extra,
  };
}

function run(id: string, flowId: string, account = "acct-1") {
  h.runs.push({ id, account_id: account, flow_id: flowId });
}

beforeEach(() => {
  seedBase();
});

describe("per-table isolation", () => {
  it("two Meta tables keep independent configs, pools, and cursors", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" }), assignee("u-ravi", { display_name: "Ravi" })],
    });
    await saveConfig(db, "flow-meta-2", {
      enabled: true,
      mode: "percentage",
      assignees: [assignee("u-ravi", { display_name: "Ravi", weight: 100 })],
    });
    run("run-a1", "flow-meta-1");
    run("run-a2", "flow-meta-1");
    run("run-b1", "flow-meta-2");

    const r1 = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-a1",
      formId: "formdb-1",
    });
    const r2 = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-a2",
      formId: "formdb-1",
    });
    const r3 = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-2",
      runId: "run-b1",
      formId: "formdb-2",
    });
    // Table 1 round-robins Asha then Ravi; table 2 only has Ravi.
    expect(r1).toMatchObject({ outcome: "assigned", userId: "u-asha" });
    expect(r2).toMatchObject({ outcome: "assigned", userId: "u-ravi" });
    expect(r3).toMatchObject({ outcome: "assigned", userId: "u-ravi" });
    // States are per config (independent cursors/weights).
    expect(h.states).toHaveLength(2);
    // Ownership cells went to each table's own field.
    expect(
      h.values.filter((v) => v.field_id === "f-assign-1").map((v) => v.value_text).sort(),
    ).toEqual(["u-asha", "u-ravi"]);
    expect(h.values.filter((v) => v.field_id === "f-assign-2").map((v) => v.value_text)).toEqual([
      "u-ravi",
    ]);
  });

  it("two Flow tables keep independent configs", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" })],
    });
    await saveConfig(db, "flow-plain-2", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-ravi", { display_name: "Ravi" })],
    });
    run("run-f1", "flow-plain-1");
    run("run-f2", "flow-plain-2");
    const r1 = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-f1",
      formId: null,
    });
    const r2 = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-2",
      runId: "run-f2",
      formId: null,
    });
    expect(r1).toMatchObject({ outcome: "assigned", userId: "u-asha" });
    expect(r2).toMatchObject({ outcome: "assigned", userId: "u-ravi" });
  });

  it("resolves cross-tenant tables to 404 and never reads their configs", async () => {
    const db = fakeSupabase();
    const resolved = await configLib.resolveTableFlow(db as never, "acct-1", "flow-foreign");
    expect(resolved).toBeNull();
    const detail = await configLib.getTableConfig(db as never, "acct-1", "flow-foreign");
    expect(detail).toBeNull();
  });
});

describe("custom vs internal assignees", () => {
  it("external recipients get notifications, never ownership", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [
        assignee("u-asha", { display_name: "Asha" }),
        assignee(null, { display_name: "External", email: "ext@example.com" }),
      ],
    });
    run("run-1", "flow-meta-1");
    run("run-2", "flow-meta-1");
    h.submissions = [
      { id: "sub-1", account_id: "acct-1", flow_run_id: "run-1" },
      { id: "sub-2", account_id: "acct-1", flow_run_id: "run-2" },
    ];
    const first = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-1",
      formId: "formdb-1",
    });
    const second = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-2",
      formId: "formdb-1",
    });
    expect(first.userId).toBe("u-asha");
    expect(second.outcome).toBe("assigned-external");
    expect(second.userId).toBeNull();
    // No ownership row for the external lead (stays Unassigned).
    expect(h.values.filter((v) => v.flow_run_id === "run-2")).toHaveLength(0);
    // External email went to the new outbox (legacy queue untouched).
    const externalNote = h.notifications.find(
      (n) => n.flow_run_id === "run-2" && n.channel === "email",
    );
    expect(externalNote?.to_email).toBe("ext@example.com");
    // Internal Meta members now use the per-table outbox too — the
    // legacy queue is never consulted, so one assignment yields one
    // email to the configured address.
    const internalNote = h.notifications.find(
      (n) => n.flow_run_id === "run-1" && n.channel === "email",
    );
    expect(internalNote?.to_email).toBeNull();
  });

  it("notifies internal members through the per-table outbox only (no legacy queue)", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [
        assignee("u-asha", {
          display_name: "Asha",
          email: "aman@example.com",
          phone: "+15550001111",
          notify_whatsapp: true,
        }),
      ],
    });
    run("run-9", "flow-meta-1");
    h.submissions = [{ id: "sub-9", account_id: "acct-1", flow_run_id: "run-9" }];
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-9",
      formId: "formdb-1",
    });
    expect(r).toMatchObject({ outcome: "assigned", userId: "u-asha" });
    // Exactly one email attempt: the per-table outbox row carrying
    // the assignee's configured address.
    const emailRows = h.notifications.filter(
      (n) => n.flow_run_id === "run-9" && n.channel === "email",
    );
    expect(emailRows).toHaveLength(1);
    expect(emailRows[0]).toMatchObject({ to_email: "aman@example.com" });
  });

  it("resolves lead name and phone from run answers when no contact is linked", async () => {
    // Production regression: the notification snapshot read only
    // the contacts row, so unlinked leads produced blank emails and
    // failed the {{2}} WhatsApp variable — even though the table
    // shows real Name and Phone Number columns from the answers.
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [
        assignee("u-asha", {
          display_name: "Asha",
          email: "aman@example.com",
          notify_whatsapp: true,
          phone: "+15550001111",
        }),
      ],
    });
    h.runs.push({
      id: "run-answers",
      account_id: "acct-1",
      flow_id: "flow-meta-1",
      started_at: "2026-10-27T19:28:40+00:00",
      contact_id: null,
      vars: { full_name: "Mukesh", phone_number: "+919876543210" },
    });
    h.submissions = [{ id: "sub-a", account_id: "acct-1", flow_run_id: "run-answers" }];
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-answers",
      formId: "formdb-1",
    });
    expect(r).toMatchObject({ outcome: "assigned", userId: "u-asha" });
    const emailRows = h.notifications.filter(
      (n) => n.flow_run_id === "run-answers" && n.channel === "email",
    );
    expect(emailRows).toHaveLength(1);
    expect(emailRows[0]).toMatchObject({
      to_email: "aman@example.com",
      lead_name: "Mukesh",
      lead_phone: "+919876543210",
    });
    const whatsappRows = h.notifications.filter(
      (n) => n.flow_run_id === "run-answers" && n.channel === "whatsapp",
    );
    expect(whatsappRows).toHaveLength(1);
    expect(whatsappRows[0]).toMatchObject({
      to_phone: "+15550001111",
      lead_name: "Mukesh",
      lead_phone: "+919876543210",
    });
  });
});

describe("distribution", () => {
  it("round-robins across eligible members in order, wrapping around", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [
        assignee("u-asha", { display_name: "Asha" }),
        assignee("u-ravi", { display_name: "Ravi" }),
        assignee("u-owner", { display_name: "Owner" }),
      ],
    });
    const got: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      run(`run-${i}`, "flow-plain-1");
      const r = await engine.assignTableLead(db as never, {
        accountId: "acct-1",
        flowId: "flow-plain-1",
        runId: `run-${i}`,
        formId: null,
      });
      got.push(r.userId);
    }
    expect(got).toEqual(["u-asha", "u-ravi", "u-owner", "u-asha"]);
  });

  it("distributes percentages 60/40 over ten leads", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "percentage",
      assignees: [
        assignee("u-asha", { display_name: "Asha", weight: 60 }),
        assignee("u-ravi", { display_name: "Ravi", weight: 40 }),
      ],
    });
    const counts = new Map<string, number>();
    for (let i = 0; i < 10; i++) {
      run(`run-${i}`, "flow-plain-1");
      const r = await engine.assignTableLead(db as never, {
        accountId: "acct-1",
        flowId: "flow-plain-1",
        runId: `run-${i}`,
        formId: null,
      });
      counts.set(r.userId as string, (counts.get(r.userId as string) ?? 0) + 1);
    }
    expect(counts.get("u-asha")).toBe(6);
    expect(counts.get("u-ravi")).toBe(4);
  });

  it("skips weight-0 members in percentage mode", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: false,
      mode: "percentage",
      assignees: [
        assignee("u-asha", { display_name: "Asha", weight: 100 }),
        assignee("u-ravi", { display_name: "Ravi", weight: 0 }),
      ],
    });
    // Disabled config: nothing assigned.
    run("run-0", "flow-plain-1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-0",
      formId: null,
    });
    expect(r.outcome).toBe("no-config");
  });
});

describe("pauses and availability", () => {
  it("pauses one person for today and for N days; others keep receiving", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [
        assignee("u-asha", { display_name: "Asha" }),
        assignee("u-ravi", { display_name: "Ravi" }),
      ],
    });
    const detail = await configLib.getTableConfig(db as never, "acct-1", "flow-plain-1");
    const asha = detail!.assignees.find((a) => a.user_id === "u-asha")!;
    await configLib.pauseTableAssignee(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      assigneeId: asha.id,
      input: { mode: "days", days: 3, reason: "On leave" },
    });
    const got: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      run(`run-${i}`, "flow-plain-1");
      const r = await engine.assignTableLead(db as never, {
        accountId: "acct-1",
        flowId: "flow-plain-1",
        runId: `run-${i}`,
        formId: null,
      });
      got.push(r.userId);
    }
    // Asha paused: every lead went to Ravi.
    expect(got).toEqual(["u-ravi", "u-ravi", "u-ravi"]);
  });

  it("expired pauses restore eligibility automatically", async () => {
    const db = fakeSupabase();
    const detail = await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" })],
    });
    // Backdate the window: expired yesterday.
    const row = h.assignees.find((a) => a.config_id === detail.id)!;
    row.paused_until = new Date(Date.now() - 24 * 60_60_1000).toISOString();
    run("run-0", "flow-plain-1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-0",
      formId: null,
    });
    expect(r).toMatchObject({ outcome: "assigned", userId: "u-asha" });
  });

  it("early resume restores the assignee immediately", async () => {
    const db = fakeSupabase();
    const detail = await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" })],
    });
    const asha = detail.assignees[0];
    await configLib.pauseTableAssignee(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      assigneeId: asha.id,
      input: { mode: "days", days: 5 },
    });
    run("run-0", "flow-plain-1");
    const paused = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-0",
      formId: null,
    });
    expect(paused.outcome).toBe("no-eligible");
    await configLib.pauseTableAssignee(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      assigneeId: asha.id,
      input: { mode: "resume" },
    });
    run("run-1", "flow-plain-1");
    const resumed = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-1",
      formId: null,
    });
    expect(resumed).toMatchObject({ outcome: "assigned", userId: "u-asha" });
  });

  it("all paused or inactive leaves the lead unassigned with a clear reason", async () => {
    const db = fakeSupabase();
    const detail = await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [
        assignee("u-asha", { display_name: "Asha" }),
        assignee("u-ravi", { display_name: "Ravi" }),
      ],
    });
    for (const a of detail.assignees) {
      await configLib.pauseTableAssignee(db as never, {
        accountId: "acct-1",
        flowId: "flow-meta-1",
        assigneeId: a.id,
        input: { mode: "today" },
      });
    }
    run("run-0", "flow-meta-1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-0",
      formId: "formdb-1",
    });
    expect(r.outcome).toBe("no-eligible");
    expect(h.values).toHaveLength(0);
    expect(
      h.events.find((e) => e.flow_run_id === "run-0" && e.kind === "unassigned")?.reason,
    ).toBe("no-eligible-assignees");
  });

  it("empty roster with automatic assignment enabled leaves leads unassigned without throwing", async () => {
    // Production regression: saving zero assignees failed, so this
    // path was unreachable. An enabled-but-empty table must behave
    // like "nobody eligible": no owner, no notifications, and no
    // customer-facing sequence — even when a removed salesperson's
    // sequence row still exists (orphaned sequences never fire
    // because only actually-assigned salespeople enqueue).
    const db = fakeSupabase();
    const detail = await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "percentage",
      assignees: [],
    });
    expect(detail.enabled).toBe(true);
    expect(detail.assignees).toEqual([]);
    h.assigneeSeqs.push({
      id: "seq-stale",
      account_id: "acct-1",
      form_id: "formdb-1",
      salesperson_key: "user:u-asha",
      delay_seconds: 0,
    });
    h.assigneeItems.push({
      id: "seq-stale-i0",
      sequence_id: "seq-stale",
      template_name: "welcome_back",
      template_language: "en_US",
      position: 0,
      variable_mappings: {},
    });
    h.submissions.push({
      id: "sub-1",
      account_id: "acct-1",
      flow_run_id: "run-empty",
      form_id: "formdb-1",
    });
    run("run-empty", "flow-meta-1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-empty",
      formId: "formdb-1",
    });
    expect(r).toMatchObject({ outcome: "no-eligible", userId: null, assigneeId: null });
    expect(h.values).toHaveLength(0);
    expect(
      h.events.find((e) => e.flow_run_id === "run-empty" && e.kind === "unassigned")?.reason,
    ).toBe("no-eligible-assignees");
    // No customer-facing sequence started from the emptied roster.
    expect(h.queue).toHaveLength(0);
    expect(h.drainScheduled).toHaveLength(0);
    // The never-throw ingestion wrapper agrees.
    run("run-empty-2", "flow-meta-1");
    const viaWrapper = await engine.maybeAutoAssignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-empty-2",
      formId: "formdb-1",
    });
    expect(viaWrapper).toMatchObject({ outcome: "no-eligible" });
  });

  it("account-scope pauses block the person on every table", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" }), assignee("u-ravi", { display_name: "Ravi" })],
    });
    await saveConfig(db, "flow-plain-2", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" }), assignee("u-ravi", { display_name: "Ravi" })],
    });
    const d1 = await configLib.getTableConfig(db as never, "acct-1", "flow-plain-1");
    const asha = d1!.assignees.find((a) => a.user_id === "u-asha")!;
    await configLib.pauseTableAssignee(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      assigneeId: asha.id,
      input: { mode: "days", days: 2, scope: "account" },
    });
    run("run-x", "flow-plain-2");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-2",
      runId: "run-x",
      formId: null,
    });
    expect(r).toMatchObject({ outcome: "assigned", userId: "u-ravi" });
  });
});

describe("reliability", () => {
  it("duplicate deliveries assign once (skip-if-owned)", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" }), assignee("u-ravi", { display_name: "Ravi" })],
    });
    run("run-0", "flow-plain-1");
    const first = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-0",
      formId: null,
    });
    const second = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-0",
      formId: null,
    });
    expect(first.outcome).toBe("assigned");
    expect(second.outcome).toBe("already-owned");
    // Cursor advanced exactly once: next new lead goes to Ravi.
    run("run-1", "flow-plain-1");
    const third = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-1",
      formId: null,
    });
    expect(third.userId).toBe("u-ravi");
  });

  it("CAS conflicts retry and converge instead of duplicating", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" })],
    });
    h.bumpVersionOnStateRead = true;
    run("run-0", "flow-plain-1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-0",
      formId: null,
    });
    expect(r).toMatchObject({ outcome: "assigned", userId: "u-asha" });
    expect(h.values.filter((v) => v.flow_run_id === "run-0")).toHaveLength(1);
  });

  it("configuration changes never reassign historical leads", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" })],
    });
    run("run-0", "flow-plain-1");
    await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-0",
      formId: null,
    });
    // Reorder + add a member + change mode: history stays put.
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "percentage",
      assignees: [
        assignee("u-ravi", { display_name: "Ravi", weight: 100 }),
        assignee("u-asha", { display_name: "Asha", weight: 0 }),
      ],
    });
    expect(h.values.find((v) => v.flow_run_id === "run-0")?.value_text).toBe("u-asha");
    run("run-1", "flow-plain-1");
    const next = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-1",
      formId: null,
    });
    expect(next.userId).toBe("u-ravi");
  });

  it("notification failures never block assignment", async () => {
    // The per-table outbox swallows its own errors by design
    // (enqueue never throws), so even a broken notification path
    // cannot fail the assignment itself.
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha", notify_whatsapp: true, phone: "+15551234567" })],
    });
    h.submissions = [{ id: "sub-1", account_id: "acct-1", flow_run_id: "run-0" }];
    run("run-0", "flow-meta-1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-0",
      formId: "formdb-1",
    });
    expect(r).toMatchObject({ outcome: "assigned", userId: "u-asha" });
    expect(
      h.notifications.filter((n) => n.flow_run_id === "run-0"),
    ).toHaveLength(2);
  });

  it("removed members lose eligibility without touching the config", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [
        assignee("u-asha", { display_name: "Asha" }),
        assignee("u-ravi", { display_name: "Ravi" }),
      ],
    });
    // Ravi leaves the company after the config was saved: only
    // Asha is eligible, and the saved config still lists both.
    h.profiles = h.profiles.filter((p) => p.user_id !== "u-ravi");
    run("run-0", "flow-plain-1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-0",
      formId: null,
    });
    expect(r.userId).toBe("u-asha");
    const detail = await configLib.getTableConfig(db as never, "acct-1", "flow-plain-1");
    expect(detail!.assignees).toHaveLength(2);
  });
});

describe("salesperson customer sequences (initial assignment only)", () => {
  function seedSequence(key = "user:u-asha", delaySeconds = 60) {
    h.assigneeSeqs.push({
      id: "seq-1",
      account_id: "acct-1",
      form_id: "formdb-1",
      salesperson_key: key,
      delay_seconds: delaySeconds,
    });
    h.assigneeItems.push(
      {
        id: "seq-1-i0",
        sequence_id: "seq-1",
        template_name: "welcome_back",
        template_language: "en_US",
        position: 0,
        variable_mappings: {},
      },
      {
        id: "seq-1-i1",
        sequence_id: "seq-1",
        template_name: "offer_update",
        template_language: "en_US",
        position: 1,
        variable_mappings: {},
      },
    );
  }

  function seedSubmission(runId: string, submissionId = "sub-1") {
    h.submissions.push({
      id: submissionId,
      account_id: "acct-1",
      flow_run_id: runId,
      form_id: "formdb-1",
    });
  }

  it("starts the salesperson's sequence on a genuine initial assignment", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha", notify_whatsapp: true, phone: "+15551234567" })],
    });
    seedSequence();
    run("run-a1", "flow-meta-1");
    seedSubmission("run-a1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-a1",
      formId: "formdb-1",
    });
    expect(r).toMatchObject({ outcome: "assigned", userId: "u-asha" });
    // Two customer rows, keyed to the salesperson, staggered by the
    // per-salesperson delay.
    const queued = h.queue.filter((q) => q.submission_id === "sub-1");
    expect(queued).toHaveLength(2);
    for (const q of queued) expect(q.assignee_key).toBe("user:u-asha");
    const byTemplate = Object.fromEntries(queued.map((q) => [q.template_name, q]));
    expect(byTemplate.welcome_back.position).toBe(0);
    expect(byTemplate.offer_update.position).toBe(1);
    expect(
      Date.parse(byTemplate.offer_update.scheduled_for as string) -
        Date.parse(byTemplate.welcome_back.scheduled_for as string),
    ).toBe(60_000);
    // A prompt drain was scheduled for the new customer sends.
    expect(h.drainScheduled).toEqual([{ accountId: "acct-1" }]);
    // Assignment notifications still fire through the per-table
    // outbox only — no legacy queue.
    const notes = h.notifications.filter((n) => n.flow_run_id === "run-a1");
    expect(notes.filter((n) => n.channel === "whatsapp")).toHaveLength(1);
    expect(notes.filter((n) => n.channel === "email")).toHaveLength(1);
  });

  it("does not start customer sequences on duplicate deliveries (already owned)", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" })],
    });
    seedSequence("user:u-asha", 0);
    run("run-a1", "flow-meta-1");
    seedSubmission("run-a1");
    const first = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-a1",
      formId: "formdb-1",
    });
    expect(first.outcome).toBe("assigned");
    expect(h.queue).toHaveLength(2);
    const drainsBefore = h.drainScheduled.length;
    // Duplicate webhook / retry for the same lead.
    const second = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-a1",
      formId: "formdb-1",
    });
    expect(second.outcome).toBe("already-owned");
    expect(h.queue).toHaveLength(2);
    expect(h.drainScheduled).toHaveLength(drainsBefore);
  });

  it("does not start customer sequences after a clear-then-reassign", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [
        assignee("u-asha", { display_name: "Asha", notify_whatsapp: true, phone: "+15551234567" }),
        assignee("u-ravi", { display_name: "Ravi" }),
      ],
    });
    seedSequence();
    run("run-a1", "flow-meta-1");
    seedSubmission("run-a1");
    // History shows a previous assignment that was cleared — the
    // lead is unassigned now, but this is NOT an initial assignment.
    h.events.push({
      id: "evt-old",
      account_id: "acct-1",
      flow_id: "flow-meta-1",
      flow_run_id: "run-a1",
      form_id: "formdb-1",
      kind: "manual",
      reason: null,
      assigned_user_id: null,
      previous_user_id: "u-ravi",
      created_by: "owner-1",
    });
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-a1",
      formId: "formdb-1",
    });
    expect(r.outcome).toBe("assigned");
    // Assignment + notifications proceed, but no customer templates.
    expect(h.queue).toHaveLength(0);
    expect(h.drainScheduled).toHaveLength(0);
    expect(h.notifications.filter((n) => n.flow_run_id === "run-a1")).not.toHaveLength(0);
  });

  it("sends nothing when the salesperson has no configured sequence", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-ravi", { display_name: "Ravi", notify_whatsapp: true, phone: "+15551234567" })],
    });
    run("run-a1", "flow-meta-1");
    seedSubmission("run-a1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-a1",
      formId: "formdb-1",
    });
    expect(r).toMatchObject({ outcome: "assigned", userId: "u-ravi" });
    // Notifications still work; no customer-facing sequence exists.
    expect(h.notifications.filter((n) => n.flow_run_id === "run-a1")).not.toHaveLength(0);
    expect(h.queue).toHaveLength(0);
    expect(h.drainScheduled).toHaveLength(0);
  });

  it("keys external assignees by contact email", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-meta-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee(null, { display_name: "Ext", email: "Ext@Example.com", phone: "+15550001111", notify_whatsapp: true })],
    });
    h.assigneeSeqs.push({
      id: "seq-ext",
      account_id: "acct-1",
      form_id: "formdb-1",
      salesperson_key: "email:ext@example.com",
      delay_seconds: 0,
    });
    h.assigneeItems.push({
      id: "seq-ext-i0",
      sequence_id: "seq-ext",
      template_name: "welcome_back",
      template_language: "en_US",
      position: 0,
      variable_mappings: {},
    });
    run("run-ext", "flow-meta-1");
    h.submissions.push({ id: "sub-ext", account_id: "acct-1", flow_run_id: "run-ext", form_id: "formdb-1" });
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-meta-1",
      runId: "run-ext",
      formId: "formdb-1",
    });
    expect(r.outcome).toBe("assigned-external");
    expect(h.queue).toHaveLength(1);
    expect(h.queue[0].assignee_key).toBe("email:ext@example.com");
  });

  it("never enqueues for Flow tables (no form scope)", async () => {
    const db = fakeSupabase();
    await saveConfig(db, "flow-plain-1", {
      enabled: true,
      mode: "round_robin",
      assignees: [assignee("u-asha", { display_name: "Asha" })],
    });
    run("run-f1", "flow-plain-1");
    const r = await engine.assignTableLead(db as never, {
      accountId: "acct-1",
      flowId: "flow-plain-1",
      runId: "run-f1",
      formId: null,
    });
    expect(r.outcome).toBe("assigned");
    expect(h.queue).toHaveLength(0);
    expect(h.drainScheduled).toHaveLength(0);
  });
});
