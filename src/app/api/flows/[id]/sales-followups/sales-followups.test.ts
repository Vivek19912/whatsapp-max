import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listAttempts, POST as scheduleAttempt } from "./route";
import { PATCH as rescheduleAttempt } from "./[attemptId]/route";
import { POST as saveResult } from "./[attemptId]/result/route";
import {
  DELETE as reopenSequence,
  POST as closeSequence,
} from "./closure/route";

// ---------------------------------------------------------------------------
// Sequential sales-followups API: backend enforcement of the
// schedule → result → schedule rule. Supabase is an in-memory
// store behind a thenable builder honoring the exact chains the
// routes build; auth is requireRole (agent+) with controllable
// assignment. Proves: 409s on bypass attempts, numbering from
// history, no duplicate results, close/reopen rules, cell mirroring.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  userId: "user-1",
  role: "agent",
  owned: true,
  failNextInsert: null as { code: string } | null,
  store: {} as Record<string, Array<Record<string, unknown>>>,
  idSeq: 1,
}));

vi.mock("@/lib/auth/account", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/auth/account")>();
  return {
    ...mod,
    requireRole: async () => ({
      supabase: mockClient(),
      userId: h.userId,
      accountId: "acct-1",
      role: h.role,
    }),
  };
});

vi.mock("@/lib/flows/workspace-ownership", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/flows/workspace-ownership")>();
  return { ...mod, isRunOwnedByUser: async () => h.owned };
});

type Filter = { col: string; op: "eq" | "is"; val: unknown };

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) =>
    f.op === "eq" ? row[f.col] === f.val : row[f.col] === f.val,
  );
}

function mockClient() {
  const from = (table: string) => {
    const filters: Filter[] = [];
    let orderCol = "";
    let orderAsc = true;
    let write:
      | { kind: "insert"; rows: Array<Record<string, unknown>> }
      | { kind: "update"; patch: Record<string, unknown> }
      | { kind: "upsert"; row: Record<string, unknown>; conflict: string[] }
      | { kind: "delete" }
      | null = null;
    const rows = () => (h.store[table] ??= []);
    const filtered = () => {
      const out = rows().filter((r) => matches(r, filters));
      if (orderCol) {
        out.sort((a, b) =>
          orderAsc
            ? Number(a[orderCol]) - Number(b[orderCol])
            : Number(b[orderCol]) - Number(a[orderCol]),
        );
      }
      return out;
    };
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push({ col, op: "eq", val });
        return api;
      },
      is: (col: string, val: unknown) => {
        filters.push({ col, op: "is", val });
        return api;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return api;
      },
      insert: (payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
        write = { kind: "insert", rows: Array.isArray(payload) ? payload : [payload] };
        return api;
      },
      update: (patch: Record<string, unknown>) => {
        write = { kind: "update", patch };
        return api;
      },
      upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) => {
        write = {
          kind: "upsert",
          row,
          conflict: (opts?.onConflict ?? "").split(","),
        };
        return api;
      },
      delete: () => {
        write = { kind: "delete" };
        return api;
      },
      maybeSingle: async () => exec("maybeSingle"),
      single: async () => exec("single"),
      then: (resolve: (v: unknown) => void) => exec("many").then(resolve),
    };
    async function exec(mode: "many" | "single" | "maybeSingle") {
      if (write?.kind === "insert") {
        if (h.failNextInsert) {
          const err = h.failNextInsert;
          h.failNextInsert = null;
          return { data: null, error: err };
        }
        // Postgres supplies NULL column defaults; the in-memory
        // store must too or `completed_at === null` guards diverge.
        const nullDefaults =
          table === "sales_followup_attempts"
            ? {
                outcome: null,
                result_text: null,
                completed_by: null,
                completed_at: null,
                rescheduled_from: null,
                rescheduled_at: null,
                rescheduled_by: null,
              }
            : {};
        const inserted = write.rows.map((r) => ({ ...nullDefaults, ...r, id: `id-${h.idSeq++}` }));
        rows().push(...inserted);
        const out = mode === "many" ? inserted : (inserted[0] ?? null);
        return { data: out, error: null };
      }
      if (write?.kind === "update") {
        const hit = filtered();
        for (const r of hit) Object.assign(r, write.patch);
        const out = mode === "many" ? hit : (hit[0] ?? null);
        if (mode !== "maybeSingle" && !out) {
          return { data: null, error: { code: "PGRST116", message: "none" } };
        }
        return { data: out, error: null };
      }
      if (write?.kind === "upsert") {
        const hit = rows().find((r) =>
          write != null &&
          write.kind === "upsert" &&
          write.conflict.every((c) => r[c] === (write as { row: Record<string, unknown> }).row[c]),
        );
        if (hit) Object.assign(hit, (write as { row: Record<string, unknown> }).row);
        else rows().push({ ...(write as { row: Record<string, unknown> }).row, id: `id-${h.idSeq++}` });
        const target = hit ?? rows()[rows().length - 1];
        return { data: mode === "many" ? [target] : target, error: null };
      }
      if (write?.kind === "delete") {
        h.store[table] = rows().filter((r) => !matches(r, filters));
        return { data: mode === "many" ? [] : null, error: null };
      }
      const hit = filtered();
      if (mode === "many") return { data: hit, error: null };
      const one = hit[0] ?? null;
      if (mode === "single" && !one) {
        return { data: null, error: { code: "PGRST116", message: "none" } };
      }
      return { data: one, error: null };
    }
    return api;
  };
  return { from };
}

const FUTURE = "2099-06-15T10:30:00.000Z";
const PAST = "2000-01-02T10:30:00.000Z";

function seed() {
  h.store = {
    flows: [{ id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads" }],
    flow_runs: [{ id: "run-1", account_id: "acct-1", flow_id: "flow-1" }],
    workspace_fields: [
      { id: "f-dt", account_id: "acct-1", flow_id: "flow-1", name: "Next Follow-up Date & Time", field_type: "datetime", options: null },
      { id: "f-na", account_id: "acct-1", flow_id: "flow-1", name: "Next Action", field_type: "text", options: null },
      { id: "f-lc", account_id: "acct-1", flow_id: "flow-1", name: "Last Contact Date", field_type: "date", options: null },
      { id: "f-cr", account_id: "acct-1", flow_id: "flow-1", name: "Customer Response", field_type: "text", options: null },
    ],
    workspace_values: [],
    sales_followup_attempts: [],
    sales_followup_closures: [],
  };
  h.idSeq = 1;
  h.userId = "user-1";
  h.role = "agent";
  h.owned = true;
  h.failNextInsert = null;
}

const params = { id: "flow-1" } as unknown as Promise<{ id: string }>;
const attemptParams = (attemptId: string) =>
  ({ id: "flow-1", attemptId }) as unknown as Promise<{ id: string; attemptId: string }>;

async function postSchedule(runId = "run-1", scheduledFor: unknown = FUTURE) {
  const req = new Request("http://x/api", {
    method: "POST",
    body: JSON.stringify({ flow_run_id: runId, scheduled_for: scheduledFor }),
  });
  return scheduleAttempt(req, { params });
}

async function postResult(attemptId: string, outcome: string | null = "No Answer", text = "Rang twice, no pickup.") {
  const req = new Request("http://x/api", {
    method: "POST",
    body: JSON.stringify({ flow_run_id: "run-1", outcome, result_text: text }),
  });
  return saveResult(req, { params: attemptParams(attemptId) });
}

async function getState() {
  const req = new Request("http://x/api?flow_run_id=run-1");
  const res = await listAttempts(req, { params });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function cellValue(fieldId: string): string | null {
  const row = h.store.workspace_values.find(
    (r) => r.field_id === fieldId && r.flow_run_id === "run-1",
  );
  return row ? String(row.value_text) : null;
}

beforeEach(seed);

describe("scheduling guards", () => {
  it("rejects missing runs, foreign leads, and unassigned agents", async () => {
    expect((await postSchedule("")).status).toBe(400);
    expect((await postSchedule("run-404")).status).toBe(404);
    h.owned = false;
    expect((await postSchedule()).status).toBe(404);
    h.owned = true;
  });

  it("rejects past scheduling", async () => {
    const res = await postSchedule("run-1", PAST);
    expect(res.status).toBe(422);
  });

  it("creates attempt 1 and mirrors the Workspace cells", async () => {
    const res = await postSchedule();
    expect(res.status).toBe(201);
    const json = (await res.json()) as { attempt: { attempt_number: number; created_by: string } };
    expect(json.attempt.attempt_number).toBe(1);
    expect(json.attempt.created_by).toBe("user-1");
    expect(cellValue("f-dt")).toBe(FUTURE);
    // No redundant scheduled-status text in Next Action.
    expect(cellValue("f-na")).toBeNull();
  });

  it("clears stale system Next Action text but preserves user-entered actions", async () => {
    const seedCell = (text: string) => {
      h.store.workspace_values.push({
        id: "id-cell",
        account_id: "acct-1",
        field_id: "f-na",
        flow_run_id: "run-1",
        value_text: text,
      });
    };
    seedCell("Call Ravi Tuesday");
    expect((await postSchedule()).status).toBe(201);
    expect(cellValue("f-na")).toBe("Call Ravi Tuesday");
  });

  it("replaces a leftover scheduled-status string with empty", async () => {
    h.store.workspace_values.push({
      id: "id-cell",
      account_id: "acct-1",
      field_id: "f-na",
      flow_run_id: "run-1",
      value_text: "Schedule First Follow-up",
    });
    expect((await postSchedule()).status).toBe(201);
    expect(cellValue("f-na")).toBeNull();
  });

  it("refuses a second schedule while one is unresolved", async () => {
    await postSchedule();
    const res = await postSchedule();
    expect(res.status).toBe(409);
  });

  it("retries once on a numbering race, then surfaces the winner", async () => {
    await postSchedule();
    h.failNextInsert = { code: "23505" };
    // A concurrent open attempt landed first: the retry must 409, not duplicate.
    h.store.sales_followup_attempts.push({
      id: "id-racer",
      account_id: "acct-1",
      flow_id: "flow-1",
      flow_run_id: "run-1",
      attempt_number: 2,
      scheduled_at: FUTURE,
      outcome: null,
      result_text: null,
      created_by: "user-2",
      created_at: FUTURE,
      completed_at: null,
      completed_by: null,
      rescheduled_from: null,
      rescheduled_at: null,
      rescheduled_by: null,
      origin: "scheduled",
    });
    const res = await postSchedule();
    expect(res.status).toBe(409);
  });

  it("schedules without Workspace columns present (cells best-effort)", async () => {
    h.store.workspace_fields = [];
    const res = await postSchedule();
    expect(res.status).toBe(201);
  });
});

describe("result guards", () => {
  it("validates outcome and text before touching history", async () => {
    const first = await postSchedule();
    const id = ((await first.json()) as { attempt: { id: string } }).attempt.id;
    expect((await postResult(id, "Maybe later", "note")).status).toBe(422);
    expect((await postResult(id, "Busy", "   ")).status).toBe(422);
    expect(h.store.sales_followup_attempts[0].completed_at).toBeNull();
  });

  it("completes the attempt, advances cells, and unlocks the next number", async () => {
    const first = await postSchedule();
    const id = ((await first.json()) as { attempt: { id: string } }).attempt.id;
    const res = await postResult(id);
    expect(res.status).toBe(200);
    const row = h.store.sales_followup_attempts[0];
    expect(row.completed_by).toBe("user-1");
    expect(row.outcome).toBe("No Answer");
    // Pending datetime cleared; completion day written. Customer
    // Response is NEVER touched — results live in the attempt row
    // and render in Follow-up N Result columns. Next Action is left
    // entirely alone (no generated scheduling text).
    expect(cellValue("f-dt")).toBeNull();
    expect(cellValue("f-lc")).not.toBeNull();
    expect(cellValue("f-cr")).toBeNull();
    expect(cellValue("f-na")).toBeNull();
    const state = await getState();
    expect((state.json.state as { kind: string }).kind).toBe("completed");
    expect((state.json.state as { nextAttemptNumber: number }).nextAttemptNumber).toBe(2);
  });

  it("saves results without an outcome and preserves user Next Action text", async () => {
    h.store.workspace_values.push({
      id: "id-cell",
      account_id: "acct-1",
      field_id: "f-na",
      flow_run_id: "run-1",
      value_text: "Call Ravi Tuesday",
    });
    const first = await postSchedule();
    const id = ((await first.json()) as { attempt: { id: string } }).attempt.id;
    const res = await postResult(id, null, "Shared itinerary.");
    expect(res.status).toBe(200);
    const row = h.store.sales_followup_attempts[0];
    expect(row.outcome).toBeNull();
    expect(row.result_text).toBe("Shared itinerary.");
    expect(row.completed_at).not.toBeNull();
    expect(cellValue("f-na")).toBe("Call Ravi Tuesday");
  });

  it("rejects duplicate results without overwriting history", async () => {
    const first = await postSchedule();
    const id = ((await first.json()) as { attempt: { id: string } }).attempt.id;
    await postResult(id, "No Answer", "First note.");
    const dup = await postResult(id, "Busy", "Second note.");
    expect(dup.status).toBe(409);
    expect(h.store.sales_followup_attempts[0].result_text).toBe("First note.");
  });

  it("404s unknown attempts", async () => {
    expect((await postResult("id-nope")).status).toBe(409);
  });
});

describe("sequential numbering without limit", () => {
  it("walks attempts 1..6 with enforced result gates", async () => {
    for (let n = 1; n <= 6; n++) {
      const scheduled = await postSchedule();
      expect(scheduled.status).toBe(201);
      const scheduledJson = (await scheduled.json()) as {
        attempt: { id: string; attempt_number: number };
      };
      const id = scheduledJson.attempt.id;
      expect(scheduledJson.attempt.attempt_number).toBe(n);
      // Gate holds mid-sequence too.
      if (n === 3) {
        expect((await postSchedule()).status).toBe(409);
      }
      expect((await postResult(id)).status).toBe(200);
    }
    const state = await getState();
    expect((state.json.state as { nextAttemptNumber: number }).nextAttemptNumber).toBe(7);
    expect(h.store.sales_followup_attempts).toHaveLength(6);
  });
});

describe("reschedule rules", () => {
  it("moves a future attempt in place with audit", async () => {
    const first = await postSchedule();
    const id = ((await first.json()) as { attempt: { id: string } }).attempt.id;
    const req = new Request("http://x/api", {
      method: "PATCH",
      body: JSON.stringify({ flow_run_id: "run-1", scheduled_for: "2099-07-01T09:00:00.000Z" }),
    });
    const res = await rescheduleAttempt(req, { params: attemptParams(id) });
    expect(res.status).toBe(200);
    const row = h.store.sales_followup_attempts[0];
    expect(row.scheduled_at).toBe("2099-07-01T09:00:00.000Z");
    expect(row.rescheduled_from).toBe(FUTURE);
    expect(row.rescheduled_by).toBe("user-1");
    expect(cellValue("f-dt")).toBe("2099-07-01T09:00:00.000Z");
    // Same attempt, no duplicate.
    expect(h.store.sales_followup_attempts).toHaveLength(1);
  });

  it("refuses to move due or completed attempts", async () => {
    const first = await postSchedule();
    const id = ((await first.json()) as { attempt: { id: string } }).attempt.id;
    h.store.sales_followup_attempts[0].scheduled_at = PAST;
    const dueReq = new Request("http://x/api", {
      method: "PATCH",
      body: JSON.stringify({ flow_run_id: "run-1", scheduled_for: FUTURE }),
    });
    expect((await rescheduleAttempt(dueReq, { params: attemptParams(id) })).status).toBe(409);
    await postResult(id);
    const doneReq = new Request("http://x/api", {
      method: "PATCH",
      body: JSON.stringify({ flow_run_id: "run-1", scheduled_for: FUTURE }),
    });
    expect((await rescheduleAttempt(doneReq, { params: attemptParams(id) })).status).toBe(409);
  });
});

describe("closure rules", () => {
  async function close() {
    const req = new Request("http://x/api", {
      method: "POST",
      body: JSON.stringify({ flow_run_id: "run-1" }),
    });
    return closeSequence(req, { params });
  }

  it("refuses to close around an open attempt", async () => {
    await postSchedule();
    expect((await close()).status).toBe(409);
    expect(h.store.sales_followup_closures).toHaveLength(0);
  });

  it("closes clean sequences, blocks scheduling, and reopens", async () => {
    const first = await postSchedule();
    const id = ((await first.json()) as { attempt: { id: string } }).attempt.id;
    await postResult(id);
    expect((await close()).status).toBe(201);
    expect((await close()).status).toBe(409);
    expect((await postSchedule()).status).toBe(409);
    expect(cellValue("f-na")).toBe("View Follow-up History");
    const reopenReq = new Request("http://x/api?flow_run_id=run-1", { method: "DELETE" });
    expect((await reopenSequence(reopenReq, { params })).status).toBe(200);
    expect((await postSchedule()).status).toBe(201);
  });
});

describe("derived states", () => {
  it("reports none → scheduled → result_required across time", async () => {
    expect(((await getState()).json.state as { kind: string }).kind).toBe("none");
    await postSchedule("run-1", "2099-01-01T00:00:00.000Z");
    expect(((await getState()).json.state as { kind: string }).kind).toBe("scheduled");
    h.store.sales_followup_attempts[0].scheduled_at = PAST;
    const due = await getState();
    expect((due.json.state as { kind: string }).kind).toBe("result_required");
    expect(
      (due.json.state as { activeAttempt: { attempt_number: number } }).activeAttempt
        .attempt_number,
    ).toBe(1);
  });
});
