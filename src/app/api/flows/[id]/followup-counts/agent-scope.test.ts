import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: on Meta Lead Ads tables, agents count ONLY their own
// assigned leads; owner/admin keep workspace-wide totals.

const DAY_START = "2026-03-09T18:30:00.000Z";
const DAY_END = "2026-03-10T18:29:59.999Z";
const TMR_START = "2026-03-10T18:30:00.000Z";
const TMR_END = "2026-03-11T18:29:59.999Z";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-A",
  flowKind: "meta_lead_ads" as string | null,
  runs: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return {
      supabase: fakeSupabase(),
      accountId: h.accountId,
      userId: h.userId,
      role: h.role,
    };
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
    const filters: Filter[] = [];
    const store = (): Array<Record<string, unknown>> => {
      if (table === "flows")
        return [{ id: "flow-1", account_id: h.accountId, kind: h.flowKind }];
      if (table === "flow_runs") return h.runs;
      if (table === "workspace_fields") return h.fields;
      if (table === "workspace_values") return h.values;
      return [];
    };
    const matched = () =>
      store().filter((r) =>
        filters.every((f) =>
          f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
        ),
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

function get(flowId = "flow-1") {
  return new Request(
    `https://app.test/api/flows/${flowId}/followup-counts?todayStart=${DAY_START}&todayEnd=${DAY_END}&tomorrowStart=${TMR_START}&tomorrowEnd=${TMR_END}`,
  );
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function seed() {
  h.flowKind = "meta_lead_ads";
  h.runs = [
    { id: "run-a-over", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-a-today", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-b-over", account_id: "acct-1", flow_id: "flow-1" },
    { id: "run-b-future", account_id: "acct-1", flow_id: "flow-1" },
  ];
  h.fields = [
    { id: "f-fu", account_id: "acct-1", flow_id: "flow-1", name: "Next Follow-up Date & Time", field_type: "datetime" },
    { id: "f-as", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To", field_type: "single_select" },
  ];
  h.values = [
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-a-over", value_text: "2026-03-08T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-a-today", value_text: "2026-03-10T05:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-b-over", value_text: "2026-03-08T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu", flow_run_id: "run-b-future", value_text: "2026-03-20T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-as", flow_run_id: "run-a-over", value_text: "user-A" },
    { account_id: "acct-1", field_id: "f-as", flow_run_id: "run-a-today", value_text: "user-A" },
    { account_id: "acct-1", field_id: "f-as", flow_run_id: "run-b-over", value_text: "user-B" },
    { account_id: "acct-1", field_id: "f-as", flow_run_id: "run-b-future", value_text: "user-B" },
  ];
}

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-A";
  seed();
});

describe("GET /api/flows/[id]/followup-counts agent isolation", () => {
  it("Agent A counts only Agent A's assigned leads", async () => {
    h.userId = "user-A";
    h.role = "agent";
    const res = await GET(get(), params("flow-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overdue: 1, today: 1, tomorrow: 0, upcoming: 0 });
  });

  it("Agent B counts only Agent B's assigned leads", async () => {
    h.userId = "user-B";
    h.role = "agent";
    const res = await GET(get(), params("flow-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overdue: 1, today: 0, tomorrow: 0, upcoming: 1 });
  });

  it("owner keeps workspace-wide totals", async () => {
    h.userId = "owner-1";
    h.role = "owner";
    const res = await GET(get(), params("flow-1"));
    expect(await res.json()).toEqual({ overdue: 2, today: 1, tomorrow: 0, upcoming: 1 });
  });

  it("admin keeps workspace-wide totals", async () => {
    h.userId = "admin-1";
    h.role = "admin";
    const res = await GET(get(), params("flow-1"));
    expect(await res.json()).toEqual({ overdue: 2, today: 1, tomorrow: 0, upcoming: 1 });
  });

  it("Flow Tables keep existing behavior for agents (no assignment scoping)", async () => {
    h.flowKind = "flow_table";
    h.userId = "user-A";
    h.role = "agent";
    const res = await GET(get(), params("flow-1"));
    expect(await res.json()).toEqual({ overdue: 2, today: 1, tomorrow: 0, upcoming: 1 });
  });
});
