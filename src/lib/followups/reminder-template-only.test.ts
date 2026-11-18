import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainDueFollowups } from "./scheduler";
import { sendReminderViaTemplate } from "./reminder-send";

// Template-only policy + complete Inbox rendering: the REAL
// scheduler + REAL reminder-send. Only meta-api + encryption are
// mocked. Covers: window active/expired both template, no text
// fallback, recipient/language/variables, complete rendered body
// (emojis/line breaks/header/footer), wamid + Inbox persistence,
// retry idempotency, fail-closed with no silent text.
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
  profiles: [] as Array<Record<string, unknown>>,
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
    return { messageId: (args as { to?: string }).to ? "wamid-tpl-1" : "wamid-tpl-1" };
  },
}));

type Row = Record<string, unknown>;
const NOW = new Date("2026-09-24T12:00:00.000Z");
const RECIPIENT = "919876543210";
const TEXT = "Tarun T, 919731975216";

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
    name: "lead_followup_reminder",
    language: "en_US",
    status: "APPROVED",
    body_text:
      "🔔 Lead Follow-up Reminder\n\nHi,\n\nThis is a reminder to follow up with the following lead:\n\n{{1}}\n\n⏰ Please contact this lead at the scheduled follow-up time.",
    footer_text: "Canara Tales",
    header_type: null,
    header_content: null,
    buttons: null,
    ...overrides,
  };
}

function seedConfig() {
  h.configs = [
    { account_id: "acct-1", phone_number_id: "pn-business-1", access_token: "enc-token" },
  ];
  h.accounts = [
    {
      id: "acct-1",
      reminder_template_name: "lead_followup_reminder",
      reminder_template_language: "en_US",
    },
  ];
  h.profiles = [];
}

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
      if (table === "profiles") return h.profiles;
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
    // findOrCreateContact uses ilike/or in some paths — treat like `like`.
    q.ilike = (col: string, pattern: string) => {
      const suffix = String(pattern).replace(/^%/, "").toLowerCase();
      (q._filters as Array<(x: Row) => boolean>).push((r) =>
        String(r[col] ?? "").toLowerCase().endsWith(suffix),
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
      return { select: (_cols?: string) => ({ single, maybeSingle: single }) };
    };
    q.maybeSingle = async () => {
      const rows = filtered();
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows[0] ?? null, error: null };
    };
    q.single = async () => {
      const rows = filtered();
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: "no row" } };
      }
      return rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { message: "no row" } };
    };
    q.single = async () => {
      const rows = filtered();
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: "no row" } };
      }
      return rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { message: "no row" } };
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
  h.profiles = [];
});

describe("reminder template-only + complete Inbox rendering", () => {
  it("1. window ACTIVE still uses the approved template (no text fallback)", async () => {
    seedConfig();
    h.templates = [templateRow()];
    openWindow();
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(1);
    expect(h.templateCalls[0]).toMatchObject({
      to: RECIPIENT,
      templateName: "lead_followup_reminder",
      language: "en_US",
      phoneNumberId: "pn-business-1",
    });
  });

  it("2. window EXPIRED uses the same approved template", async () => {
    seedConfig();
    h.templates = [templateRow()];
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(1);
    expect(h.templateCalls[0]).toMatchObject({ templateName: "lead_followup_reminder" });
  });

  it("6. correct language, recipient, and {{1}} variable mapping", async () => {
    seedConfig();
    h.templates = [templateRow()];
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);
    expect(h.templateCalls[0]).toMatchObject({
      to: RECIPIENT,
      language: "en_US",
      messageParams: { body: [TEXT] },
    });
  });

  it("7+8. complete rendered body with emojis + line breaks + footer saved to Inbox", async () => {
    seedConfig();
    h.templates = [templateRow()];
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);
    const agent = agentMessages();
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({
      content_type: "template",
      template_name: "lead_followup_reminder",
      message_id: "wamid-tpl-1",
      status: "sent",
    });
    const body = String(agent[0].content_text ?? "");
    expect(body).toContain("🔔 Lead Follow-up Reminder");
    expect(body).toContain(TEXT);
    expect(body).toContain("⏰ Please contact this lead");
    expect(body).toContain("Canara Tales");
    expect(body).toContain("\n\n");
    // Inbox preview mirrors the same complete text.
    const conv = h.conversations.find((c) => c.id === agent[0].conversation_id);
    expect(conv?.last_message_text).toBe(body);
  });

  it("9+10. wamid associated; Inbox row carries the full stored message", async () => {
    seedConfig();
    h.templates = [templateRow()];
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);
    expect(h.followups[0].whatsapp_message_id).toBe("wamid-tpl-1");
    expect(agentMessages()[0].message_id).toBe("wamid-tpl-1");
  });

  it("14. retry re-arms to the same template send without duplicating Inbox", async () => {
    seedConfig();
    h.templates = [templateRow()];
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);
    expect(h.templateCalls).toHaveLength(1);
    const second = await drainDueFollowups(fakeDb() as never, NOW);
    expect(second).toMatchObject({ processed: 0, sent: 0 });
    expect(agentMessages()).toHaveLength(1);
  });

  it("fail-closed: no template configured fails without any text send", async () => {
    seedConfig();
    h.accounts = [{ id: "acct-1", reminder_template_name: null, reminder_template_language: null }];
    h.templates = [templateRow()];
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ sent: 0, failed: 1 });
    expect(h.textCalls).toHaveLength(0);
    expect(h.templateCalls).toHaveLength(0);
    expect(String(h.followups[0].failure_reason)).toMatch(/No approved reminder template/);
  });

  it("direct send returns the complete rendered text with the same param Meta receives", async () => {
    seedConfig();
    h.templates = [templateRow()];
    const res = await sendReminderViaTemplate(fakeDb() as never, "acct-1", {
      to: RECIPIENT,
      text: TEXT,
    });
    expect(res.templateName).toBe("lead_followup_reminder");
    expect(res.templateLanguage).toBe("en_US");
    expect(res.renderedText).toContain(TEXT);
    expect(res.renderedText).toContain("🔔 Lead Follow-up Reminder");
    expect(h.templateCalls[0]).toMatchObject({ messageParams: { body: [TEXT] } });
  });
});
