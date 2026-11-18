import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainDueFollowups } from "./scheduler";

const h = vi.hoisted(() => ({
  followups: [] as Array<Record<string, unknown>>,
  textSends: [] as Array<{ to: string; text: string; accountId: string }>,
  templateSends: [] as Array<{ to: string; text: string; accountId: string }>,
  templateBehavior: "ok" as "ok" | "meta-fail",
  contacts: [] as Array<Record<string, unknown>>,
  conversations: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ table: string; op: string }>,
}));

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
      h.textSends.push({ ...params, accountId });
      return {
        whatsappMessageId: "wamid-text-1",
        phoneNumberId: "pn-1",
        via: "text" as const,
      };
    },
    sendReminderViaTemplate: async (
      _db: unknown,
      accountId: string,
      params: { to: string; text: string },
    ) => {
      h.templateSends.push({ ...params, accountId });
      if (h.templateBehavior === "meta-fail") {
        throw new actual.SendMessageError("meta_error", "Meta API error", 502);
      }
      return {
        whatsappMessageId: "wamid-tpl-1",
        phoneNumberId: "pn-1",
        via: "template" as const,
        templateName: "reminder_fallback",
        renderedText: `Reminder: ${params.text}`,
      };
    },
  };
});

type Row = Record<string, unknown>;

const NOW = new Date("2026-09-24T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

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

/** Purpose-built fake: due-scan, claim, window evidence, row writes. */
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
    q.or = (expr: string) => {
      // Supports the two scheduler predicates: due scan (with an
      // lte bound) and atomic claim (scheduled flip + stale reclaim,
      // no bound — fall back to the row's own timestamp so the
      // scheduled branch still flips, mirroring scheduler.test.ts).
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
        // Claim form without a scan bound: flip scheduled rows and
        // provably stale processing rows only.
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
    q.like = (col: string, pattern: string) => {
      const suffix = String(pattern).replace(/^%/, "");
      (q._filters as Array<(x: Row) => boolean>).push((r) =>
        String(r[col] ?? "").endsWith(suffix),
      );
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
    q.update = (patch: Row) => {
      h.writes.push({ table, op: "update" });
      q._patch = patch;
      return q;
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

/** Window evidence: the agent's number messaged the business at `at`. */
function inboundEvidence(at: string) {
  h.contacts = [{ id: "c-1", account_id: "acct-1", phone: "+91 98765 43210" }];
  h.conversations = [{ id: "conv-1", account_id: "acct-1", contact_id: "c-1" }];
  h.messages = [
    { conversation_id: "conv-1", sender_type: "customer", created_at: at },
  ];
}

beforeEach(() => {
  h.followups = [];
  h.textSends = [];
  h.templateSends = [];
  h.templateBehavior = "ok";
  h.contacts = [];
  h.conversations = [];
  h.messages = [];
  h.writes = [];
});

describe("reminder template-only policy (window never changes the path)", () => {
  it("open window still sends the approved template (no text fallback)", async () => {
    inboundEvidence(iso(NOW.getTime() - 3600_000));
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.textSends).toHaveLength(0);
    expect(h.templateSends).toHaveLength(1);
    expect(h.templateSends[0]).toMatchObject({
      to: "919876543210",
      text: "Your appointment is tomorrow at 10",
      accountId: "acct-1",
    });
    expect(h.followups[0]).toMatchObject({ status: "sent" });
    expect(h.followups[0].whatsapp_message_id).toMatch(/^wamid-/);
  });

  it("closed window sends the approved template with {{1}} = message", async () => {
    inboundEvidence(iso(NOW.getTime() - 25 * 3600_000));
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(h.textSends).toHaveLength(0);
    expect(h.templateSends).toHaveLength(1);
    expect(h.templateSends[0]).toMatchObject({
      to: "919876543210",
      text: "Your appointment is tomorrow at 10",
      accountId: "acct-1",
    });
    expect(h.followups[0]).toMatchObject({ status: "sent" });
    expect(h.followups[0].whatsapp_message_id).toMatch(/^wamid-/);
    expect(h.followups[0].failure_reason).toBeNull();
  });

  it("no inbound ever means closed window (template path)", async () => {
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ sent: 1 });
    expect(h.templateSends).toHaveLength(1);
  });

  it("boundary: just-inside and just-outside 24h both send template", async () => {
    inboundEvidence(iso(NOW.getTime() - (24 * 3600_000 - 60_000)));
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);
    expect(h.textSends).toHaveLength(0);
    expect(h.templateSends).toHaveLength(1);

    h.textSends = [];
    h.templateSends = [];
    inboundEvidence(iso(NOW.getTime() - (24 * 3600_000 + 60_000)));
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);
    expect(h.textSends).toHaveLength(0);
    expect(h.templateSends).toHaveLength(1);
  });

  it("template Meta failure is captured with the reason stored", async () => {
    h.templateBehavior = "meta-fail";
    h.followups = [row({})];
    const out = await drainDueFollowups(fakeDb() as never, NOW);
    expect(out).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(h.followups[0].status).toBe("failed");
    expect(String(h.followups[0].failure_reason)).toMatch(/Meta API error/);
  });

  it("customer phones never become the recipient on either path", async () => {
    h.contacts = [{ id: "c-9", account_id: "acct-1", phone: "+911234567890" }];
    h.conversations = [{ id: "conv-9", account_id: "acct-1", contact_id: "c-9" }];
    h.messages = [
      {
        conversation_id: "conv-9",
        sender_type: "customer",
        created_at: iso(NOW.getTime() - 3600_000),
      },
    ];
    h.followups = [row({})];
    await drainDueFollowups(fakeDb() as never, NOW);
    // +911234567890 inbound does NOT open the agent's window.
    expect(h.templateSends).toHaveLength(1);
    expect(h.templateSends[0].to).toBe("919876543210");
  });

  it("template path never double-sends (second drain is idle)", async () => {
    h.followups = [row({})];
    const db = fakeDb();
    await drainDueFollowups(db as never, NOW);
    expect(h.templateSends).toHaveLength(1);
    const second = await drainDueFollowups(db as never, NOW);
    expect(second).toMatchObject({ processed: 0, sent: 0 });
    expect(h.templateSends).toHaveLength(1);
  });
});
