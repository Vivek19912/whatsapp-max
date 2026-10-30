import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY_START = "2026-03-09T18:30:00.000Z"; // 2026-03-10 00:00 IST
const DAY_END = "2026-03-10T18:29:59.999Z"; // 2026-03-10 23:59:59 IST

const h = vi.hoisted(() => ({
  authed: true,
  accountId: "acct-1",
  userId: "user-1",
  role: "agent",
  flows: [{ id: "flow-1", account_id: "acct-1" }] as Array<Record<string, unknown>>,
  runs: [
    { id: "run-over", account_id: "acct-1", flow_id: "flow-1", contact_id: "c-1", vars: {} },
    { id: "run-today", account_id: "acct-1", flow_id: "flow-1", contact_id: "c-2", vars: {} },
    { id: "run-future", account_id: "acct-1", flow_id: "flow-1", contact_id: null, vars: { full_name: "Var Lead", phone: "+919999999999" } },
    { id: "run-done", account_id: "acct-1", flow_id: "flow-1", contact_id: "c-1", vars: {} },
    { id: "run-other-flow", account_id: "acct-1", flow_id: "flow-9", contact_id: "c-1", vars: {} },
  ] as Array<Record<string, unknown>>,
  contacts: [
    { id: "c-1", account_id: "acct-1", name: "Asha", phone: "+91111" },
    { id: "c-2", account_id: "acct-1", name: "Rahul", phone: "+91222" },
  ] as Array<Record<string, unknown>>,
  conversations: [
    { id: "conv-1", account_id: "acct-1", contact_id: "c-1" },
  ] as Array<Record<string, unknown>>,
  fields: [
    { id: "f-assign", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To", field_type: "person" },
  ] as Array<Record<string, unknown>>,
  values: [
    { account_id: "acct-1", field_id: "f-assign", flow_run_id: "run-over", value_text: "user-1" },
    { account_id: "acct-1", field_id: "f-assign", flow_run_id: "run-done", value_text: "user-1" },
  ] as Array<Record<string, unknown>>,
  profiles: [
    { user_id: "user-1", account_id: "acct-1", full_name: "Asha Agent" },
  ] as Array<Record<string, unknown>>,
  reminders: [] as Array<Record<string, unknown>>,
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
  requireRole: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) => {
    const status = err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
    return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status });
  },
}));

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function fakeSupabase() {
  const state = { table: "", filters: [] as Filter[] };
  function rows(): Array<Record<string, unknown>> {
    if (state.table === "flows") return h.flows;
    if (state.table === "flow_runs") return h.runs;
    if (state.table === "contacts") return h.contacts;
    if (state.table === "conversations") return h.conversations;
    if (state.table === "workspace_fields") return h.fields;
    if (state.table === "workspace_values") return h.values;
    if (state.table === "profiles") return h.profiles;
    if (state.table === "whatsapp_followups") return h.reminders;
    return [];
  }
  const matched = () =>
    rows().filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      state.filters.push({ col, op: "in", val: vals });
      return api;
    },
    maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      return api;
    },
  };
}

const { GET } = await import("./route");

function seed() {
  h.reminders = [
    { id: "fu-over", account_id: "acct-1", status: "scheduled", scheduled_for: "2026-03-08T04:00:00.000Z", message_text: "m1", template_name: null, source_kind: "meta_workspace_followup", source_run_id: "run-over", followup_completed_at: null, followup_completed_by: null, sent_at: null, failed_at: null, cancelled_at: null, failure_reason: null },
    { id: "fu-today", account_id: "acct-1", status: "scheduled", scheduled_for: "2026-03-10T04:00:00.000Z", message_text: "m2", template_name: null, source_kind: "meta_workspace_followup", source_run_id: "run-today", followup_completed_at: null, followup_completed_by: null, sent_at: null, failed_at: null, cancelled_at: null, failure_reason: null },
    { id: "fu-future", account_id: "acct-1", status: "sent", scheduled_for: "2026-03-12T04:00:00.000Z", message_text: "m3", template_name: null, source_kind: "meta_workspace_followup", source_run_id: "run-future", followup_completed_at: null, followup_completed_by: null, sent_at: "2026-03-12T04:01:00.000Z", failed_at: null, cancelled_at: null, failure_reason: null },
    { id: "fu-done", account_id: "acct-1", status: "sent", scheduled_for: "2026-03-08T04:00:00.000Z", message_text: "m4", template_name: null, source_kind: "meta_workspace_followup", source_run_id: "run-done", followup_completed_at: "2026-03-09T02:00:00.000Z", followup_completed_by: "user-1", sent_at: "2026-03-08T04:01:00.000Z", failed_at: null, cancelled_at: null, failure_reason: null },
    { id: "fu-tmrw", account_id: "acct-1", status: "scheduled", scheduled_for: "2026-03-11T04:00:00.000Z", message_text: "m5", template_name: null, source_kind: "meta_workspace_followup", source_run_id: "run-today", followup_completed_at: null, followup_completed_by: null, sent_at: null, failed_at: null, cancelled_at: null, failure_reason: null },
    { id: "fu-tmrw-done", account_id: "acct-1", status: "sent", scheduled_for: "2026-03-11T05:00:00.000Z", message_text: "m6", template_name: null, source_kind: "meta_workspace_followup", source_run_id: "run-done", followup_completed_at: "2026-03-10T02:00:00.000Z", followup_completed_by: "user-1", sent_at: "2026-03-11T05:01:00.000Z", failed_at: null, cancelled_at: null, failure_reason: null },
    // Manual (non-linked) reminder must never appear in the table view.
    { id: "fu-manual", account_id: "acct-1", status: "scheduled", scheduled_for: "2026-03-08T04:00:00.000Z", message_text: "mm", template_name: null, source_kind: null, source_run_id: null, followup_completed_at: null, followup_completed_by: null, sent_at: null, failed_at: null, cancelled_at: null, failure_reason: null },
    // Other table's linked reminder must never appear here.
    { id: "fu-other", account_id: "acct-1", status: "scheduled", scheduled_for: "2026-03-08T04:00:00.000Z", message_text: "mo", template_name: null, source_kind: "meta_workspace_followup", source_run_id: "run-other-flow", followup_completed_at: null, followup_completed_by: null, sent_at: null, failed_at: null, cancelled_at: null, failure_reason: null },
  ];
}

function get(qs: string) {
  const url = `https://app.test/api/flows/flow-1/followups?${qs}&todayStart=${DAY_START}&todayEnd=${DAY_END}`;
  return new Request(url);
}
const params = { params: Promise.resolve({ id: "flow-1" }) };

beforeEach(() => {
  h.authed = true;
  h.accountId = "acct-1";
  seed();
});

describe("GET /api/flows/[id]/followups", () => {
  it("16/20. returns linked rows with buckets, counts, ordering; excludes manual + other-table rows", async () => {
    const res = await GET(get("bucket=all"), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; bucket: string; lead: { name: string | null }; assignee: { display: string } | null }>;
      counts: Record<string, number>;
      total: number;
    };
    expect(body.counts).toMatchObject({ all: 6, overdue: 1, today: 1, tomorrow: 1, upcoming: 2, completed: 2, pending: 4 });
    expect(body.items.map((i) => i.id)).toEqual(["fu-over", "fu-today", "fu-tmrw", "fu-future", "fu-tmrw-done", "fu-done"]);
    expect(body.items.map((i) => i.bucket)).toEqual(["overdue", "today", "upcoming", "upcoming", "completed", "completed"]);
    expect(body.total).toBe(6);
  });

  it("bucket + assignee + search filters are server-side", async () => {
    const overdue = (await (await GET(get("bucket=overdue"), params)).json()) as { items: Array<{ id: string }> };
    expect(overdue.items.map((i) => i.id)).toEqual(["fu-over"]);

    const mine = (await (await GET(get("bucket=all&assignee=user-1"), params)).json()) as { items: Array<{ id: string }> };
    expect(mine.items.map((i) => i.id).sort()).toEqual(["fu-done", "fu-over", "fu-tmrw-done"]);

    const unassigned = (await (await GET(get("bucket=all&assignee=unassigned"), params)).json()) as { items: Array<{ id: string }> };
    expect(unassigned.items.map((i) => i.id).sort()).toEqual(["fu-future", "fu-tmrw", "fu-today"]);

    const search = (await (await GET(get("bucket=all&q=rahul"), params)).json()) as { items: Array<{ id: string }> };
    expect(search.items.map((i) => i.id)).toEqual(["fu-today", "fu-tmrw"]);
  });

  it("lead falls back to row vars + conversation link resolves", async () => {
    const res = (await (await GET(get("bucket=upcoming"), params)).json()) as {
      items: Array<{ id: string; lead: { name: string | null; phone: string | null; conversationId: string | null } }>;
    };
    expect(res.items.find((i) => i.id === "fu-future")?.lead).toMatchObject({ name: "Var Lead", phone: "+919999999999", conversationId: null });
    const all = (await (await GET(get("bucket=all"), params)).json()) as {
      items: Array<{ id: string; lead: { conversationId: string | null }; assignee: { display: string } | null }>;
    };
    expect(all.items.find((i) => i.id === "fu-over")?.lead.conversationId).toBe("conv-1");
    expect(all.items.find((i) => i.id === "fu-over")?.assignee?.display).toBe("Asha Agent");
  });

  it("27/28. never leaks across accounts or tables", async () => {
    const res = await GET(get("bucket=all"), { params: Promise.resolve({ id: "flow-1" }) });
    expect(res.status).toBe(200);
    h.accountId = "acct-other";
    const missing = await GET(get("bucket=all"), { params: Promise.resolve({ id: "flow-1" }) });
    expect(missing.status).toBe(404);
  });

  it("tomorrow count + filter use the local day; upcoming stays unchanged", async () => {
    const tmrw = (await (await GET(get("bucket=tomorrow"), params)).json()) as {
      items: Array<{ id: string }>;
    };
    // Fallback path (no explicit tomorrow bounds): derived 24h after today.
    expect(tmrw.items.map((i) => i.id)).toEqual(["fu-tmrw"]);

    const explicit = (await (
      await GET(
        get("bucket=tomorrow&tomorrowStart=2026-03-10T18:30:00.000Z&tomorrowEnd=2026-03-11T18:29:59.999Z"),
        params,
      )
    ).json()) as { items: Array<{ id: string }> };
    expect(explicit.items.map((i) => i.id)).toEqual(["fu-tmrw"]);

    // Upcoming still includes tomorrow (subset, not replacement).
    const upcoming = (await (await GET(get("bucket=upcoming"), params)).json()) as {
      items: Array<{ id: string }>;
    };
    expect(upcoming.items.map((i) => i.id)).toEqual(["fu-tmrw", "fu-future"]);
  });
  it("sent-but-not-completed stays actionable (upcoming, not completed)", async () => {
    const res = (await (await GET(get("bucket=completed"), params)).json()) as { items: Array<{ id: string }> };
    expect(res.items.map((i) => i.id)).toEqual(["fu-tmrw-done", "fu-done"]);
    const upcoming = (await (await GET(get("bucket=upcoming"), params)).json()) as { items: Array<{ id: string }> };
    expect(upcoming.items.map((i) => i.id)).toEqual(["fu-tmrw", "fu-future"]);
  });
});
