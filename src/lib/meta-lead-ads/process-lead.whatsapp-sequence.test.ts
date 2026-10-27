// Ingestion → salesperson vs. global WhatsApp sequence exclusivity.
//
// Pins the required interaction: when ingestion assigns a lead, the
// assignee's own customer-facing sequence is the EXCLUSIVE sequence —
// the table-wide global auto-send must not also enqueue (it would
// race, reorder, or partially duplicate: disjoint names send BOTH
// sequences, overlapping names collide on the UNIQUE(account,
// submission, template, language) ledger with the wrong schedule).
// An assigned salesperson with no configured sequence sends nothing
// (no global fallback). Leads that stay unassigned keep the existing
// global behavior unchanged.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processSubmissionById } from "./process-lead";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
}));

vi.mock("./graph-client", () => ({
  getLead: async () => ({
    id: "L1",
    platform: "facebook",
    field_data: [],
    created_time: "2026-10-20T10:00:00+00:00",
  }),
}));

vi.mock("@/lib/meta-capi/triggers", () => ({
  onMetaLeadReceived: async () => {},
}));

vi.mock("@/lib/api/v1/contacts", () => ({
  resolveAuditUserId: async () => "owner-1",
}));

vi.mock("./store", () => ({
  getPageToken: async () => "page-token",
  markNeedsReauth: async () => {},
}));

vi.mock("./virtual-flow", () => ({
  ensureVirtualFlow: async () => "flow-1",
  META_SOURCE_COLUMN_KEY: "meta_lead_source",
  parseFormQuestions: (raw: unknown) => (Array.isArray(raw) ? raw : []),
}));

function makeDb() {
  function builder(table: string) {
    let op: "select" | "update" | "insert" | "delete" = "select";
    let payload: Row = {};
    const filters: Array<[string, unknown, string]> = [];
    let inFilter: { col: string; vals: unknown[] } | null = null;

    const matched = () =>
      (h.tables[table] ?? []).filter(
        (r) =>
          filters.every(([c, v, kind]) =>
            kind === "neq"
              ? r[c as string] !== v
              : kind === "is-null"
                ? r[c as string] == null
                : r[c as string] === v,
          ) &&
          (!inFilter || (inFilter.vals as unknown[]).includes(r[inFilter.col])),
      );

    const apply = () => {
      if (op === "insert") {
        h.seq += 1;
        const defaults =
          table === "lead_assignment_table_state" ||
          table === "lead_assignment_table_config_state"
            ? { rr_cursor: 0, current_weights: {}, version: 0 }
            : table === "meta_lead_whatsapp_queue"
              // Mirror the production column defaults (migration
              // 133): status 'pending', attempts 0, max_attempts 8.
              // Without these the fake's rows carry undefined status
              // and conditional queue ops (claim/cancel filters) match
              // nothing — unlike production.
              ? { status: "pending", attempts: 0, max_attempts: 8 }
              : {};
        const row: Row = { id: `row-${h.seq}`, ...defaults, ...payload };
        (h.tables[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (op === "update") {
        const rows = matched();
        for (const row of rows) Object.assign(row, payload);
        return { data: rows, error: null };
      }
      if (op === "delete") {
        const rows = matched();
        h.tables[table] = (h.tables[table] ?? []).filter((r) => !rows.includes(r));
        return { data: rows, error: null };
      }
      return { data: matched(), error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Row) => {
        op = "update";
        payload = p;
        return b;
      },
      insert: (p: Row) => {
        op = "insert";
        payload = p;
        return b;
      },
      delete: () => {
        op = "delete";
        return b;
      },
      eq: (c: string, v: unknown) => {
        filters.push([c, v, "eq"] as never);
        return b;
      },
      neq: (c: string, v: unknown) => {
        filters.push([c, v, "neq"] as never);
        return b;
      },
      in: (c: string, vals: unknown[]) => {
        inFilter = { col: c, vals };
        return b;
      },
      or: () => b,
      is: (c: string, v: unknown) => {
        filters.push([c, v, v === null ? "is-null" : "eq"] as never);
        return b;
      },
      not: () => b,
      lte: () => b,
      gte: () => b,
      lt: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        const r = apply();
        const data = r.data as Row | Row[] | null;
        return { data: (Array.isArray(data) ? data[0] : data) ?? null, error: null };
      },
      single: async () => {
        const r = apply();
        const data = r.data as Row | Row[] | null;
        return { data: (Array.isArray(data) ? data[0] : data) ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(apply()).then(res, rej),
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const CONFIG = {
  appId: "1",
  appSecret: "s",
  webhookVerifyToken: "v",
  graphVersion: "v26.0",
  apiVersion: "v26.0",
} as never;

// The WhatsApp outbox keys rows by the submission's Meta form id
// ("F1"); the legacy assignment rules key by the form db id
// ("form-1") via formRow.id — mirroring production.
function seed(opts: { withRules: boolean }) {
  h.tables = {
    meta_lead_submissions: [
      {
        id: "sub-1",
        account_id: "acct-1",
        meta_lead_id: "L1",
        page_id: "P1",
        form_id: "F1",
        form_name: "Hiring",
        status: "received",
        attempts: 0,
        claimed_at: null,
      },
    ],
    meta_lead_connections: [],
    meta_lead_forms: [
      {
        id: "form-1",
        account_id: "acct-1",
        form_id: "F1",
        form_name: "Hiring",
        enabled: true,
        questions: [],
      },
    ],
    meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    flow_runs: [],
    workspace_fields: [
      { id: "f-assign", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To" },
    ],
    workspace_values: [],
    profiles: [
      { user_id: "u-mohan", account_id: "acct-1", account_role: "agent" },
      { user_id: "u-sohan", account_id: "acct-1", account_role: "agent" },
    ],
    lead_assignment_rules: opts.withRules
      ? [
          {
            id: "rule-1",
            account_id: "acct-1",
            name: "Video",
            scope: "specific",
            mode: "round_robin",
            status: "active",
            created_by: "admin-1",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]
      : [],
    lead_assignment_rule_tables: opts.withRules
      ? [{ rule_id: "rule-1", form_id: "form-1" }]
      : [],
    lead_assignment_rule_members: opts.withRules
      ? [
          { rule_id: "rule-1", user_id: "u-mohan", position: 0, weight: 0 },
          { rule_id: "rule-1", user_id: "u-sohan", position: 1, weight: 0 },
        ]
      : [],
    lead_assignment_table_state: [],
    lead_assignment_events: [],
    whatsapp_config: [],
    meta_lead_whatsapp_configs: [],
    meta_lead_whatsapp_templates: [],
    meta_lead_assignee_sequences: [],
    meta_lead_assignee_sequence_items: [],
    meta_lead_whatsapp_queue: [],
    flows: [],
    lead_assignment_table_configs: [],
    lead_assignment_table_assignees: [],
    lead_assignment_table_config_state: [],
    lead_assignment_notifications: [],
  };
  h.seq = 0;
}

// Per-table assignment config with a single external (email-keyed)
// assignee — mirrors the production table-config rows.
function seedExternalTableConfig() {
  h.tables.flows!.push({
    id: "flow-1",
    account_id: "acct-1",
    kind: "meta_lead_ads",
    meta_form_id: "form-1",
  });
  h.tables.lead_assignment_table_configs!.push({
    id: "cfg-1",
    account_id: "acct-1",
    flow_id: "flow-1",
    enabled: true,
    mode: "round_robin",
    timezone: "Asia/Kolkata",
    whatsapp_template_name: null,
    whatsapp_template_language: "en_US",
  });
  h.tables.lead_assignment_table_assignees!.push({
    id: "a-ext",
    config_id: "cfg-1",
    user_id: null,
    display_name: "Ext Partner",
    email: "Ext@Example.com",
    phone: "+15550001111",
    position: 0,
    weight: 1,
    is_active: true,
    paused_until: null,
    pause_reason: null,
    pause_scope: "table",
    notify_email: false,
    notify_whatsapp: true,
  });
}

function seedGlobal(templates: Array<{ name: string; position: number }>, delaySeconds = 3600) {
  h.tables.meta_lead_whatsapp_configs!.push({
    id: "cfg-1",
    account_id: "acct-1",
    form_id: "F1",
    paused: false,
    delay_seconds: delaySeconds,
  });
  for (const t of templates) {
    h.tables.meta_lead_whatsapp_templates!.push({
      id: `gt-${t.name}`,
      account_id: "acct-1",
      form_id: "F1",
      template_name: t.name,
      template_language: "en_US",
      position: t.position,
      variable_mappings: {},
    });
  }
}

function seedAssignee(
  key: string,
  templates: Array<{ name: string; position: number }>,
  delaySeconds = 60,
) {
  h.tables.meta_lead_assignee_sequences!.push({
    id: "seq-1",
    account_id: "acct-1",
    form_id: "F1",
    salesperson_key: key,
    delay_seconds: delaySeconds,
  });
  for (const t of templates) {
    h.tables.meta_lead_assignee_sequence_items!.push({
      id: `si-${t.name}`,
      sequence_id: "seq-1",
      template_name: t.name,
      template_language: "en_US",
      position: t.position,
      variable_mappings: {},
    });
  }
}

const queue = () => (h.tables.meta_lead_whatsapp_queue ?? []) as Row[];

beforeEach(() => seed({ withRules: true }));

describe("ingestion → salesperson vs global sequence exclusivity", () => {
  it("an assigned lead enqueues ONLY the salesperson sequence (global suppressed)", async () => {
    seedGlobal([{ name: "global_hello", position: 0 }]);
    seedAssignee("user:u-mohan", [
      { name: "sp_hi", position: 0 },
      { name: "sp_offer", position: 1 },
    ]);
    const res = await processSubmissionById(makeDb(), CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");
    // The lead was assigned to the first rule member.
    expect(h.tables.workspace_values).toHaveLength(1);
    expect(h.tables.workspace_values[0]).toMatchObject({ value_text: "u-mohan" });
    // Only the salesperson's two rows exist — no global row.
    expect(queue()).toHaveLength(2);
    for (const row of queue()) expect(row.assignee_key).toBe("user:u-mohan");
    expect(queue().some((r) => r.assignee_key == null)).toBe(false);
    expect(queue().some((r) => r.template_name === "global_hello")).toBe(false);
    // Order + per-salesperson delay preserved (60s stagger, not 3600s).
    const byName = Object.fromEntries(queue().map((r) => [r.template_name, r]));
    expect(byName.sp_hi.position).toBe(0);
    expect(byName.sp_offer.position).toBe(1);
    expect(
      Date.parse(byName.sp_offer.scheduled_for as string) -
        Date.parse(byName.sp_hi.scheduled_for as string),
    ).toBe(60_000);
  });

  it("overlapping template names resolve to the salesperson row with salesperson timing", async () => {
    seedGlobal([{ name: "shared_tpl", position: 0 }], 3600);
    seedAssignee(
      "user:u-mohan",
      [
        { name: "shared_tpl", position: 0 },
        { name: "sp_only", position: 1 },
      ],
      60,
    );
    const before = Date.now();
    const res = await processSubmissionById(makeDb(), CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");
    // Exactly one row per template — the shared name belongs to the
    // salesperson's sequence, never duplicated by the global one.
    expect(queue()).toHaveLength(2);
    const shared = queue().filter((r) => r.template_name === "shared_tpl");
    expect(shared).toHaveLength(1);
    expect(shared[0].assignee_key).toBe("user:u-mohan");
    // Salesperson timing (delay 60s), not the global 3600s schedule.
    const byName = Object.fromEntries(queue().map((r) => [r.template_name, r]));
    expect(
      Date.parse(byName.sp_only.scheduled_for as string) -
        Date.parse(byName.shared_tpl.scheduled_for as string),
    ).toBe(60_000);
    expect(
      Date.parse(shared[0].scheduled_for as string) - before,
    ).toBeLessThan(3_600_000);
  });

  it("an assigned salesperson with no configured sequence sends no customer templates", async () => {
    seedGlobal([{ name: "global_hello", position: 0 }]);
    const res = await processSubmissionById(makeDb(), CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");
    expect(h.tables.workspace_values).toHaveLength(1);
    // Notifications may still fire, but no customer-facing rows.
    expect(queue()).toHaveLength(0);
  });

  it("a lead that stays unassigned keeps the existing global behavior", async () => {
    seed({ withRules: false });
    seedGlobal([{ name: "global_hello", position: 0 }]);
    const res = await processSubmissionById(makeDb(), CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");
    expect(h.tables.workspace_values).toHaveLength(0);
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({ template_name: "global_hello" });
    // Global rows carry no salesperson discriminator.
    expect(queue()[0].assignee_key ?? null).toBeNull();
  });

  it("an externally assigned lead (assigned-external) uses the email-keyed sequence, not the global one", async () => {
    seed({ withRules: false });
    seedExternalTableConfig();
    seedGlobal([{ name: "global_hello", position: 0 }]);
    seedAssignee("email:ext@example.com", [{ name: "ext_hi", position: 0 }]);
    const res = await processSubmissionById(makeDb(), CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");
    // External recipients never take the ownership cell…
    expect(h.tables.workspace_values).toHaveLength(0);
    expect(h.tables.lead_assignment_events).toHaveLength(1);
    expect(h.tables.lead_assignment_events![0]).toMatchObject({
      kind: "auto",
      reason: "external-notification",
    });
    // …but their email-keyed sequence is the exclusive customer
    // sequence: no global fallback.
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({
      template_name: "ext_hi",
      assignee_key: "email:ext@example.com",
    });
  });
});

describe("ingestion ↔ manual-assignment interleavings (deterministic)", () => {
  // Simulates a manual assignment landing inside ingestion: writes the
  // same persisted state the manual route writes (ownership cell +
  // assignment event) and starts the salesperson sequence through the
  // real assignee enqueue (which the handoff/route would call).
  async function simulateManualAssign(userId: string, assigneeKey: string) {
    const runId = (h.tables.flow_runs[0] as Row).id as string;
    h.tables.workspace_values!.push({
      id: "wv-manual",
      account_id: "acct-1",
      field_id: "f-assign",
      flow_run_id: runId,
      value_text: userId,
    });
    h.tables.lead_assignment_events!.push({
      id: "ev-manual",
      account_id: "acct-1",
      flow_run_id: runId,
      kind: "manual",
      assigned_user_id: userId,
      previous_user_id: null,
      reason: null,
      created_by: "admin-1",
    });
    const { maybeEnqueueAssigneeSequence } = await import(
      "@/lib/meta-lead-whatsapp/queue"
    );
    return maybeEnqueueAssigneeSequence(makeDb() as never, {
      accountId: "acct-1",
      formId: "F1",
      submissionId: "sub-1",
      assigneeKey,
    });
  }

  it("manual assignment winning before global enqueue prevents any later global rows", async () => {
    seed({ withRules: false });
    seedGlobal([{ name: "global_hello", position: 0 }]);
    seedAssignee("user:u-sohan", [{ name: "sp_hi", position: 0 }]);
    // Ingestion decides "unassigned", pauses, then a manual assignment
    // fully completes (persisted state + salesperson rows) first.
    const hooks = {
      beforeGlobalSequenceDecision: async () => {
        const queued = await simulateManualAssign("u-sohan", "user:u-sohan");
        expect(queued.enqueued).toBe(1);
      },
    };
    const res = await processSubmissionById(makeDb(), CONFIG, "sub-1", { hooks });
    expect(res.outcome).toBe("processed");
    // Only the salesperson sequence exists — ingestion added nothing.
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({
      template_name: "sp_hi",
      assignee_key: "user:u-sohan",
    });
  });

  it("a manual assignment landing after global enqueue is compensated (pending globals removed)", async () => {
    seed({ withRules: false });
    seedGlobal([
      { name: "global_hello", position: 0 },
      { name: "global_offer", position: 1 },
    ]);
    seedAssignee("user:u-sohan", [{ name: "sp_hi", position: 0 }]);
    // First checkpoint: no assignment yet, globals enqueue. Second
    // checkpoint (post-enqueue): the manual assignment has landed.
    let calls = 0;
    const hooks = {
      beforeGlobalSequenceDecision: async () => {
        calls += 1;
        if (calls === 2) {
          await simulateManualAssign("u-sohan", "user:u-sohan");
        }
      },
    };
    const res = await processSubmissionById(makeDb(), CONFIG, "sub-1", { hooks });
    expect(res.outcome).toBe("processed");
    expect(calls).toBe(2);
    // The just-enqueued global rows were reconciled away; only the
    // salesperson sequence remains, with order intact.
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({
      template_name: "sp_hi",
      assignee_key: "user:u-sohan",
    });
  });

  it("duplicate ingestion deliveries cannot enqueue both sequences", async () => {
    seed({ withRules: false });
    seedGlobal([{ name: "global_hello", position: 0 }]);
    const db = makeDb();
    expect((await processSubmissionById(db, CONFIG, "sub-1")).outcome).toBe("processed");
    expect((await processSubmissionById(db, CONFIG, "sub-1")).outcome).toBe("skipped");
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({ template_name: "global_hello" });
  });
});
