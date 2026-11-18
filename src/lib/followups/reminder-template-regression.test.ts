import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainDueFollowups } from "./scheduler";
import { persistReminderOutboundMessage } from "@/lib/whatsapp/send-message";
import { NO_FALLBACK_TEMPLATE_MESSAGE } from "./reminder-send";

// End-to-end template-fallback regression: the REAL scheduler +
// REAL reminder-send functions. Only the network (meta-api) and
// token decryption are mocked, so every decision in between —
// window routing, Settings lookup, APPROVED + {{1}} validation,
// exact name/language/payload, fail-closed errors, wamid + Inbox
// persistence, retry idempotency — runs for real.
const h = vi.hoisted(() => ({
  followups: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  templates: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<Record<string, unknown>>,
  conversations: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  textCalls: [] as Array<Record<string, unknown>>,
  templateCalls: [] as Array<Record<string, unknown>>,
  templateBehavior: "ok" as "ok" | "meta-fail",
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (ciphertext: string) => `decrypted(${ciphertext})`,
  encrypt: (s: string) => s,
  isLegacyFormat: () => false,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTextMessage: async (args: Record<string, unknown>) => {
    h.textCalls.push(args);
    return { messageId: "wamid-text-1" };
  },
  sendTemplateMessage: async (args: Record<string, unknown>) => {
    h.templateCalls.push(args);
    if (h.templateBehavior === "meta-fail") {
      throw new Error("Meta rejected the template send");
    }
    return { messageId: "wamid-tpl-1" };
  },
}));

type Row = Record<string, unknown>;
const NOW = new Date("2026-09-24T12:00:00.000Z");
const RECIPIENT = "919876543210";
const TEXT = "Your appointment is tomorrow at 10";

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: `fu-${Math.random().toString(36).slice(2, 8)}`,
    account_id: "acct-1",
    recipient_phone: RECIPIENT,
    contact_id: null,
    conversation_id: null,
    scheduled_for: "2026-09-24T11:00:00.000Z",
    message_text: TEXT,
    template_name: null,
    template_language: null,
    status: "scheduled",
    attempts: 0,
    created_by: "user-1",
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function templateRow(overrides: Partial<Row> = {}): Row {
  return {
    account_id: "acct-1",
    name: "reminder_fallback",
    language: "en_US",
    status: "APPROVED",
    body_text: "Reminder: {{1}}",
    header_type: null,
    buttons: null,
    ...overrides,
  };
}

function seedConfig() {
  h.configs = [
    {
      account_id: "acct-1",
      phone_number_id: "pn-business-1",
      access_token: "enc-token",
    },
  ];
  h.accounts = [
    {
      id: "acct-1",
      reminder_template_name: "reminder_fallback",
      reminder_template_language: "en_US",
    },
  ];
}

/** Fake covering scheduler + send-service + Inbox persistence reads/writes. */
function fakeDb() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const q: Record<string, unknown> = {
      _filters: [] as Array<(x: Row) => boolean>,
      _order: null as { col: string; ascending: boolean } | null,
      _patch: null as Row | null,
    };
    const store = (): Row[] => {
      if (table === "whatsapp_followups") return h.followups;
      if (table === "accounts") return h.accounts;
      if (table === "message_templates") return h.templates;
      if (table === "whatsapp_config") return h.configs;
      if (table === "contacts") return h.contacts;
      if (table === "conversations") return h.conversations;
      if (table === "messages") return h.messages;
      return [];
    };
    const filtered = () => {
      let rows = store().filter((r) =>
        (q._filters as Array<(x: Row) => boolean>).every((f) => f(r)),
      );
      const order = q._order as { col: string; ascending: boolean } | null;
      if (order) {
        rows = [...rows].sort((a, b) =>
          order.ascending
            ? String(a[order.col]) < String(b[order.col])
              ? -1
              : 1
            : String(a[order.col]) > String(b[order.col])
              ? -1
              : 1,
        );
      }
      return rows;
    };
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      (q._filters as Array<(x: Row) => boolean>).push((r) => r[col] === val);
      return q;
    };
    q.in = (col: string, vals: unknown[]) => {
      (q._filters as Array<(x: Row) => boolean>).push((r) =>
        (vals as unknown[]).includes(r[col]),
      );
      return q;
    };
    q.like = (col: string, pattern: string) => {
      const suffix = String(pattern).replace(/^%/, "");
      (q._filters as Array<(x: Row) => boolean>).push((r) =>
        String(r[col] ?? "").endsWith(suffix),
      );
      return q;
    };
    q.or = (expr: string) => {
      (q._filters as Array<(x: Row) => boolean>).push((r) => {
        const m = expr.match(/lte\.([^,)]+)/);
        const bound = m ? m[1] : "";
        const scheduledDue =
          r.status === "scheduled" &&
          String(r.scheduled_for) <= (bound || String(r.scheduled_for));
        const upd = expr.match(/updated_at\.lt\.([^,)]+)/);
        const stale =
          r.status === "processing" &&
          upd != null &&
          String(r.updated_at) < upd[1];
        if (
          expr.includes("status.eq.scheduled") &&
          expr.includes("status.eq.processing")
        ) {
          return scheduledDue || stale;
        }
        if (r.status === "scheduled") return true;
        return stale;
      });
      return q;
    };
    q.order = (col: string, opts?: { ascending?: boolean }) => {
      q._order = { col, ascending: opts?.ascending ?? true };
      return q;
    };
    q.limit = () => q;
    q.update = (patch: Row) => {
      q._patch = patch;
      return q;
    };
    q.insert = (obj: Row) => {
      const created: Row = { id: `${table}-new-${Date.now()}-${Math.random()}`, ...obj };
      store().push(created);
      const single = async () => ({ data: created, error: null });
      return {
        select: (_cols?: string) => ({ single, maybeSingle: single }),
      };
    };
    q.maybeSingle = async () => {
      const rows = filtered();
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows[0] ?? null, error: null };
    };
    q.then = (resolve: (v: unknown) => void) => {
      const rows = filtered();
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
      }
      return resolve({ data: rows, error: null });
    };
    return q;
  };
  return api;
}

/** Recent inbound from the recipient number → window OPEN. */
function openWindow() {
  h.contacts = [{ id: "c-1", account_id: "acct-1", phone: RECIPIENT }];
  h.conversations = [{ id: "conv-1", account_id: "acct-1", contact_id: "c-1" }];
  h.messages = [
    {
      conversation_id: "conv-1",
      sender_type: "customer",
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    },
  ];
}

function agentMessages() {
  return h.messages.filter((m) => m.sender_type === "agent");
}

beforeEach(() => {
  h.followups = [];
  h.accounts = [];
  h.templates = [];
  h.configs = [];
  h.contacts = [];
  h.conversations = [];
  h.messages = [];
  h.textCalls = [];
  h.templateCalls = [];
  h.templateBehavior = "ok";
});

describe("reminder template-only regression (A–J)", () => {
  it("A. window open → template sent (template-only policy, no text fallback)", async () => {
    seedConfig();
    h.templates = [templateRow()];
    openWindow();
    h.followups = [row({})];

    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(1);
    expect(h.templateCalls[0]).toMatchObject({ to: RECIPIENT });
    expect(h.followups[0].status).toBe("sent");
    expect(h.followups[0].failure_reason).toBeNull();
  });

  it("B. window closed + valid APPROVED {{1}} template → template sent", async () => {
    seedConfig();
    h.templates = [templateRow()];
    h.followups = [row({})];

    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(1);
  });

  it("C. window closed + no template → failed with the exact reason, no text send", async () => {
    seedConfig();
    h.accounts = [
      { id: "acct-1", reminder_template_name: null, reminder_template_language: null },
    ];
    h.templates = [templateRow()];
    h.followups = [row({})];

    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(0);
    expect(h.followups[0].status).toBe("failed");
    expect(h.followups[0].failure_reason).toBe(NO_FALLBACK_TEMPLATE_MESSAGE);
  });

  it("D. window closed + rejected template → failed, no text send", async () => {
    seedConfig();
    h.templates = [templateRow({ status: "REJECTED" })];
    h.followups = [row({})];

    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ failed: 1 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(0);
    expect(String(h.followups[0].failure_reason)).toMatch(/not APPROVED/);
    expect(String(h.followups[0].failure_reason)).toMatch(/reminder_fallback/);
  });

  it("E. template with zero body variables → failed", async () => {
    seedConfig();
    h.templates = [templateRow({ body_text: "Static hello, no variables" })];
    h.followups = [row({})];

    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ failed: 1 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(0);
    expect(String(h.followups[0].failure_reason)).toMatch(/exactly one \{\{1\}\}/);
  });

  it("F. template with multiple body variables → failed", async () => {
    seedConfig();
    h.templates = [templateRow({ body_text: "{{1}} and {{2}}" })];
    h.followups = [row({})];

    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ failed: 1 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(0);
    expect(String(h.followups[0].failure_reason)).toMatch(/exactly one \{\{1\}\}/);
  });

  it("G+H. template name/language from Settings used exactly; reminder text becomes {{1}}", async () => {
    seedConfig();
    h.accounts = [
      {
        id: "acct-1",
        reminder_template_name: "custom_reminder",
        reminder_template_language: "hi",
      },
    ];
    h.templates = [
      templateRow({ name: "custom_reminder", language: "hi" }),
      // Decoy with the same name in another language — must NOT win.
      templateRow({ name: "custom_reminder", language: "en_US" }),
    ];
    h.followups = [row({})];

    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.templateCalls).toHaveLength(1);
    expect(h.templateCalls[0]).toMatchObject({
      to: RECIPIENT,
      templateName: "custom_reminder",
      language: "hi",
      messageParams: { body: [TEXT] },
    });
    // Sender stays the connected business number.
    expect(h.templateCalls[0]).toMatchObject({
      phoneNumberId: "pn-business-1",
      accessToken: "decrypted(enc-token)",
    });
  });

  it("I. successful template send stores wamid and the complete rendered Inbox message", async () => {
    seedConfig();
    h.templates = [templateRow()];
    h.followups = [row({})];

    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.followups[0].whatsapp_message_id).toBe("wamid-tpl-1");

    const agent = agentMessages();
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({
      content_type: "template",
      template_name: "reminder_fallback",
      content_text: `Reminder: ${TEXT}`,
      message_id: "wamid-tpl-1",
      status: "sent",
    });
  });

  it("J. retry does not create a duplicate Inbox message", async () => {
    seedConfig();
    h.templates = [templateRow()];
    h.followups = [row({})];

    const first = await drainDueFollowups(fakeDb() as never, NOW);
    expect(first).toMatchObject({ sent: 1 });
    // A re-armed drain finds nothing — sent rows are never re-sent.
    const second = await drainDueFollowups(fakeDb() as never, NOW);
    expect(second).toMatchObject({ processed: 0, sent: 0 });
    expect(h.templateCalls).toHaveLength(1);

    // Same wamid re-persisted (webhook/retry replay) returns the
    // existing row instead of duplicating.
    const convId = agentMessages()[0].conversation_id;
    const again = await persistReminderOutboundMessage(fakeDb() as never, {
      accountId: "acct-1",
      recipientPhone: RECIPIENT,
      auditUserId: "user-1",
      contentText: `Reminder: ${TEXT}`,
      whatsappMessageId: "wamid-tpl-1",
      templateName: "reminder_fallback",
    });
    expect(again?.messageId).toBe(agentMessages()[0].id);
    expect(agentMessages()).toHaveLength(1);
    expect(agentMessages()[0].conversation_id).toBe(convId);
  });
});
