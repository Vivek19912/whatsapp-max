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
  runs: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<Record<string, unknown>>,
  forms: [] as Array<Record<string, unknown>>,
  sentEmails: [] as Array<Record<string, unknown>>,
  sentWhatsapp: [] as Array<Record<string, unknown>>,
  emailThrows: false,
  whatsappThrows: false,
  whatsappError: null as string | null,
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
    if (h.whatsappError) throw new Error(h.whatsappError);
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
    case "flow_runs": return h.runs;
    case "contacts": return h.contacts;
    case "meta_lead_forms": return h.forms;
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
  buildAssignmentBodyParams,
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
  h.runs = [];
  h.contacts = [];
  h.forms = [];
  h.sentEmails = [];
  h.sentWhatsapp = [];
  h.emailThrows = false;
  h.whatsappThrows = false;
  h.whatsappError = null;
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

describe("lead snapshot resolution at enqueue time", () => {
  const META_DETAIL: TableConfigDetail = {
    ...DETAIL,
    flow_id: "flow-meta",
    kind: "meta_lead_ads",
    form_db_id: "formdb-1",
  };

  function internalAssignee(extra: Partial<TableAssigneeRow> = {}): TableAssigneeRow {
    return {
      id: "assignee-int",
      config_id: "config-1",
      user_id: "u-asha",
      display_name: "Asha",
      email: null,
      phone: "+15550001111",
      position: 0,
      weight: 0,
      is_active: true,
      paused_until: null,
      pause_reason: null,
      pause_scope: "table",
      notify_email: true,
      notify_whatsapp: true,
      ...extra,
    };
  }

  function seedRun(args: {
    vars?: Record<string, unknown>;
    contact_id?: string | null;
    started_at?: string;
  }) {
    h.runs = [
      {
        id: "run-9",
        account_id: "acct-1",
        flow_id: "flow-meta",
        started_at: args.started_at ?? "2026-10-27T19:28:40+00:00",
        contact_id: args.contact_id ?? null,
        vars: args.vars ?? {},
      },
    ];
    h.forms = [{ id: "formdb-1", account_id: "acct-1", form_name: "Hiring Video Editor" }];
  }

  it("snapshots the lead's real name and phone from run answers when no contact is linked", async () => {
    // Production regression: the snapshot read only the contacts
    // row, so unlinked leads produced blank emails ("Name: —") and
    // failed the {{2}} WhatsApp variable — even though the
    // Workspace table shows real Name and Phone Number columns.
    const db = fakeSupabase();
    seedRun({
      contact_id: null,
      vars: { full_name: "Mukesh", phone_number: "+919876543210" },
    });
    const out = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: META_DETAIL,
      assignee: internalAssignee(),
      runId: "run-9",
      formId: "formdb-1",
    });
    expect(out.email).toMatchObject({ enqueued: true, reason: "enqueued" });
    expect(out.whatsapp).toMatchObject({ enqueued: true, reason: "enqueued" });
    const email = h.notifications.find((n) => n.channel === "email")!;
    expect(email.lead_name).toBe("Mukesh");
    expect(email.lead_phone).toBe("+919876543210");
    const whatsapp = h.notifications.find((n) => n.channel === "whatsapp")!;
    expect(whatsapp.lead_name).toBe("Mukesh");
    expect(whatsapp.lead_phone).toBe("+919876543210");
  });

  it("prefers the contact row and fills gaps from answers", async () => {
    const db = fakeSupabase();
    h.contacts = [{ id: "c-1", account_id: "acct-1", name: "", phone: "+15550001111", email: null }];
    seedRun({
      contact_id: "c-1",
      vars: { full_name: "Mukesh", city: "Goa" },
    });
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: META_DETAIL,
      assignee: internalAssignee(),
      runId: "run-9",
      formId: "formdb-1",
    });
    const email = h.notifications.find((n) => n.channel === "email")!;
    // Blank contact fields never overwrite real answer values.
    expect(email.lead_name).toBe("Mukesh");
    expect(email.lead_phone).toBe("+15550001111");
  });

  it("resolves table name and received timestamp from the actual records", async () => {
    const db = fakeSupabase();
    seedRun({ vars: { full_name: "Mukesh", phone_number: "+919876543210" } });
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: META_DETAIL,
      assignee: internalAssignee(),
      runId: "run-9",
      formId: "formdb-1",
    });
    const email = h.notifications.find((n) => n.channel === "email")!;
    expect(email.subject).toBe("New lead assigned: Mukesh");
    expect(email.body).toContain("Name: Mukesh");
    expect(email.body).toContain("Phone: +919876543210");
    expect(email.body).toContain("Table: Hiring Video Editor");
    expect(email.body).toContain("Received: 2026-10-27T19:28:40+00:00");
  });

  it("leaves genuinely missing values blank instead of substituting", async () => {
    const db = fakeSupabase();
    seedRun({ vars: {} });
    await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: META_DETAIL,
      assignee: internalAssignee(),
      runId: "run-9",
      formId: "formdb-1",
    });
    const email = h.notifications.find((n) => n.channel === "email")!;
    expect(email.lead_name).toBeNull();
    expect(email.lead_phone).toBeNull();
    expect(email.subject).toBe("New lead assigned: a new lead");
    expect(email.body).toContain("Name: —");
    // No other lead's data leaks in.
    expect(JSON.stringify(h.notifications)).not.toContain("Mukesh");
  });

  it("sends both channels end to end from an answers-only lead", async () => {
    // The fixed production flow in one test: enqueue snapshots the
    // real values from the run answers (no contact linked), the
    // drain then sends an email with real details AND a WhatsApp
    // template with exactly two BODY params — no #132000, no blanks.
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      {
        account_id: "acct-1",
        name: "new_lead_notification",
        language: "en_US",
        status: "APPROVED",
        body_text: "New lead assigned to you. Lead Name: {{1}} Phone Number: {{2}}",
      },
    ];
    seedRun({ vars: { full_name: "Mukesh", phone_number: "+919876543210" } });
    const out = await enqueueTableAssignmentNotifications(db as never, {
      accountId: "acct-1",
      detail: {
        ...META_DETAIL,
        whatsapp_template_name: "new_lead_notification",
        whatsapp_template_language: "en_US",
      },
      assignee: internalAssignee({ email: "aman@example.com" }),
      runId: "run-9",
      formId: "formdb-1",
    });
    expect(out.email).toMatchObject({ enqueued: true, reason: "enqueued" });
    expect(out.whatsapp).toMatchObject({ enqueued: true, reason: "enqueued" });
    // Mirror the real DB column defaults the mock does not apply.
    for (const n of h.notifications) {
      if (n.status == null) n.status = "queued";
      if (typeof n.attempt !== "number") n.attempt = 0;
    }
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 2, failed: 0 });
    expect(h.sentEmails).toHaveLength(1);
    expect(h.sentEmails[0]).toMatchObject({
      to: "aman@example.com",
      subject: "New lead assigned: Mukesh",
    });
    expect(String((h.sentEmails[0] as Record<string, unknown>).text)).toContain(
      "Name: Mukesh",
    );
    expect(String((h.sentEmails[0] as Record<string, unknown>).text)).toContain(
      "Phone: +919876543210",
    );
    expect(h.sentWhatsapp).toHaveLength(1);
    expect(h.sentWhatsapp[0]).toMatchObject({
      to: "15550001111",
      templateName: "new_lead_notification",
      messageParams: { body: ["Mukesh", "+919876543210"] },
    });
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

  it("sends external emails; the configured address is authoritative", async () => {
    const db = fakeSupabase();
    h.assignees = [
      { id: "assignee-int", user_id: "u-asha" },
    ];
    queued({
      channel: "email",
      assignee_id: "assignee-int",
      to_email: "aman@example.com",
      flow_run_id: "run-1",
      subject: "Hi",
      body: "Hello",
    });
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    // The explicitly configured address wins — the roster email
    // must never override or leak into the delivery.
    expect(h.sentEmails[0]).toMatchObject({ to: "aman@example.com", subject: "Hi" });
    // And the shared SMTP sender account is never substituted as
    // the recipient (SMTP_USER is bot@example.com in this env).
    expect(h.sentEmails[0].to).not.toBe("bot@example.com");
    expect(h.notifications[0].status).toBe("sent");
  });

  it("falls back to the roster email only when no address was configured", async () => {
    const db = fakeSupabase();
    h.assignees = [
      { id: "assignee-int", user_id: "u-asha" },
    ];
    queued({
      channel: "email",
      assignee_id: "assignee-int",
      to_email: null,
      flow_run_id: "run-1",
      subject: "Hi",
      body: "Hello",
    });
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
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
      {
        account_id: "acct-1",
        name: "new_lead_assigned",
        language: "en_US",
        status: "APPROVED",
        body_text: "Hi {{1}}, a new lead was assigned to you.",
      },
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
      // The salesperson stays the recipient; the lead name fills the body.
      to: "15551234567",
      templateName: "new_lead_assigned",
      messageParams: { body: ["Asha"] },
    });
    // Structured components path — never the legacy positional params.
    expect(h.sentWhatsapp[0]).not.toHaveProperty("params");
  });

  it("sends exactly two BODY params for a two-variable template (new_lead_notification)", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      {
        account_id: "acct-1",
        name: "new_lead_notification",
        language: "en_US",
        status: "APPROVED",
        category: "Utility",
        body_text:
          "New lead assigned to you. Lead Name: {{1}} Phone Number: {{2}} Please follow up with this lead.",
      },
    ];
    queued({
      channel: "whatsapp",
      assignee_id: "assignee-ext",
      // The salesperson's phone stays the recipient…
      to_phone: "+15550001111",
      flow_run_id: "run-1",
      template_name: "new_lead_notification",
      template_language: "en_US",
      // …while the lead's facts fill the body, in order.
      lead_name: "Ravi Kumar",
      lead_phone: "+919876543210",
    });
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(h.sentWhatsapp).toHaveLength(1);
    expect(h.sentWhatsapp[0]).toMatchObject({
      phoneNumberId: "pn-1",
      to: "15550001111",
      templateName: "new_lead_notification",
      language: "en_US",
      messageParams: { body: ["Ravi Kumar", "+919876543210"] },
    });
    expect(h.sentWhatsapp[0]).not.toHaveProperty("params");
    expect(h.notifications[0].status).toBe("sent");
  });

  it("sends static templates with no body params instead of a stale single value", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      {
        account_id: "acct-1",
        name: "static_alert",
        language: "en_US",
        status: "APPROVED",
        body_text: "A new lead was assigned to you. Please check the app.",
      },
    ];
    queued({
      channel: "whatsapp",
      assignee_id: "assignee-ext",
      to_phone: "+15551234567",
      flow_run_id: "run-1",
      template_name: "static_alert",
      template_language: "en_US",
      lead_name: "Asha",
    });
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(h.sentWhatsapp[0]).toMatchObject({ messageParams: { body: [] } });
  });

  it("fails terminally before Meta when the lead phone is missing for {{2}}", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      {
        account_id: "acct-1",
        name: "new_lead_notification",
        language: "en_US",
        status: "APPROVED",
        body_text: "Lead Name: {{1}} Phone Number: {{2}}",
      },
    ];
    queued({
      channel: "whatsapp",
      assignee_id: "assignee-ext",
      to_phone: "+15551234567",
      flow_run_id: "run-1",
      template_name: "new_lead_notification",
      template_language: "en_US",
      lead_name: "Asha",
      lead_phone: null,
    });
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    // Never called Meta (no shifted params, no placeholders).
    expect(h.sentWhatsapp).toHaveLength(0);
    const row = h.notifications[0];
    expect(row.status).toBe("failed");
    // Terminal: the snapshot cannot heal on retry.
    expect(row.failed_at).not.toBeNull();
    expect(row.next_attempt_at).toBeNull();
    expect(row.last_error).toContain("{{2}}");
  });

  it("fails terminally before Meta for templates it cannot fill", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    const cases = [
      {
        name: "three vars",
        template: { body_text: "A {{1}} B {{2}} C {{3}}" },
        error: "{{3}}",
      },
      {
        name: "header variable",
        template: { body_text: "Hi {{1}}", header_type: "text", header_content: "Lead {{1}}" },
        error: "header",
      },
      {
        name: "URL button variable",
        template: {
          body_text: "Hi {{1}}",
          buttons: [{ type: "URL", url: "https://x.test/l/{{1}}" }],
        },
        error: "button",
      },
    ];
    for (const c of cases) {
      h.templates = [
        {
          account_id: "acct-1",
          name: "tpl",
          language: "en_US",
          status: "APPROVED",
          ...c.template,
        },
      ];
      h.notifications = [];
      h.sentWhatsapp = [];
      queued({
        channel: "whatsapp",
        assignee_id: "assignee-ext",
        to_phone: "+15551234567",
        flow_run_id: "run-1",
        template_name: "tpl",
        template_language: "en_US",
        lead_name: "Asha",
        lead_phone: "+15550001111",
      });
      const result = await drainTableAssignmentNotifications(db as never);
      expect(result).toMatchObject({ sent: 0, failed: 1 });
      expect(h.sentWhatsapp).toHaveLength(0);
      const row = h.notifications[0];
      expect(row.status).toBe("failed");
      expect(row.failed_at).not.toBeNull();
      expect(String(row.last_error)).toContain(c.error);
    }
  });

  it("stores the complete provider error instead of truncating the diagnosis away", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      {
        account_id: "acct-1",
        name: "tpl",
        language: "en_US",
        status: "APPROVED",
        body_text: "Hi {{1}}",
      },
    ];
    queued({
      channel: "whatsapp",
      assignee_id: "assignee-ext",
      to_phone: "+15551234567",
      flow_run_id: "run-1",
      template_name: "tpl",
      template_language: "en_US",
      lead_name: "Asha",
    });
    h.whatsappError = `(#131000) Something went wrong: ${"detail ".repeat(120)}TAIL`;
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    const stored = h.notifications[0].last_error as string;
    expect(stored.length).toBeGreaterThan(500);
    expect(stored).toContain("TAIL");
    expect(h.notifications[0].status).toBe("failed");
  });

  it("records Meta #132000 as a failure instead of suppressing it", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      {
        account_id: "acct-1",
        name: "new_lead_assigned",
        language: "en_US",
        status: "APPROVED",
        body_text: "Hi {{1}}",
      },
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
    // A provider rejection (e.g. a template edited on Meta after
    // sync) surfaces verbatim on the row — never marked sent.
    h.whatsappError =
      "(#132000) Number of parameters does not match the expected number of params.";
    const result = await drainTableAssignmentNotifications(db as never);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(h.notifications[0].status).toBe("failed");
    expect(h.notifications[0].last_error).toContain("#132000");
  });

  it("keeps the channels independent: one channel's failure never blocks the other", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      {
        account_id: "acct-1",
        name: "new_lead_assigned",
        language: "en_US",
        status: "APPROVED",
        body_text: "Hi {{1}}",
      },
    ];
    const both = (runId: string) => {
      queued({
        channel: "email",
        assignee_id: "assignee-ext",
        to_email: "ext@example.com",
        flow_run_id: runId,
        subject: "Hi",
        body: "Hello",
      });
      queued({
        channel: "whatsapp",
        assignee_id: "assignee-ext",
        to_phone: "+15551234567",
        flow_run_id: runId,
        template_name: "new_lead_assigned",
        template_language: "en_US",
        lead_name: "Asha",
      });
    };
    // SMTP down: WhatsApp still sends.
    both("run-1");
    h.emailThrows = true;
    const first = await drainTableAssignmentNotifications(db as never);
    expect(first).toMatchObject({ sent: 1, failed: 1 });
    expect(h.sentWhatsapp).toHaveLength(1);
    expect(h.sentEmails).toHaveLength(0);

    // WhatsApp down: queued email still sends.
    h.emailThrows = false;
    h.whatsappThrows = true;
    both("run-2");
    const second = await drainTableAssignmentNotifications(db as never);
    expect(second.sent).toBe(1);
    expect(h.sentEmails).toHaveLength(1);
    expect(h.sentWhatsapp).toHaveLength(1);
  });

  it("retries one channel without duplicating the other's success", async () => {
    const db = fakeSupabase();
    h.whatsappConfigs = [
      { account_id: "acct-1", access_token: encrypt("token-1"), phone_number_id: "pn-1" },
    ];
    h.templates = [
      {
        account_id: "acct-1",
        name: "new_lead_assigned",
        language: "en_US",
        status: "APPROVED",
        body_text: "Hi {{1}}",
      },
    ];
    queued({
      channel: "email",
      assignee_id: "assignee-ext",
      to_email: "ext@example.com",
      flow_run_id: "run-1",
      subject: "Hi",
      body: "Hello",
    });
    queued({
      channel: "whatsapp",
      assignee_id: "assignee-ext",
      to_phone: "+15551234567",
      flow_run_id: "run-1",
      template_name: "new_lead_assigned",
      template_language: "en_US",
      lead_name: "Asha",
    });
    h.emailThrows = true;
    await drainTableAssignmentNotifications(db as never);
    expect(h.sentWhatsapp).toHaveLength(1);
    expect(h.sentEmails).toHaveLength(0);
    // The email backoff elapses; the WhatsApp row is already sent.
    h.emailThrows = false;
    for (const n of h.notifications) {
      if (n.channel === "email") n.next_attempt_at = new Date(0).toISOString();
    }
    const retry = await drainTableAssignmentNotifications(db as never);
    expect(retry).toMatchObject({ sent: 1, failed: 0 });
    expect(h.sentEmails).toHaveLength(1);
    expect(h.sentWhatsapp).toHaveLength(1);
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

describe("buildAssignmentBodyParams", () => {
  const tpl = (body_text: string, extra: Record<string, unknown> = {}) => ({
    body_text,
    ...extra,
  });

  it("maps {{1}} to the lead name and {{2}} to the lead phone, in order", () => {
    expect(
      buildAssignmentBodyParams(
        tpl("Lead Name: {{1}} Phone Number: {{2}}"),
        "new_lead_notification",
        "en_US",
        "Ravi Kumar",
        "+919876543210",
      ),
    ).toEqual(["Ravi Kumar", "+919876543210"]);
  });

  it("fills {{1}} only for single-variable templates and omits params for static ones", () => {
    expect(
      buildAssignmentBodyParams(tpl("Hi {{1}}"), "t", "en_US", "Asha", ""),
    ).toEqual(["Asha"]);
    expect(buildAssignmentBodyParams(tpl("Static text."), "t", "en_US", "Asha", "")).toEqual(
      [],
    );
  });

  it("never shifts values and never emits placeholders", () => {
    // Missing phone with {{2}} required → throw, not ["phone-in-{{1}}"].
    expect(() =>
      buildAssignmentBodyParams(tpl("{{1}} {{2}}"), "t", "en_US", "Asha", ""),
    ).toThrow(/\{\{2\}\}/);
    expect(() =>
      buildAssignmentBodyParams(tpl("{{1}} {{2}}"), "t", "en_US", "Asha", "   "),
    ).toThrow(/\{\{2\}\}/);
  });

  it("rejects variables with no assignment-time value", () => {
    for (const body of ["A {{1}} B {{2}} C {{3}}", "Only {{2}}"]) {
      expect(() =>
        buildAssignmentBodyParams(tpl(body), "t", "en_US", "Asha", "+15550001111"),
      ).toThrow(/cannot be sent/);
    }
    expect(() =>
      buildAssignmentBodyParams(
        tpl("Hi {{1}}", { header_type: "text", header_content: "Lead {{1}}" }),
        "t",
        "en_US",
        "Asha",
        "+15550001111",
      ),
    ).toThrow(/header/);
    expect(() =>
      buildAssignmentBodyParams(
        tpl("Hi {{1}}", { buttons: [{ type: "URL", url: "https://x.test/l/{{1}}" }] }),
        "t",
        "en_US",
        "Asha",
        "+15550001111",
      ),
    ).toThrow(/button/);
  });
});
