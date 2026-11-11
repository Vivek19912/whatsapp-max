import { beforeEach, describe, expect, it, vi } from "vitest";

const ACC = "acc-1";
const FLOW = "123e4567-e89b-12d3-a456-426614174010";
const FIELD = "123e4567-e89b-12d3-a456-426614174011";
const GAJANAN = "11111111-1111-4111-8111-111111111111";
const UTKARSH = "22222222-2222-4222-8222-222222222222";
const RUN_G = "123e4567-e89b-12d3-a456-426614174020";
const RUN_U = "123e4567-e89b-12d3-a456-426614174021";
const RUN_NOPHONE = "123e4567-e89b-12d3-a456-426614174022";
const CT_G = "123e4567-e89b-12d3-a456-426614174030";

const h = vi.hoisted(() => ({
  role: "agent" as string,
  userId: "11111111-1111-4111-8111-111111111111",
  grants: [] as Array<Record<string, unknown>>,
  flows: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<Record<string, unknown>>,
  convs: [] as Array<Record<string, unknown>>,
  subs: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
}));

function fakeSupabase() {
  const state = { table: "", eqs: [] as Array<[string, unknown]>, inList: [] as Array<[string, unknown[]]> };
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (col: string, val: unknown) => {
    state.eqs.push([col, val]);
    return builder;
  };
  builder.in = (col: string, vals: unknown[]) => {
    state.inList.push([col, vals]);
    return builder;
  };
  builder.order = () => builder;
  builder.limit = () => builder;
  const tableRows = (): Array<Record<string, unknown>> => {
    switch (state.table) {
      case "flows": return h.flows;
      case "workspace_fields": return h.fields;
      case "workspace_values": return h.values;
      case "flow_runs": return h.runs;
      case "contacts": return h.contacts;
      case "conversations": return h.convs;
      case "meta_lead_submissions": return h.subs;
      case "profiles": return h.profiles;
      case "agent_inbox_permissions": return h.grants;
      default: return [];
    }
  };
  const matched = () =>
    tableRows().filter(
      (r) =>
        state.eqs.every(([c, v]) => r[c] === v) &&
        state.inList.every(([c, vals]) => vals.includes(r[c] as string))
    );
  builder.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: matched(), error: null });
  return {
    from: (table: string) => {
      state.table = table;
      state.eqs = [];
      state.inList = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return builder as any;
    },
  };
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: ACC,
    userId: h.userId,
    role: h.role,
  }),
  toErrorResponse: (err: unknown) => {
    throw err;
  },
}));

import { GET } from "./route";

function seed() {
  h.flows = [{ id: FLOW, name: "Meta Form A", account_id: ACC, kind: "meta_lead_ads" }];
  h.fields = [{ id: FIELD, flow_id: FLOW, name: "Assigned To", account_id: ACC }];
  h.values = [
    { field_id: FIELD, flow_run_id: RUN_G, value_text: GAJANAN, account_id: ACC },
    { field_id: FIELD, flow_run_id: RUN_U, value_text: UTKARSH, account_id: ACC },
    { field_id: FIELD, flow_run_id: RUN_NOPHONE, value_text: GAJANAN, account_id: ACC },
  ];
  h.runs = [
    { id: RUN_G, flow_id: FLOW, contact_id: CT_G, vars: { full_name: "G Lead", phone_number: "+911111111111" }, started_at: "2026-11-01T10:00:00Z", status: "completed", account_id: ACC },
    { id: RUN_U, flow_id: FLOW, contact_id: "ct-u", vars: {}, started_at: "2026-11-02T10:00:00Z", status: "completed", account_id: ACC },
    { id: RUN_NOPHONE, flow_id: FLOW, contact_id: null, vars: { full_name: "No Phone", phone_number: "" }, started_at: "2026-11-03T10:00:00Z", status: "completed", account_id: ACC },
  ];
  h.contacts = [{ id: CT_G, name: "G Lead", phone: "+911111111111", email: null, account_id: ACC }];
  h.convs = [];
  h.subs = [
    { flow_run_id: RUN_G, form_name: "Form A", meta_created_time: "2026-11-01T09:00:00Z", created_at: "2026-11-01T09:00:00Z", field_data: [], account_id: ACC, status: "processed" },
  ];
  h.profiles = [
    { user_id: GAJANAN, full_name: "Gajanand Kumar", account_id: ACC },
    { user_id: UTKARSH, full_name: "Utkarsh", account_id: ACC },
  ];
  h.grants = [];
}

beforeEach(() => {
  h.role = "agent";
  h.userId = GAJANAN;
  seed();
});

async function getLeads(q?: string) {
  const res = await GET(new Request(`http://x/api/inbox/assigned-leads${q ? `?q=${q}` : ""}`));
  return (await res.json()) as { leads: Array<Record<string, unknown>> };
}

describe("GET /api/inbox/assigned-leads", () => {
  it("returns the agent's own lead-only entries, including null-contact runs", async () => {
    const { leads } = await getLeads();
    const ids = leads.map((l) => l.run_id).sort();
    expect(ids).toEqual([RUN_G, RUN_NOPHONE].sort());
    const gajan = leads.find((l) => l.run_id === RUN_G)!;
    expect(gajan.name).toBe("G Lead");
    expect(gajan.phone).toBe("+911111111111");
    expect(gajan.owner_id).toBe(GAJANAN);
    expect(gajan.owner_name).toBe("Gajanand Kumar");
    expect(gajan.form_name).toBe("Form A");
    // Null-contact lead renders from the stored run payload.
    expect(leads.find((l) => l.run_id === RUN_NOPHONE)?.name).toBe("No Phone");
  });

  it("never returns leads assigned to another agent", async () => {
    const { leads } = await getLeads();
    expect(leads.some((l) => l.run_id === RUN_U)).toBe(false);
    expect(leads.some((l) => l.owner_id === UTKARSH)).toBe(false);
  });

  it("excludes runs whose contact already has a conversation", async () => {
    h.convs = [{ contact_id: CT_G, assigned_agent_id: GAJANAN, account_id: ACC }];
    const { leads } = await getLeads();
    expect(leads.some((l) => l.run_id === RUN_G)).toBe(false);
    // The null-contact lead has no thread, so it stays.
    expect(leads.some((l) => l.run_id === RUN_NOPHONE)).toBe(true);
  });

  it("excludes Unassigned and non-UUID cells", async () => {
    h.values.push(
      { field_id: FIELD, flow_run_id: "run-x", value_text: "Unassigned", account_id: ACC },
      { field_id: FIELD, flow_run_id: "run-y", value_text: "Some External Name", account_id: ACC }
    );
    const { leads } = await getLeads();
    expect(leads.some((l) => l.run_id === "run-x")).toBe(false);
    expect(leads.some((l) => l.run_id === "run-y")).toBe(false);
  });

  it("never returns leads from another account (tampered scope)", async () => {
    h.values.push({
      field_id: FIELD,
      flow_run_id: RUN_U,
      value_text: "99999999-9999-4999-8999-999999999999",
      account_id: "acc-2",
    });
    h.runs.push({
      id: RUN_U,
      flow_id: FLOW,
      contact_id: "ct-u",
      vars: {},
      started_at: "2026-11-02T10:00:00Z",
      status: "completed",
      account_id: "acc-2",
    });
    const { leads } = await getLeads();
    expect(leads.some((l) => l.owner_id === "99999999-9999-4999-8999-999999999999")).toBe(false);
  });

  it("gives owners the account-wide assigned list", async () => {
    h.role = "owner";
    const { leads } = await getLeads();
    const ids = leads.map((l) => l.run_id).sort();
    expect(ids).toEqual([RUN_G, RUN_U, RUN_NOPHONE].sort());
  });

  it("honours the view_all grant for agents", async () => {
    h.grants = [{ account_id: ACC, user_id: GAJANAN, can_view_all: true }];
    const { leads } = await getLeads();
    expect(leads.some((l) => l.run_id === RUN_U)).toBe(true);
  });

  it("filters by name and phone with ?q=", async () => {
    h.role = "owner";
    expect((await getLeads("g lead")).leads.map((l) => l.run_id)).toEqual([RUN_G]);
    expect((await getLeads("911111111111")).leads.map((l) => l.run_id)).toEqual([RUN_G]);
    expect((await getLeads("no phone")).leads.map((l) => l.run_id)).toEqual([RUN_NOPHONE]);
    expect((await getLeads("zzz-no-match")).leads).toEqual([]);
  });
});
