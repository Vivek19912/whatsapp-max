import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY_START = "2026-03-09T18:30:00.000Z"; // 2026-03-10 00:00 +05:30
const DAY_END = "2026-03-10T18:29:59.999Z";
const TMR_START = "2026-03-10T18:30:00.000Z"; // 2026-03-11 00:00 +05:30
const TMR_END = "2026-03-11T18:29:59.999Z";

const h = vi.hoisted(() => ({
  authed: true,
  accountId: "acct-1",
  userId: "user-1",
  role: "owner" as string,
  restricted: false,
  flows: [
    { id: "flow-a", account_id: "acct-1", kind: "meta_lead_ads" },
    { id: "flow-b", account_id: "acct-1", kind: "meta_lead_ads" },
    { id: "flow-other-acct", account_id: "acct-2", kind: "meta_lead_ads" },
    { id: "flow-conv", account_id: "acct-1", kind: "whatsapp_flow" },
  ] as Array<Record<string, unknown>>,
  fields: [
    { id: "f-fu-a", account_id: "acct-1", flow_id: "flow-a", name: "Next Follow-up Date & Time", field_type: "datetime" },
    { id: "f-as-a", account_id: "acct-1", flow_id: "flow-a", name: "Assigned To", field_type: "single_select" },
    { id: "f-fu-b", account_id: "acct-1", flow_id: "flow-b", name: "Next Follow-up Date & Time", field_type: "datetime" },
    { id: "f-as-b", account_id: "acct-1", flow_id: "flow-b", name: "Assigned To", field_type: "single_select" },
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
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
    return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status });
  },
}));

vi.mock("@/lib/inbox/assignment-access", () => ({
  resolveWorkspaceVisibility: async () => ({ restricted: h.restricted }),
}));

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    h.tablesRead.push(table);
    const filters: Filter[] = [];
    const store = (): Array<Record<string, unknown>> => {
      if (table === "flows") return h.flows;
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

function get(qs = "") {
  return new Request(
    `https://app.test/api/workspace/all-meta-leads/followup-counts?todayStart=${DAY_START}&todayEnd=${DAY_END}&tomorrowStart=${TMR_START}&tomorrowEnd=${TMR_END}${qs}`,
  );
}

function seed() {
  h.values = [
    // flow-a: one per bucket + blanks
    { account_id: "acct-1", field_id: "f-fu-a", flow_run_id: "run-a-over", value_text: "2026-03-08T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu-a", flow_run_id: "run-a-today", value_text: "2026-03-10T05:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu-a", flow_run_id: "run-a-empty", value_text: "   " },
    { account_id: "acct-1", field_id: "f-fu-a", flow_run_id: "run-a-bad", value_text: "not-a-date" },
    // flow-b: tomorrow + far future + non-meta flow value (ignored: no field row for it)
    { account_id: "acct-1", field_id: "f-fu-b", flow_run_id: "run-b-tmrw", value_text: "2026-03-11T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu-b", flow_run_id: "run-b-future", value_text: "2026-03-20T04:00:00.000Z" },
    { account_id: "acct-1", field_id: "f-fu-other", flow_run_id: "run-x", value_text: "2026-03-08T04:00:00.000Z" },
  ];
  h.tablesRead = [];
}

beforeEach(() => {
  h.authed = true;
  h.accountId = "acct-1";
  h.role = "owner";
  h.restricted = false;
  seed();
});

describe("GET /api/workspace/all-meta-leads/followup-counts", () => {
  it("aggregates buckets across every Meta table in the account", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overdue: 1, today: 1, tomorrow: 1, upcoming: 2 });
  });

  it("excludes empty/invalid values and non-Meta fields; tomorrow stays in upcoming", async () => {
    const res = await GET(get());
    expect(await res.json()).toEqual({ overdue: 1, today: 1, tomorrow: 1, upcoming: 2 });
  });

  it("never reads the standalone reminders table", async () => {
    await GET(get());
    expect(h.tablesRead).not.toContain("whatsapp_followups");
  });

  it("counts only the caller's own assigned leads for restricted agents", async () => {
    h.role = "agent";
    h.restricted = true;
    h.values.push(
      { account_id: "acct-1", field_id: "f-as-a", flow_run_id: "run-a-over", value_text: "user-1" },
      { account_id: "acct-1", field_id: "f-as-b", flow_run_id: "run-b-future", value_text: "user-1" },
      { account_id: "acct-1", field_id: "f-as-a", flow_run_id: "run-a-today", value_text: "user-2" },
    );
    const res = await GET(get());
    expect(await res.json()).toEqual({ overdue: 1, today: 0, tomorrow: 0, upcoming: 1 });
  });

  it("counts every assigned lead for agents with View All", async () => {
    h.role = "agent";
    h.restricted = false;
    const res = await GET(get());
    expect(await res.json()).toEqual({ overdue: 1, today: 1, tomorrow: 1, upcoming: 2 });
  });

  it("returns zeros when no follow-up column exists on any Meta table", async () => {
    h.fields = h.fields.filter((f) => f.name !== "Next Follow-up Date & Time");
    const res = await GET(get());
    expect(await res.json()).toEqual({ overdue: 0, today: 0, tomorrow: 0, upcoming: 0 });
  });

  it("401s when unauthenticated", async () => {
    h.authed = false;
    const res = await GET(get());
    expect(res.status).toBe(401);
  });
});
