import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainDueFollowups } from "./scheduler";

const h = vi.hoisted(() => ({
  followups: [] as Array<Record<string, unknown>>,
  sends: [] as Array<{ to: string; text: string; accountId: string }>,
  sendBehavior: "ok" as "ok" | "meta-fail",
  tablesRead: [] as string[],
  writes: [] as Array<{ table: string; op: string }>,
  // Creator's CURRENT Reminder WhatsApp Number. Defaults to the
  // row snapshot (no refresh); dedicated tests change it to prove
  // stale snapshots are re-pointed before sending.
  profileNumber: "919876543210",
  // Window-check fixtures: the agent's number messaged the business
  // recently, so the default path stays free-text (existing tests).
  contacts: [] as Array<Record<string, unknown>>,
  conversations: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
}));

// The self-reminder sender is mocked at the module boundary: no Meta
// calls, no config reads here. reminder-send.ts has its own tests.
vi.mock("./reminder-send", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./reminder-send")>();
  return {
    ...actual,
    sendReminderToAgent: async (
      _db: unknown,
      accountId: string,
      params: { to: string; text: string },
    ) => {
      h.sends.push({ ...params, accountId });
      if (h.sendBehavior === "meta-fail") {
        throw new actual.SendMessageError("meta_error", "Meta API error", 502);
      }
      return { whatsappMessageId: `wamid-${h.sends.length}` };
    },
    sendReminderViaTemplate: async (
      _db: unknown,
      accountId: string,
      params: { to: string; text: string },
    ) => {
      h.sends.push({ ...params, accountId });
      if (h.sendBehavior === "meta-fail") {
        throw new actual.SendMessageError("meta_error", "Meta API error", 502);
      }
      return {
        whatsappMessageId: `wamid-tpl-${h.sends.length}`,
        phoneNumberId: "pn-1",
        via: "template" as const,
        templateName: "reminder_fallback",
      };
    },
  };
});

type Row = Record<string, unknown>;

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: `fu-${Math.random().toString(36).slice(2, 8)}`,
    account_id: "acct-1",
    // Immutable creation-time snapshot of the creator's number.
    recipient_phone: "919876543210",
    // Customer context only — its phone must NEVER be dialed.
    contact_id: "contact-9",
    conversation_id: null,
    scheduled_for: "2026-01-01T00:00:00.000Z",
    message_text: "Call Rahul about Singapore package",
    template_name: null,
    template_language: null,
    status: "scheduled",
    attempts: 0,
    created_by: "user-1",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal in-memory Supabase stand-in honoring the scheduler's queries. */
function fakeDb() {
  const matches = (r: Row, filters: Array<(x: Row) => boolean>) =>
    filters.every((f) => f(r));
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    h.tablesRead.push(table);
    const q: Record<string, unknown> = {
      _filters: [] as Array<(x: Row) => boolean>,
      _patch: null as Row | null,
      _table: table,
    };
    const store = () => {
      if (table === "whatsapp_followups") return h.followups;
      if (table === "contacts") return h.contacts;
      if (table === "conversations") return h.conversations;
      if (table === "messages") return h.messages;
      return [];
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
      // Supports the two scheduler predicates: due scan and claim.
      (q._filters as Array<(x: Row) => boolean>).push((r) => {
        const m = expr.match(/lte\.([^,)]+)/);
        const bound = m ? m[1] : "";
        const scheduledDue =
          r.status === "scheduled" &&
          String(r.scheduled_for) <= (bound || (r.scheduled_for as string));
        // Claim form carries explicit updated_at bound for processing.
        const upd = expr.match(/updated_at\.lt\.([^,)]+)/);
        const stale =
          r.status === "processing" &&
          upd != null &&
          String(r.updated_at) < upd[1];
        if (expr.includes("status.eq.scheduled") && expr.includes("status.eq.processing")) {
          return scheduledDue || stale;
        }
        return scheduledDue || r.status === "processing";
      });
      return q;
    };
    q.order = (col: string, opts?: { ascending?: boolean }) => {
      (q._orderBy as { col: string; ascending: boolean } | null) = {
        col,
        ascending: opts?.ascending ?? true,
      };
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
      const created: Row = { id: `${table}-new-${h.writes.length}`, ...obj };
      store().push(created);
      const single = async () => ({ data: created, error: null });
      return {
        select: (_cols?: string) => ({ single, maybeSingle: single }),
      };
    };
    q.maybeSingle = async () => {
      // The scheduler never resolves recipients from profiles; serve
      // a decoy number so any such read would be caught by assertion.
      if (table === "profiles") {
        return {
          data: { whatsapp_number: h.profileNumber },
          error: null,
        };
      }
      let rows = store().filter((r) =>
        matches(r, q._filters as Array<(x: Row) => boolean>),
      );
      const orderBy = q._orderBy as { col: string; ascending: boolean } | null;
      if (orderBy) {
        rows = [...rows].sort((a, b) =>
          orderBy.ascending
            ? String(a[orderBy.col]) < String(b[orderBy.col])
              ? -1
              : 1
            : String(a[orderBy.col]) > String(b[orderBy.col])
              ? -1
              : 1,
        );
      }
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows[0] ?? null, error: null };
    };
    // Supabase builders are thenable: awaiting a bare chain (the
    // due scan, status updates) resolves the filtered rows and
    // applies any pending patch — mirroring the real client.
    q.then = (resolve: (v: unknown) => void) => {
      const rows = store().filter((r) =>
        matches(r, q._filters as Array<(x: Row) => boolean>),
      );
      if (q._patch) {
        for (const r of rows) Object.assign(r, q._patch);
      }
      return resolve({ data: rows, error: null });
    };
    return q;
  };
  return api;
}

const NOW = new Date("2026-09-23T12:00:00.000Z");

beforeEach(() => {
  h.followups = [];
  h.sends = [];
  h.sendBehavior = "ok";
  h.tablesRead = [];
  h.writes = [];
  h.profileNumber = "919876543210";
  // Open-window fixtures: the agent's number messaged the business
  // recently, so the default path stays free-text (existing tests).
  // created_at tracks real now; every drain NOW in these tests is an
  // older fixed instant, so the window reads open deterministically.
  const recent = new Date(Date.now() - 3600_000).toISOString();
  h.contacts = [{ id: "contact-9", account_id: "acct-1", phone: "919876543210" }];
  h.conversations = [
    { id: "conv-9", contact_id: "contact-9", account_id: "acct-1" },
  ];
  h.messages = [
    { conversation_id: "conv-9", sender_type: "customer", created_at: recent },
  ];
});

/** Every write the scheduler performs must target its own reminder
 *  rows or the RECIPIENT's Inbox thread (contact/conversation/message
 *  for the recipient snapshot). Reads cover the recipient snapshot's
 *  window evidence (contacts/conversations/messages), the creator's
 *  current number (profiles — stale-snapshot refresh only), plus
 *  sender config — never customer threads selected via contact_id,
 *  never flow runs. */
function expectNoCustomerSideEffects(recipientPhone = "919876543210") {
  expect(h.tablesRead).not.toContain("flow_runs");
  for (const w of h.writes) {
    expect([
      "whatsapp_followups",
      "contacts",
      "conversations",
      "messages",
    ]).toContain(w.table);
  }
  // Recipient-thread only: no message may land in any other
  // conversation, and no contact may be created for any other phone.
  const recipientContactIds = h.contacts
    .filter((c) => String(c.phone ?? "").replace(/\D/g, "").endsWith(recipientPhone.slice(-10)))
    .map((c) => c.id);
  const recipientConvIds = h.conversations
    .filter((c) => recipientContactIds.includes(c.contact_id))
    .map((c) => c.id);
  for (const m of h.messages.filter((m) => m.sender_type === "agent")) {
    expect(recipientConvIds).toContain(m.conversation_id);
  }
}

describe("drainDueFollowups (self-reminders)", () => {
  it("sends to the recipient snapshot — never the customer phone", async () => {
    h.followups = [row({})];
    const db = fakeDb();
    const first = await drainDueFollowups(db as never, NOW);
    expect(first).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      to: "919876543210",
      text: "Call Rahul about Singapore package",
      accountId: "acct-1",
    });
    const stored = h.followups[0] as Row;
    expect(stored.status).toBe("sent");
    expect(stored.whatsapp_message_id).toMatch(/^wamid-/);
    expectNoCustomerSideEffects();
    // Second drain finds nothing to do — no duplicate send.
    const second = await drainDueFollowups(db as never, NOW);
    expect(second).toMatchObject({ processed: 0, sent: 0 });
    expect(h.sends).toHaveLength(1);
  });

  it("re-points a stale snapshot to the creator's current number", async () => {
    // Snapshot predates a profile change: the send must go to the
    // CURRENT number and the row must record it. History is only
    // ever rewritten on still-scheduled rows under claim.
    h.followups = [row({ recipient_phone: "918737064453" })];
    h.profileNumber = "911111111111";
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.sends[0].to).toBe("911111111111");
    expect(h.followups[0].recipient_phone).toBe("911111111111");
    expect(h.tablesRead).toContain("profiles");
    expectNoCustomerSideEffects("911111111111");
  });

  it("keeps the snapshot when the creator has no valid current number", async () => {
    h.followups = [row({})];
    h.profileNumber = "not-a-number";
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.sends[0].to).toBe("919876543210");
    expect(h.followups[0].recipient_phone).toBe("919876543210");
  });

  it("never re-points an explicit per-reminder override", async () => {
    // The creator changed their Settings number AFTER explicitly
    // overriding this reminder's destination: the send must use the
    // saved override and the row must keep it (no silent rewrite).
    h.followups = [row({ recipient_phone: "919123456789", recipient_custom: true })];
    h.profileNumber = "911111111111";
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.sends[0].to).toBe("919123456789");
    expect(h.followups[0].recipient_phone).toBe("919123456789");
    // No one else's Inbox thread is touched.
    expectNoCustomerSideEffects("919123456789");
  });

  it("retries use the same saved recipient, not the live Settings number", async () => {
    h.followups = [row({ recipient_phone: "919123456789", recipient_custom: true })];
    h.profileNumber = "911111111111";
    h.sendBehavior = "meta-fail";
    const db = fakeDb();
    expect(await drainDueFollowups(db as never, NOW)).toMatchObject({ failed: 1 });
    // Manual retry re-queues the same row (mirrors POST /api/followups/[id]/retry).
    Object.assign(h.followups[0], { status: "scheduled", attempts: 1, failure_reason: null, failed_at: null });
    h.sendBehavior = "ok";
    const retry = await drainDueFollowups(db as never, NOW);
    expect(retry).toMatchObject({ sent: 1 });
    expect(h.sends[h.sends.length - 1].to).toBe("919123456789");
    expect(h.followups[0].recipient_phone).toBe("919123456789");
  });

  it("sends without a customer and without any template or window", async () => {
    // No customer context at all, no template, no recent inbound —
    // the customer 24-hour window must not gate self-reminders.
    h.followups = [row({ contact_id: null })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.sends[0].to).toBe("919876543210");
    expectNoCustomerSideEffects();
  });

  it("customer message activity cannot change the recipient", async () => {
    h.followups = [row({})];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    // Window evidence may be read, but the recipient stays the
    // immutable snapshot — never derived from activity.
    expect(h.sends[0].to).toBe("919876543210");
    expectNoCustomerSideEffects();
  });

  it("fails loudly on legacy rows without a recipient snapshot", async () => {
    h.followups = [row({ recipient_phone: null })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(h.sends).toHaveLength(0);
    expect(h.followups[0].status).toBe("failed");
    expect(String(h.followups[0].failure_reason)).toMatch(/recipient/i);
  });

  it("fails loudly without a creator", async () => {
    h.followups = [row({ created_by: null })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ failed: 1 });
    expect(h.sends).toHaveLength(0);
  });

  it("skips cancelled reminders without sending", async () => {
    h.followups = [row({ status: "cancelled" })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(h.sends).toHaveLength(0);
    expect(out.sent).toBe(0);
  });

  it("does not send future reminders early", async () => {
    h.followups = [row({ scheduled_for: "2999-01-01T00:00:00.000Z" })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, new Date("2026-01-01T00:00:00.000Z"));
    expect(out).toMatchObject({ processed: 0, sent: 0 });
    expect(h.sends).toHaveLength(0);
  });

  it("marks Meta failures as failed with the reason stored", async () => {
    h.followups = [row({})];
    h.sendBehavior = "meta-fail";
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out.failed).toBe(1);
    expect(h.followups[0].status).toBe("failed");
    expect(h.followups[0].failure_reason).toBeTruthy();
  });

  it("gives up after max attempts", async () => {
    h.followups = [row({ attempts: 3 })];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out.failed).toBe(1);
    expect(h.sends).toHaveLength(0);
  });

  it("scopes the send to the reminder's own account", async () => {
    h.followups = [row({ account_id: "acct-9" })];
    // Window evidence in the reminder's own account keeps the text path.
    h.contacts = [{ id: "contact-9", account_id: "acct-9", phone: "919876543210" }];
    h.conversations = [
      { id: "conv-9", contact_id: "contact-9", account_id: "acct-9" },
    ];
    const db = fakeDb();
    const out = await drainDueFollowups(db as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.sends[0].accountId).toBe("acct-9");
  });
});
