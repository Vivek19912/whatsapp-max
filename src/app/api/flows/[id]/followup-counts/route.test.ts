import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY_START = "2026-03-09T18:30:00.000Z"; // 2026-03-10 00:00 +05:30
const DAY_END = "2026-03-10T18:29:59.999Z";
const TMR_START = "2026-03-10T18:30:00.000Z"; // 2026-03-11 00:00 +05:30
const TMR_END = "2026-03-11T18:29:59.999Z";

const h = vi.hoisted(() => ({
  authed: true,
  accountId: "acct-1",
  userId: "user-1",
  flows: [{ id: "flow-1", account_id: "acct-1" }] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  fields: [
    { id: "f-fu", account_id: "acct-1", flow_id: "flow-1", name: "Next Follow-up Date & Time", field_type: "datetime" },
  ] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  tablesRead: [] as Array<string>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: "agent" };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
    return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status });
  },
}));

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    h.tablesRead.push(table);
    const filters: Filter[] = [];
    const store = (): Array<Record<string, unknown>> => {
      if (table === "flows") return h.flows;
      if (table === "flow_runs") return h.runs;
      if (table === "workspace_fields") return h.fields;
      if (table === "workspace_values") return h.values;
      if (table === "whatsapp_followups") throw new Error("must never read reminders");
      return [];
    };
    const matched = () =>
      store().filter((r) =>
        filters.every((f) => (f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]))),
      );
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters.push({ col, op: "eq", val });
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push({ col, op: "in", val: vals });
        return q;
      },
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
    };
    return q;
  };
  return api;
}

const { GET } = await import("./route");

function get(qs: string, flowId = "flow-1") {
  return new Request(
    `https://app.test/api/flows/${flowId}/followup-counts?todayStart=${DAY_START}&todayEnd=${DAY_END}&tomorrowStart=${TMR_START}&tomorrowEnd=${TMR_END}${qs}`,
  );
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function seed() {
  h.runs = [
    { id: "run-over", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-today", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-tmrw", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-future", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-empty", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-bad", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-other-flow", account_id: "acct-1", flow_id: "flow-9" },
  ];
  h.values = [
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-over", value_text: "2026-03-08T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-today", value_text: "2026-03-10T05:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-tmrw", value_text: "2026-03-11T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-future", value_text: "2026-03-20T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-empty", value_text: "   " },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-bad", value_text: "not-a-date" },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-other-flow", value_text: "2026-03-08T04:00:00.000Z" },
  ];
  // Standalone + workspace-linked reminders must never influence KPI counts.
  h.tablesRead = [];
}

beforeEach(() => {
  h.authed = true;
  h.accountId = "acct-1";
  seed();
});

describe("GET /api/flows/[id]/followup-counts", () => {
  it("buckets every matching lead across all records, not just the visible page", async () => {
    // 60 extra overdue leads on top of the 1 seeded above.
    for (let i = 0; i < 60; i += 1) {
      h.runs.push({ id: `run-bulk-${i}`, account_id: "acct-1", flow_id: "flow-1" });
      h.values.push({
        account_id: "acct-1",
        field_id: "f-fu",
        flow_run_id: `run-bulk-${i}`,
        value_text: "2026-03-01T04:00:00.000Z",
      });
    }
    const res = await GET(get(""), params("flow-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overdue: 61, today: 1, tomorrow: 1, upcoming: 2 });
  });

  it("excludes empty/invalid values and other tables; tomorrow stays in upcoming", async () => {
    const res = await GET(get(""), params("flow-1"));
    expect(await res.json()).toEqual({ overdue: 1, today: 1, tomorrow: 1, upcoming: 2 });
  });

  it("handles local midnight boundaries", async () => {
    h.values.push(
      { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-edge", value_text: DAY_END },
      { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-edge2", value_text: TMR_START },
    );
    h.runs.push(
      { id: "run-edge", account_id: "acct-1", flow_id: "flow-1" },
      { id: "run-edge2", account_id: "acct-1", flow_id: "flow-1" },
    );
    const res = await GET(get(""), params("flow-1"));
    expect(await res.json()).toEqual({ overdue: 1, today: 2, tomorrow: 2, upcoming: 3 });
  });

  it("never reads the standalone reminders table", async () => {
    await GET(get(""), params("flow-1"));
    expect(h.tablesRead).not.toContain("whatsapp_followups");
  });

  it("404s for another account's table (tenant isolation)", async () => {
    h.accountId = "acct-other";
    const res = await GET(get(""), params("flow-1"));
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    h.authed = false;
    const res = await GET(get(""), params("flow-1"));
    expect(res.status).toBe(401);
  });
});
