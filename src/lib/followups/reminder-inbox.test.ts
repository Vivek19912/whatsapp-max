import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainDueFollowups } from "./scheduler";
import { persistReminderOutboundMessage } from "@/lib/whatsapp/send-message";
import { isForwardMessageStatus } from "@/lib/whatsapp/message-status";

const h = vi.hoisted(() => ({
  followups: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<Record<string, unknown>>,
  conversations: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ table: string; op: string }>,
  failMessagesInsert: false,
}));

// Meta sends are mocked at the module boundary; Inbox persistence
// runs for real against the in-memory db below.
vi.mock("./reminder-send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reminder-send")>();
  return {
    ...actual,
    sendReminderToAgent: async (
      _db: unknown,
      _accountId: string,
      params: { to: string; text: string },
    ) => ({ whatsappMessageId: "wamid-text-1", via: "text" as const, ...params }),
    sendReminderViaTemplate: async (
      _db: unknown,
      _accountId: string,
      params: { to: string; text: string },
    ) => ({
      whatsappMessageId: "wamid-tpl-1",
      via: "template" as const,
      templateName: "reminder_fallback",
      renderedText: `Reminder: ${params.text}`,
      ...params,
    }),
  };
});

type Row = Record<string, unknown>;
const NOW = new Date("2026-09-24T12:00:00.000Z");

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: `fu-${Math.random().toString(36).slice(2, 8)}`,
    account_id: "acct-1",
    recipient_phone: "919876543210",
    contact_id: null,
    conversation_id: null,
    scheduled_for: "2026-09-24T11:00:00.000Z",
    message_text: "Your appointment is tomorrow at 10",
    template_name: null,
    template_language: null,
    status: "scheduled",
    attempts: 0,
    created_by: "user-1",
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

/** Fake covering the scheduler + contact/conversation/message writes. */
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
      h.writes.push({ table, op: "update" });
      q._patch = patch;
      return q;
    };
    q.insert = (obj: Row) => {
      h.writes.push({ table, op: "insert" });
      if (table === "messages" && h.failMessagesInsert) {
        const err = { message: "boom", code: "XX000" };
        return {
          select: (_cols?: string) => ({
            single: async () => ({ data: null, error: err }),
            maybeSingle: async () => ({ data: null, error: err }),
          }),
        };
      }
      const created: Row = { id: `${table}-new-${h.writes.length}`, ...obj };
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
    // findOrCreateContact insert uses .select().single(); the
    // get-or-create conversation insert too.
    (q as Record<string, unknown>).single = async () => {
      const rows = filtered();
      return rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { message: "no row", code: "PGRST116" } };
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

/** Window evidence: the recipient number messaged the business at `at`. */
function inboundEvidence(at: string) {
  h.contacts = [{ id: "c-1", account_id: "acct-1", phone: "919876543210" }];
  h.conversations = [{ id: "conv-1", account_id: "acct-1", contact_id: "c-1" }];
  h.messages = [
    { conversation_id: "conv-1", sender_type: "customer", created_at: at },
  ];
}

/** Webhook-equivalent status mirror: forward-only by wamid. */
async function mirrorStatus(wamid: string, status: string) {
  const db = fakeDb() as never;
  const { data: rows } = (await (
    db as unknown as {
      from: (t: string) => {
        select: () => {
          eq: (c: string, v: unknown) => Promise<{ data: Row[] }>;
        };
      };
    }
  )
    .from("messages")
    .select()
    .eq("message_id", wamid)) as { data: Row[] };
  for (const r of rows ?? []) {
    if (isForwardMessageStatus(r.status as string, status)) r.status = status;
  }
}

beforeEach(() => {
  h.followups = [];
  h.contacts = [];
  h.conversations = [];
  h.messages = [];
  h.writes = [];
  h.failMessagesInsert = false;
});

describe("reminder Inbox persistence", () => {
  it("open-window send still lands as a template with the complete rendered body", async () => {
    inboundEvidence(new Date(Date.now() - 3600_000).toISOString());
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 1, failed: 0 });

    const agent = h.messages.filter((m) => m.sender_type === "agent");
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({
      conversation_id: "conv-1",
      content_type: "template",
      content_text: "Reminder: Your appointment is tomorrow at 10",
      template_name: "reminder_fallback",
      message_id: "wamid-tpl-1",
      status: "sent",
    });
    const conv = h.conversations.find((c) => c.id === "conv-1");
    expect(conv?.last_message_text).toBe("Reminder: Your appointment is tomorrow at 10");
  });

  it("closed-window template send stores template metadata + complete rendered body", async () => {
    // No inbound evidence → template path with complete rendered body.
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ sent: 1 });

    const agent = h.messages.filter((m) => m.sender_type === "agent");
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({
      content_type: "template",
      template_name: "reminder_fallback",
      content_text: "Reminder: Your appointment is tomorrow at 10",
      message_id: "wamid-tpl-1",
      status: "sent",
    });
  });

  it("threads by recipient phone — never the optional customer", async () => {
    // Optional customer on a DIFFERENT number with its own thread.
    h.contacts = [
      { id: "cust-1", account_id: "acct-1", phone: "911111111111" },
    ];
    h.conversations = [
      {
        id: "conv-cust",
        account_id: "acct-1",
        contact_id: "cust-1",
        last_message_text: "hello",
      },
    ];
    h.followups = [row({ contact_id: "cust-1" })];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ sent: 1 });

    // Recipient thread created for the snapshot number, account-scoped.
    const recipientContact = h.contacts.find((c) => c.id !== "cust-1");
    expect(recipientContact).toMatchObject({
      account_id: "acct-1",
      user_id: "user-1",
    });
    expect(
      String(recipientContact?.phone ?? "").replace(/\D/g, ""),
    ).toBe("919876543210");
    const agent = h.messages.filter((m) => m.sender_type === "agent");
    expect(agent).toHaveLength(1);
    expect(agent[0].conversation_id).not.toBe("conv-cust");
    // Customer thread untouched.
    expect(
      h.messages.filter((m) => m.conversation_id === "conv-cust"),
    ).toHaveLength(0);
    expect(
      h.conversations.find((c) => c.id === "conv-cust")?.last_message_text,
    ).toBe("hello");
  });

  it("retry with the same wamid does not duplicate the Inbox row", async () => {
    inboundEvidence(new Date(Date.now() - 3600_000).toISOString());
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);
    expect(
      h.messages.filter((m) => m.sender_type === "agent"),
    ).toHaveLength(1);

    const again = await persistReminderOutboundMessage(fakeDb() as never, {
      accountId: "acct-1",
      recipientPhone: "919876543210",
      auditUserId: "user-1",
      contentText: "Reminder: Your appointment is tomorrow at 10",
      whatsappMessageId: "wamid-tpl-1",
      templateName: "reminder_fallback",
    });
    expect(again).not.toBeNull();
    expect(
      h.messages.filter((m) => m.sender_type === "agent"),
    ).toHaveLength(1);
    expect(again?.messageId).toBe(
      h.messages.find((m) => m.sender_type === "agent")?.id,
    );
  });

  it("webhook sent → delivered → read advances the row; stale events never downgrade", async () => {
    inboundEvidence(new Date(Date.now() - 3600_000).toISOString());
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);

    await mirrorStatus("wamid-tpl-1", "delivered");
    await mirrorStatus("wamid-tpl-1", "read");
    expect(
      h.messages.find((m) => m.message_id === "wamid-tpl-1")?.status,
    ).toBe("read");

    // Late/duplicate delivered (or sent) after read must not regress.
    await mirrorStatus("wamid-tpl-1", "delivered");
    await mirrorStatus("wamid-tpl-1", "sent");
    expect(
      h.messages.find((m) => m.message_id === "wamid-tpl-1")?.status,
    ).toBe("read");
  });

  it("Inbox failure stays best-effort — the reminder is still sent, never duplicated", async () => {
    inboundEvidence(new Date(Date.now() - 3600_000).toISOString());
    h.followups = [row({})];
    h.failMessagesInsert = true;
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(
      h.messages.filter((m) => m.sender_type === "agent"),
    ).toHaveLength(0);
  });
});
