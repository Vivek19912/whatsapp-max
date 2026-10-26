// Per-table assignment notifications — outbox idempotency,
// email + WhatsApp delivery, failure accounting. Google Sheets and
// Travel CRM are never touched.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  notifications: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  whatsappConfigs: [] as Array<Record<string, unknown>>,
  templates: [] as Array<Record<string, unknown>>,
  sentEmails: [] as Array<Record<string, unknown>>,
  sentWhatsapp: [] as Array<Record<string, unknown>>,
  emailThrows: false,
  whatsappThrows: false,
  seq: 0,
}));

vi.mock("@/lib/email/send", () => ({
  sendEmailViaSmtp: async (input: Record<string, unknown>) => {
    if (h.emailThrows) throw new Error("smtp down");
    h.sentEmails.push(input);
    return { messageId: "smtp-1" };
  },
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTemplateMessage: async (input: Record<string, unknown>) => {
    if (h.whatsappThrows) throw new Error("meta timeout");
    h.sentWhatsapp.push(input);
    return { messageId: "wa-1" };
  },
}));

type Filter = { col: string; op: "eq" | "in"; lte?: boolean; val: unknown };

function tableRows(table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "lead_assignment_notifications": return h.notifications;
    case "lead_assignment_table_assignees": return h.assignees;
    case "profiles": return h.profiles;
    case "whatsapp_config": return h.whatsappConfigs;
    case "message_templates": return h.templates;
    default: return [];
  }
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    orderCol: null as string | null,
    limitN: null as number | null,
    insertRows: null as Array<Record<string, unknown>> | null,
    updateObj: null as Record<string, unknown> | null,
  };
  const matched = () =>
    tableRows(state.table).filter((r) =>
      state.filters.every((f) => {
        // Mirror Postgres: NULL never satisfies <= (terminal rows
        // with no next attempt are excluded from the due scan).
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
    order: (col: string) => {
      state.orderCol = col;
      return api;
    },
    limit: (n: number) => {
      state.limitN = n;
      return api;
    },
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
        const rows: Array<Record<string, unknown>> = state.insertRows;
        for (const row of rows) {
          const withId: Record<string, unknown> = { id: `row-${++h.seq}`, ...row };
          if (state.table === "lead_assignment_notifications") {
            const dup = h.notifications.find(
              (r) =>
                r.account_id === withId.account_id &&
                r.flow_run_id === withId.flow_run_id &&
                r.assignee_id === withId.assignee_id &&
                r.channel === withId.channel,
            );
            if (dup) return resolve({ data: null, error: { code: "23505", message: "dup" } });
          }
          tableRows(state.table).push({ ...withId });
        }
        return resolve({ data: rows, error: null });
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
      state.orderCol = null;
      state.limitN = null;
      state.insertRows = null;
      state.updateObj = null;
      return api;
    },
  };
}

import { encrypt } from "@/lib/whatsapp/encryption";
import {
  drainTableAssignmentNotifications,
  enqueueTableAssignmentNotifications,
} from "./table-notify";
import type {
  TableAssigneeRow,
  TableConfigDetail,
} from "./table-config";

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

function externalAssignee(extra: Partial<TableAssigneeRow> = {}): TableAssigneeRow {
  return {
    id: "assignee-ext",
    config_id: "config-1",
    user_id: null,
    display_name: "External Seller",
    email: "ext@example.com",
    phone: "+15551234567",
    position: 0,
    weight: 0,
    is_active: true,
    paused_until: null,
    pause_reason: null,
    pause_scope: "table",
    notify_email: true,
    notify_whatsapp: false,
    ...extra,
  };
}

beforeEach(() => {
  h.notifications = [];
  h.assignees = [];
  h.profiles = [
    { user_id: "u-asha", account_id: "acct-1", email: "asha@x.com", account_role: "agent" },
  ];
  h.whatsappConfigs = [];
  h.templates = [];
  h.sentEmails = [];
  h.sentWhatsapp = [];
  h.emailThrows = false;
  h.whatsappThrows = false;
  h.seq = 0;
  vi.stubEnv("SMTP_HOST", "smtp.example.com");
  vi.stubEnv("SMTP_USER", "bot@example.com");
  vi.stubEnv("SMTP_PASSWORD", "secret");
});

describe("enqueueTableAssignmentNotifications", () => {
  it("enqueues email for external recipients exactly once", async () => {
    const db = fakeSupabase();
    const first = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: externalAssignee(),
      runId: "run-1",
      formId: null,
    });
    expect(first.email).toMatchObject({ enqueued: true, reason: "enqueued" });
    const second = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: externalAssignee(),
      runId: "run-1",
      formId: null,
    });
    expect(second.email).toMatchObject({ enqueued: false, reason: "duplicate" });
    expect(h.notifications.filter((n) => n.channel === "email")).toHaveLength(1);
  });

  it("skips channels without recipients or config", async () => {
    const db = fakeSupabase();
    const emailOnly = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: { ...DETAIL, whatsapp_template_name: null },
      assignee: externalAssignee({ notify_email: false, notify_whatsapp: true }),
      runId: "run-1",
      formId: null,
    });
    // Email toggled off; WhatsApp requested but no phone issue here —
    // the phone exists, so a WhatsApp row is enqueued (template
    // presence is checked at send time, not enqueue time).
    expect(emailOnly.email).toMatchObject({ enqueued: false, reason: "skipped" });
    expect(emailOnly.whatsapp).toMatchObject({ enqueued: true, reason: "enqueued" });

    const noPhone = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: DETAIL,
      assignee: externalAssignee({ phone: null, notify_whatsapp: true }),
      runId: "run-2",
      formId: null,
    });
    expect(noPhone.whatsapp).toMatchObject({ enqueued: false, reason: "no-recipient" });
  });
});

describe("drainTableAssignmentNotifications", () => {
  function queued(row: Record<string, unknown>) {
    h.notifications.push({
      id: `n-${++h.seq}`,
      account_id: "acct-1",
      status: "queued",
      attempt: 0,
      max_attempts: 5,
      next_attempt_at: new Date(0).toISOString(),
      ...row,
    });
  }

  it("sends external emails and resolves internal roster email at send time", async () => {
    const db = fakeSupabase();
    h.assignees = [
      { id: "assignee-int", user_id: "u-asha" },
    ];
    queued({
      channel: "email",
      assignee_id: "assignee-int",
      to_email: "stale@example.com",
      flow_run_id: "run-1",
      subject: "Hi",
      body: "Hello",
    });
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    // Roster email wins over the stale snapshot.
    expect(h.sentEmails[0]).toMatchObject({ to: "asha@x.com", subject: "Hi" });
    expect(h.notifications[0].status).toBe("sent");
  });

  it("fails email rows terminally without a valid address, and retries transient SMTP errors", async () => {
    const db = fakeSupabase();
    queued({
      channel: "email",
      assignee_id: "assignee-missing",
      to_email: "not-an-email",
      flow_run_id: "run-1",
      subject: "Hi",
      body: "Hello",
    });
    const terminal = await drainTableAssignmentNotifications(db as never);
    expect(terminal).toMatchObject({ sent: 0, failed: 1 });
    expect(h.notifications[0].status).toBe("failed");

    queued({
      channel: "email",
      assignee_id: "assignee-missing",
      to_email: "ok@example.com",
      flow_run_id: "run-2",
      subject: "Hi",
      body: "Hello",
    });
    h.emailThrows = true;
    const retry = await drainTableAssignmentNotifications(db as never);
    expect(retry).toMatchObject({ sent: 0, failed: 1 });
    const row = h.notifications.find((n) => n.flow_run_id === "run-2")!;
    expect(row.status).toBe("failed");
    expect(row.failed_at).toBeNull();
    expect(Date.parse(row.next_attempt_at as string)).toBeGreaterThan(Date.now());
  });

  it("sends WhatsApp via the account sender and an approved template", async () => {
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "x");
    const db = fakeSupabase();
    h.whatsappConfigs = [
      {
        account_id: "acct-1",
        access_token: encrypt("token-1"),
        phone_number_id: "pn-1",
      },
    ];
    h.templates = [
      { account_id: "acct-1", name: "new_lead_assigned", language: "en_US", status: "APPROVED" },
    ];
    queued({
      channel: "whatsapp",
      assignee_id: "assignee-ext",
      to_phone: "+15551234567",
      flow_run_id: "run-1",
      template_name: "new_lead_assigned",
      template_language: "en_US",
      lead_name: "Asha",
    });
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(h.sentWhatsapp[0]).toMatchObject({
      phoneNumberId: "pn-1",
      // sanitizePhoneForMeta strips the leading + (same as lead sends).
      to: "15551234567",
      templateName: "new_lead_assigned",
      params: ["Asha"],
    });
  });

  it("skips WhatsApp without sender config or with unapproved templates", async () => {
    const db = fakeSupabase();
    queued({
      channel: "whatsapp",
      assignee_id: "assignee-ext",
      to_phone: "+15551234567",
      flow_run_id: "run-1",
      template_name: "new_lead_assigned",
      template_language: "en_US",
    });
    const noSender = await drainTableAssignmentNotifications(db as never);
    expect(noSender).toMatchObject({ sent: 0, failed: 1 });
    expect(h.sentWhatsapp).toHaveLength(0);

    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      { account_id: "acct-1", name: "new_lead_assigned", language: "en_US", status: "PENDING" },
    ];
    // Simulate the backoff elapsing before the next sweep.
    for (const n of h.notifications) {
      n.next_attempt_at = new Date(0).toISOString();
      n.status = "failed";
    }
    const unapproved = await drainTableAssignmentNotifications(db as never);
    expect(unapproved).toMatchObject({ sent: 0, failed: 1 });
    expect(h.sentWhatsapp).toHaveLength(0);
    // Terminal: no point retrying an unapproved template.
    const row = h.notifications.find((n) => n.flow_run_id === "run-1")!;
    expect(row.failed_at).not.toBeNull();
    expect(row.next_attempt_at).toBeNull();
  });
});
