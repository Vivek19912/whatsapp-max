// Regression: every registered WhatsApp number of the assigned
// assignee receives the lead-assignment notification — the legacy
// `phone` column is never dropped when `whatsapp_numbers` exist.
// Assignment ownership and distribution are untouched: one assignee
// stays one assignee (same assignee_id on every row).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  notifications: [] as Array<Record<string, unknown>>,
  sentWhatsapp: [] as Array<Record<string, unknown>>,
  whatsappErrorFor: null as string | null,
  whatsappConfigs: [] as Array<Record<string, unknown>>,
  templates: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  seq: 0,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTemplateMessage: async (input: Record<string, unknown>) => {
    if (h.whatsappErrorFor && (input as { to?: string }).to === h.whatsappErrorFor) {
      throw new Error("meta timeout for this recipient");
    }
    h.sentWhatsapp.push(input);
    return { messageId: `wa-${h.sentWhatsapp.length}` };
  },
}));

type Filter = { col: string; op: "eq" | "in"; lte?: boolean; val: unknown };

function tableRows(table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "lead_assignment_notifications": return h.notifications;
    case "whatsapp_config": return h.whatsappConfigs;
    case "message_templates": return h.templates;
    case "flow_runs": return h.runs;
    default: return [];
  }
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    insertRows: null as Array<Record<string, unknown>> | null,
    updateObj: null as Record<string, unknown> | null,
  };
  const matched = () =>
    tableRows(state.table).filter((r) =>
      state.filters.every((f) => {
        if (f.lte) return r[f.col] != null && String(r[f.col]) <= String(f.val);
        return f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]);
      }),
    );
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
    lte: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", lte: true, val });
      return api;
    },
    order: () => api,
    limit: () => api,
    insert: (obj: Record<string, unknown>) => {
      state.insertRows = [obj];
      return api;
    },
    update: (obj: Record<string, unknown>) => {
      state.updateObj = obj;
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
    single: async () => ({ data: matched()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      if (state.insertRows) {
        for (const row of state.insertRows) {
          const withId: Record<string, unknown> = { id: `row-${++h.seq}`, ...row };
          if (state.table === "lead_assignment_notifications") {
            const dup = h.notifications.find(
              (r) =>
                r.account_id === withId.account_id &&
                r.flow_run_id === withId.flow_run_id &&
                r.assignee_id === withId.assignee_id &&
                r.channel === withId.channel &&
                (r.recipient_key ?? "") === (withId.recipient_key ?? ""),
            );
            if (dup) return resolve({ data: null, error: { code: "23505", message: "dup" } });
          }
          tableRows(state.table).push({ ...withId });
        }
        return resolve({ data: state.insertRows, error: null });
      }
      if (state.updateObj) {
        const list = matched();
        for (const row of list) Object.assign(row, state.updateObj);
        return resolve({ data: list, error: null });
      }
      return resolve({ data: matched(), error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.insertRows = null;
      state.updateObj = null;
      return api;
    },
  };
}

import { encrypt } from "@/lib/whatsapp/encryption";
import {
  buildAssignmentBodyParams,
  drainTableAssignmentNotifications,
  enqueueTableAssignmentNotifications,
} from "./table-notify";
import type { TableAssigneeRow, TableConfigDetail } from "./table-config";

const DETAIL: TableConfigDetail = {
  id: "config-1",
  account_id: "acct-1",
  flow_id: "flow-1",
  kind: "whatsapp_flow",
  form_db_id: null,
  enabled: true,
  mode: "round_robin",
  timezone: "UTC",
  whatsapp_template_name: "new_lead_assigned",
  whatsapp_template_language: "en_US",
  assignees: [],
};

function assignee(extra: Partial<TableAssigneeRow> = {}): TableAssigneeRow {
  return {
    id: "assignee-1",
    config_id: "config-1",
    user_id: "u-1",
    display_name: "Seller One",
    email: null,
    phone: null,
    whatsapp_numbers: [],
    position: 0,
    weight: 50,
    is_active: true,
    paused_until: null,
    pause_reason: null,
    pause_scope: "table",
    notify_email: false,
    notify_whatsapp: true,
    ...extra,
  };
}

function seedSender() {
  h.whatsappConfigs = [
    { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
  ];
  h.templates = [
    {
      account_id: "acct-1",
      name: "new_lead_assigned",
      language: "en_US",
      status: "APPROVED",
      body_text: "Hi {{1}}, a new lead was assigned to you.",
    },
  ];
  h.runs = [{ id: "run-1", account_id: "acct-1", flow_id: "flow-1" }];
}

function markQueuedDefaults() {
  for (const n of h.notifications) {
    if (n.status == null) n.status = "queued";
    if (typeof n.attempt !== "number") n.attempt = 0;
    if (n.next_attempt_at == null) n.next_attempt_at = new Date(0).toISOString();
  }
}

beforeEach(() => {
  h.notifications = [];
  h.sentWhatsapp = [];
  h.whatsappErrorFor = null;
  h.whatsappConfigs = [];
  h.templates = [];
  h.runs = [];
  h.seq = 0;
});

describe("multi-recipient assignment notifications", () => {
  it("1. one assignee with two numbers (legacy + extra) gets two notification rows and two sends", async () => {
    const db = fakeSupabase();
    seedSender();
    const out = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({
        phone: "+917006894931",
        whatsapp_numbers: [
          { phone: "+918825069554", template_name: null, template_language: "en_US" },
        ],
      }),
      runId: "run-1",
      formId: null,
    });
    expect(out.whatsapp).toMatchObject({ enqueued: true, reason: "enqueued" });
    expect(out.whatsapp.recipients?.map((r) => r.phone).sort()).toEqual(
      ["+917006894931", "+918825069554"].sort(),
    );
    markQueuedDefaults();
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 2, failed: 0 });
    expect(h.sentWhatsapp.map((s) => (s as { to: string }).to).sort()).toEqual(
      ["917006894931", "918825069554"].sort(),
    );
  });

  it("2. one assignee with one number gets exactly one notification", async () => {
    const db = fakeSupabase();
    const out = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({ phone: "+917006894931" }),
      runId: "run-1",
      formId: null,
    });
    expect(out.whatsapp.recipients).toHaveLength(1);
    expect(h.notifications.filter((n) => n.channel === "whatsapp")).toHaveLength(1);
  });

  it("3. duplicate normalized numbers receive only one notification", async () => {
    const db = fakeSupabase();
    const out = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({
        phone: "+918825069554",
        whatsapp_numbers: [
          { phone: "918825069554", template_name: null, template_language: "en_US" },
          { phone: "+91 88250 69554", template_name: null, template_language: "en_US" },
        ],
      }),
      runId: "run-1",
      formId: null,
    });
    expect(out.whatsapp.recipients).toHaveLength(1);
    expect(h.notifications.filter((n) => n.channel === "whatsapp")).toHaveLength(1);
  });

  it("4. invalid numbers are skipped without blocking valid recipients", async () => {
    const db = fakeSupabase();
    seedSender();
    const out = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({
        phone: "+917006894931",
        whatsapp_numbers: [
          { phone: "   ", template_name: null, template_language: "en_US" },
          { phone: "not-a-number", template_name: null, template_language: "en_US" },
          { phone: "+918825069554", template_name: null, template_language: "en_US" },
        ],
      }),
      runId: "run-1",
      formId: null,
    });
    // Blank skipped at build; the two real numbers both enqueue.
    expect(out.whatsapp).toMatchObject({ enqueued: true });
    markQueuedDefaults();
    const result = await drainTableAssignmentNotifications(db as never);
    const byPhone = new Map(h.notifications.map((n) => [n.to_phone as string, n]));
    expect(byPhone.get("+917006894931")?.status).toBe("sent");
    expect(byPhone.get("+918825069554")?.status).toBe("sent");
    expect(result.sent).toBe(2);
  });

  it("5. failure of the first recipient does not prevent sending to the second", async () => {
    const db = fakeSupabase();
    seedSender();
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({
        phone: "+917006894931",
        whatsapp_numbers: [
          { phone: "+918825069554", template_name: null, template_language: "en_US" },
        ],
      }),
      runId: "run-1",
      formId: null,
    });
    markQueuedDefaults();
    h.whatsappErrorFor = "917006894931";
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(h.sentWhatsapp).toHaveLength(1);
    expect((h.sentWhatsapp[0] as { to: string }).to).toBe("918825069554");
  });

  it("6. each recipient has an independent delivery result", async () => {
    const db = fakeSupabase();
    seedSender();
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({
        phone: "+917006894931",
        whatsapp_numbers: [
          { phone: "+918825069554", template_name: null, template_language: "en_US" },
        ],
      }),
      runId: "run-1",
      formId: null,
    });
    markQueuedDefaults();
    h.whatsappErrorFor = "917006894931";
    await drainTableAssignmentNotifications(db as never);
    const byPhone = new Map(h.notifications.map((n) => [n.to_phone as string, n]));
    expect(byPhone.get("+917006894931")?.status).toBe("failed");
    expect(byPhone.get("+918825069554")?.status).toBe("sent");
    expect(byPhone.get("+918825069554")?.sent_at).not.toBeNull();
  });

  it("7. WhatsApp notifications disabled means no notifications are sent", async () => {
    const db = fakeSupabase();
    const out = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({ phone: "+917006894931", notify_whatsapp: false }),
      runId: "run-1",
      formId: null,
    });
    expect(out.whatsapp).toMatchObject({ enqueued: false, reason: "skipped" });
    expect(h.notifications.filter((n) => n.channel === "whatsapp")).toHaveLength(0);
  });

  it("8. an unapproved template means no notification is sent (row fails, never marked sent)", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      { account_id: "acct-1", name: "new_lead_assigned", language: "en_US", status: "PENDING" },
    ];
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({ phone: "+917006894931" }),
      runId: "run-1",
      formId: null,
    });
    markQueuedDefaults();
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(h.sentWhatsapp).toHaveLength(0);
    expect(h.notifications[0].status).toBe("failed");
  });

  it("9. template variable validation remains unchanged ({{3}} rejected, {{1}}/{{2}} mapped)", async () => {
    expect(
      buildAssignmentBodyParams(
        { body_text: "Lead {{1}} phone {{2}}" },
        "t",
        "en_US",
        "Ravi",
        "+911234567890",
      ),
    ).toEqual(["Ravi", "+911234567890"]);
    expect(() =>
      buildAssignmentBodyParams({ body_text: "A {{1}} B {{2}} C {{3}}" }, "t", "en_US", "R", "+911234567890"),
    ).toThrow(/cannot be sent/);
  });

  it("10. one assignee stays one assignee: same assignee_id on every row, ownership untouched", async () => {
    const db = fakeSupabase();
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({
        phone: "+917006894931",
        weight: 70,
        whatsapp_numbers: [
          { phone: "+918825069554", template_name: null, template_language: "en_US" },
        ],
      }),
      runId: "run-1",
      formId: null,
    });
    const rows = h.notifications.filter((n) => n.channel === "whatsapp");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((n) => n.assignee_id as string)).size).toBe(1);
    expect(rows[0].assignee_id).toBe("assignee-1");
  });

  it("11. one assignee's notifications never go to unrelated assignees", async () => {
    const db = fakeSupabase();
    const other = assignee({
      id: "assignee-2",
      display_name: "Seller Two",
      phone: "+919999999999",
    });
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({
        phone: "+917006894931",
        whatsapp_numbers: [
          { phone: "+918825069554", template_name: null, template_language: "en_US" },
        ],
      }),
      runId: "run-1",
      formId: null,
    });
    const phones = h.notifications
      .filter((n) => n.channel === "whatsapp")
      .map((n) => n.to_phone);
    expect(phones).not.toContain("+919999999999");
    expect(other.phone).toBe("+919999999999");
  });

  it("12. workspace isolation: rows carry only the assignee's own account/config", async () => {
    const db = fakeSupabase();
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: assignee({ phone: "+917006894931" }),
      runId: "run-1",
      formId: null,
    });
    for (const n of h.notifications) {
      expect(n.account_id).toBe("acct-1");
      expect(n.config_id).toBe("config-1");
    }
    expect(h.notifications.some((n) => n.account_id === "acct-other")).toBe(false);
  });
});
