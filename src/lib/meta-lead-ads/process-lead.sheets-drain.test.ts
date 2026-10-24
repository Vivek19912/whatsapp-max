// Meta Lead Ads processing → prompt Sheets drain (shared path).
//
// Pins the contract the polling audit requires: every lead that is
// newly processed through `processSubmissionById` — whether found by
// the poll sweep, a historical import, a retry, or the webhook —
// queues sheets sync AND schedules a prompt post-response drain when
// (and only when) a genuinely new outbox row was created. Duplicates,
// already-queued rows, and scheduler failures never duplicate sheet
// rows and never fail lead processing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processSubmissionById } from "./process-lead";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  enqueueCalls: [] as Array<{ accountId: string; submissionId: string }>,
  enqueueResult: true,
  scheduled: [] as Array<{ accountId?: string }>,
  schedulerThrows: false,
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

vi.mock("./notify", () => ({
  maybeEnqueueLeadNotification: async () => ({ enqueued: false, reason: "disabled" }),
}));

vi.mock("@/lib/lead-assignment/service", () => ({
  maybeAutoAssignLead: async () => ({ outcome: "no-rule", userId: null, ruleId: null }),
}));

vi.mock("@/lib/meta-lead-sheets/queue", () => ({
  maybeEnqueueSheetsSync: async (
    _db: unknown,
    args: { accountId: string; submissionId: string },
  ) => {
    h.enqueueCalls.push(args);
    return { enqueued: h.enqueueResult };
  },
}));

vi.mock("@/lib/meta-lead-sheets/trigger", () => ({
  scheduleSheetsDrainSoon: (opts: { accountId?: string } = {}) => {
    if (h.schedulerThrows) throw new Error("no request scope");
    h.scheduled.push(opts);
  },
}));

function makeDb() {
  function builder(table: string) {
    let op: "select" | "update" | "insert" = "select";
    let payload: Row = {};
    const filters: Array<[string, unknown, boolean]> = [];
    let inFilter: { col: string; vals: unknown[] } | null = null;

    const matched = () =>
      (h.tables[table] ?? []).filter(
        (r) =>
          filters.every(([c, v, negate]) =>
            negate ? r[c as string] !== v : r[c as string] === v,
          ) &&
          (!inFilter || (inFilter.vals as unknown[]).includes(r[inFilter.col])),
      );

    const apply = () => {
      if (op === "insert") {
        h.seq += 1;
        const row: Row = { id: `row-${h.seq}`, ...payload };
        (h.tables[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (op === "update") {
        const rows = matched();
        for (const row of rows) Object.assign(row, payload);
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
      eq: (c: string, v: unknown) => {
        filters.push([c, v, false] as never);
        return b;
      },
      neq: (c: string, v: unknown) => {
        filters.push([c, v, true] as never);
        return b;
      },
      in: (c: string, vals: unknown[]) => {
        inFilter = { col: c, vals };
        return b;
      },
      or: () => b,
      is: () => b,
      not: () => b,
      lte: () => b,
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

function seed() {
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
  };
  h.seq = 0;
  h.enqueueCalls = [];
  h.enqueueResult = true;
  h.scheduled = [];
  h.schedulerThrows = false;
}

beforeEach(seed);

describe("processSubmissionById → sheets prompt drain", () => {
  it("queues sheets sync and schedules a prompt drain for a newly processed lead", async () => {
    const db = makeDb();
    const res = await processSubmissionById(db, CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");

    // The shared path every discovery mechanism funnels through
    // (poll sweep, historical import, retry, webhook) enqueues…
    expect(h.enqueueCalls).toEqual([{ accountId: "acct-1", submissionId: "sub-1" }]);
    // …and schedules exactly one prompt, account-scoped drain.
    expect(h.scheduled).toEqual([{ accountId: "acct-1" }]);
  });

  it("redelivery schedules nothing extra", async () => {
    const db = makeDb();
    expect((await processSubmissionById(db, CONFIG, "sub-1")).outcome).toBe("processed");
    expect((await processSubmissionById(db, CONFIG, "sub-1")).outcome).toBe("skipped");
    expect(h.enqueueCalls).toHaveLength(1);
    expect(h.scheduled).toHaveLength(1);
  });

  it("schedules nothing when nothing new was queued", async () => {
    h.enqueueResult = false; // e.g. auto_sync off: enqueue is a skip
    const db = makeDb();
    const res = await processSubmissionById(db, CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");
    expect(h.enqueueCalls).toHaveLength(1);
    expect(h.scheduled).toHaveLength(0);
  });

  it("a throwing scheduler can never fail lead processing", async () => {
    h.schedulerThrows = true;
    const db = makeDb();
    const res = await processSubmissionById(db, CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");
    expect(h.tables.flow_runs).toHaveLength(1);
  });
});
