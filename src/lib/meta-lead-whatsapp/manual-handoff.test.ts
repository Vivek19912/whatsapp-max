// Manual-assignment handoff — global vs. salesperson sequence
// arbitration for one Meta lead (see prepareManualAssigneeHandoff).
// Covers: no submission, no rows, pending cancellation (assignee
// rows ignored, tenant isolation), sent/in-flight suppression, the
// claim-between-scan-and-delete race, and post-cancel claim safety.
// No production I/O; the Meta API is never touched.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { cancelLateGlobalRows, prepareManualAssigneeHandoff } from "./queue";

type Row = Record<string, unknown>;
type Filter = { col: string; op: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.op === "eq" && row[f.col] !== f.val) return false;
    if (f.op === "is-null" && row[f.col] != null) return false;
    if (f.op === "in" && !(f.val as unknown[]).includes(row[f.col])) return false;
  }
  return true;
}

function makeDb(
  initial: Record<string, Row[]>,
  hooks: { onDeleteQueue?: () => void; onSecondQueueSelect?: () => void } = {},
) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }
  let queueSelects = 0;

  function builder(table: string) {
    const filters: Filter[] = [];
    let deleteMode = false;
    let updatePatch: Row | null = null;
    let selectCols = false;
    const b: Record<string, (...args: never[]) => unknown> = {
      select: (() => {
        if (table === "meta_lead_whatsapp_queue") {
          queueSelects += 1;
          if (queueSelects === 2 && hooks.onSecondQueueSelect) hooks.onSecondQueueSelect();
        }
        selectCols = true;
        return b;
      }) as never,
      eq: ((col: string, val: unknown) => {
        filters.push({ col, op: "eq", val });
        return b;
      }) as never,
      is: ((col: string, val: unknown) => {
        filters.push({ col, op: val === null ? "is-null" : "eq", val });
        return b;
      }) as never,
      in: ((col: string, val: unknown) => {
        filters.push({ col, op: "in", val });
        return b;
      }) as never,
      delete: (() => {
        deleteMode = true;
        if (table === "meta_lead_whatsapp_queue" && hooks.onDeleteQueue) hooks.onDeleteQueue();
        return b;
      }) as never,
      update: ((patch: Row) => {
        updatePatch = patch;
        return b;
      }) as never,
      maybeSingle: (async () => {
        if (updatePatch) {
          const list = (data[table] ?? []).filter((r) => matches(r, filters));
          for (const row of list) Object.assign(row, updatePatch);
          return { data: list[0] ?? null, error: null };
        }
        if (deleteMode) {
          const list = (data[table] ?? []).filter((r) => matches(r, filters));
          data[table] = (data[table] ?? []).filter((r) => !matches(r, filters));
          return { data: list[0] ?? null, error: null };
        }
        return { data: (data[table] ?? []).filter((r) => matches(r, filters))[0] ?? null, error: null };
      }) as never,
      then: ((res: (v: unknown) => unknown) => {
        if (updatePatch) {
          const list = (data[table] ?? []).filter((r) => matches(r, filters));
          for (const row of list) Object.assign(row, updatePatch);
          return Promise.resolve({ data: list, error: null }).then(res);
        }
        if (deleteMode) {
          const list = (data[table] ?? []).filter((r) => matches(r, filters));
          data[table] = (data[table] ?? []).filter((r) => !matches(r, filters));
          return Promise.resolve({ data: selectCols ? list : list, error: null }).then(res);
        }
        return Promise.resolve({
          data: (data[table] ?? []).filter((r) => matches(r, filters)),
          error: null,
        }).then(res);
      }) as never,
    };
    return b;
  }

  const db = { from: (t: string) => builder(t) } as unknown as SupabaseClient;
  return { db, data };
}

function globalRow(over: Partial<Row> = {}): Row {
  return {
    id: `q-${Math.random().toString(36).slice(2, 8)}`,
    account_id: "acct-1",
    submission_id: "sub-1",
    flow_run_id: "run-1",
    form_id: "form-1",
    template_name: "tpl",
    template_language: "en_US",
    position: 0,
    status: "pending",
    attempts: 0,
    max_attempts: 8,
    assignee_key: null,
    ...over,
  };
}

const BASE = {
  meta_lead_submissions: [
    { id: "sub-1", account_id: "acct-1", flow_run_id: "run-1", form_id: "form-1" },
  ],
};

describe("prepareManualAssigneeHandoff", () => {
  it("starts the assignee sequence when the lead has no submission", async () => {
    const { db } = makeDb({ meta_lead_submissions: [] });
    await expect(
      prepareManualAssigneeHandoff(db, { accountId: "acct-1", flowRunId: "run-1" }),
    ).resolves.toMatchObject({ decision: "start-assignee", reason: "no-submission", cancelled: 0 });
  });

  it("starts the assignee sequence when no global rows exist (assignee rows ignored)", async () => {
    const { db } = makeDb({
      ...BASE,
      meta_lead_whatsapp_queue: [
        globalRow({ id: "q-sp", template_name: "sp_tpl", assignee_key: "user:u-mohan" }),
      ],
    });
    await expect(
      prepareManualAssigneeHandoff(db, { accountId: "acct-1", flowRunId: "run-1" }),
    ).resolves.toMatchObject({ decision: "start-assignee", reason: "no-global-rows", cancelled: 0 });
  });

  it("deletes pending/failed global rows and starts the assignee sequence", async () => {
    const { db, data } = makeDb({
      ...BASE,
      meta_lead_whatsapp_queue: [
        globalRow({ id: "q-1", template_name: "a", status: "pending" }),
        globalRow({ id: "q-2", template_name: "b", status: "failed", attempts: 3 }),
        globalRow({ id: "q-3", template_name: "c", status: "failed", attempts: 8 }),
        globalRow({ id: "q-sp", template_name: "sp", assignee_key: "user:u-mohan" }),
        globalRow({ id: "q-other", template_name: "a", submission_id: "sub-9" }),
      ],
    });
    const out = await prepareManualAssigneeHandoff(db, {
      accountId: "acct-1",
      submissionId: "sub-1",
    });
    expect(out).toMatchObject({
      decision: "start-assignee",
      reason: "global-pending-cancelled",
      cancelled: 3,
      sent: 0,
    });
    // Only this lead's NULL-keyed rows are gone; the salesperson row,
    // other leads, and other accounts are untouched.
    expect((data.meta_lead_whatsapp_queue ?? []).map((r) => r.id).sort()).toEqual([
      "q-other",
      "q-sp",
    ]);
  });

  it("keeps the global sequence (cancelling nothing) when a global message already sent", async () => {
    const { db, data } = makeDb({
      ...BASE,
      meta_lead_whatsapp_queue: [
        globalRow({ id: "q-1", template_name: "a", status: "sent" }),
        globalRow({ id: "q-2", template_name: "b", status: "pending" }),
      ],
    });
    const out = await prepareManualAssigneeHandoff(db, {
      accountId: "acct-1",
      flowRunId: "run-1",
    });
    expect(out).toMatchObject({
      decision: "keep-global",
      reason: "global-already-sent",
      cancelled: 0,
      sent: 1,
    });
    expect(data.meta_lead_whatsapp_queue).toHaveLength(2);
  });

  it("keeps the global sequence when a global row is claimed/in-flight", async () => {
    const { db, data } = makeDb({
      ...BASE,
      meta_lead_whatsapp_queue: [
        globalRow({ id: "q-1", template_name: "a", status: "sending" }),
        globalRow({ id: "q-2", template_name: "b", status: "pending" }),
      ],
    });
    const out = await prepareManualAssigneeHandoff(db, {
      accountId: "acct-1",
      flowRunId: "run-1",
    });
    expect(out).toMatchObject({ decision: "keep-global", reason: "global-in-flight" });
    expect(data.meta_lead_whatsapp_queue).toHaveLength(2);
  });

  it("a worker claim between scan and delete wins (no second sequence)", async () => {
    const initial = {
      ...BASE,
      meta_lead_whatsapp_queue: [
        globalRow({ id: "q-1", template_name: "a", status: "pending" }),
        globalRow({ id: "q-2", template_name: "b", status: "pending" }),
      ],
    };
    // Flip q-1 to sending right as the handoff issues its delete —
    // the conditional delete spares it, and the re-select catches it.
    const { db, data } = makeDb(initial, {
      onDeleteQueue: () => {
        const row = (data.meta_lead_whatsapp_queue ?? []).find((r) => r.id === "q-1");
        if (row) row.status = "sending";
      },
    });
    const out = await prepareManualAssigneeHandoff(db, {
      accountId: "acct-1",
      flowRunId: "run-1",
    });
    expect(out).toMatchObject({
      decision: "keep-global",
      reason: "global-send-raced",
      cancelled: 1,
    });
    // The claimed row survived; the other pending row was cancelled.
    expect((data.meta_lead_whatsapp_queue ?? []).map((r) => r.id)).toEqual(["q-1"]);
  });

  it("a worker cannot claim rows after they were cancelled", async () => {
    const { db, data } = makeDb({
      ...BASE,
      meta_lead_whatsapp_queue: [globalRow({ id: "q-1", status: "pending" })],
    });
    const out = await prepareManualAssigneeHandoff(db, {
      accountId: "acct-1",
      flowRunId: "run-1",
    });
    expect(out.decision).toBe("start-assignee");
    // Drain-style conditional claim against the deleted row: no-op.
    const claimed = await (db as unknown as {
      from: (t: string) => {
        update: (p: Row) => {
          eq: (c: string, v: unknown) => {
            in: (c: string, v: unknown) => {
              select: (c: string) => { maybeSingle: () => Promise<{ data: unknown }> };
            };
          };
        };
      };
    })
      .from("meta_lead_whatsapp_queue")
      .update({ status: "sending" })
      .eq("id", "q-1")
      .in("status", ["pending", "failed"])
      .select("id")
      .maybeSingle();
    expect(claimed.data).toBeNull();
    expect(data.meta_lead_whatsapp_queue).toHaveLength(0);
  });

  it("leaves other accounts and submissions untouched", async () => {
    const { db, data } = makeDb({
      ...BASE,
      meta_lead_whatsapp_queue: [
        globalRow({ id: "q-mine", status: "pending" }),
        globalRow({ id: "q-acct", status: "pending", account_id: "acct-9" }),
        globalRow({ id: "q-sub", status: "pending", submission_id: "sub-9" }),
      ],
    });
    const out = await prepareManualAssigneeHandoff(db, {
      accountId: "acct-1",
      submissionId: "sub-1",
    });
    expect(out).toMatchObject({ decision: "start-assignee", cancelled: 1 });
    expect((data.meta_lead_whatsapp_queue ?? []).map((r) => r.id).sort()).toEqual([
      "q-acct",
      "q-sub",
    ]);
  });
});

describe("cancelLateGlobalRows", () => {
  it("deletes late pending/failed arrivals and reports remaining sends", async () => {
    const { db, data } = makeDb({
      meta_lead_whatsapp_queue: [
        globalRow({ id: "q-1", status: "pending" }),
        globalRow({ id: "q-2", status: "failed", attempts: 2 }),
        globalRow({ id: "q-sp", assignee_key: "user:u-mohan" }),
      ],
    });
    const out = await cancelLateGlobalRows(db, { accountId: "acct-1", submissionId: "sub-1" });
    expect(out).toEqual({ cancelled: 2, sent: 0, sending: 0 });
    expect((data.meta_lead_whatsapp_queue ?? []).map((r) => r.id)).toEqual(["q-sp"]);
  });

  it("never touches sent or in-flight rows, and reports them", async () => {
    const { db, data } = makeDb({
      meta_lead_whatsapp_queue: [
        globalRow({ id: "q-1", status: "sent" }),
        globalRow({ id: "q-2", status: "sending" }),
        globalRow({ id: "q-3", status: "pending" }),
      ],
    });
    const out = await cancelLateGlobalRows(db, { accountId: "acct-1", submissionId: "sub-1" });
    expect(out).toEqual({ cancelled: 1, sent: 1, sending: 1 });
    expect((data.meta_lead_whatsapp_queue ?? []).map((r) => r.id).sort()).toEqual([
      "q-1",
      "q-2",
    ]);
  });
});
