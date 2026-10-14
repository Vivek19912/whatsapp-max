import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const SECRET = "wacrm_secret_123";
const BASE = "https://crm.example.com";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-1",
  flows: [] as Row[],
  flow_runs: [] as Row[],
  contacts: [] as Row[],
  flow_nodes: [] as Row[],
  workspace_fields: [] as Row[],
  workspace_values: [] as Row[],
  profiles: [] as Row[],
  accounts: [] as Row[],
  links: [] as Row[],
  flowSettings: [] as Row[],
  travelCalls: [] as Array<{ url: string; body: unknown }>,
  lookupsOverride: null as null | Record<string, unknown>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

function storeFor(table: string): Row[] {
  switch (table) {
    case "flows":
      return h.flows;
    case "flow_runs":
      return h.flow_runs;
    case "contacts":
      return h.contacts;
    case "flow_nodes":
      return h.flow_nodes;
    case "workspace_fields":
      return h.workspace_fields;
    case "workspace_values":
      return h.workspace_values;
    case "profiles":
      return h.profiles;
    case "accounts":
      return h.accounts;
    case "travel_crm_lead_links":
      return h.links;
    case "travel_crm_flow_settings":
      return h.flowSettings;
    default:
      return [];
  }
}

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    const matched = () => storeFor(table).filter((r) => filters.every((f) => f(r)));
    q.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    q.single = async () => {
      const hit = matched()[0] ?? null;
      return hit
        ? { data: hit, error: null }
        : { data: null, error: { message: "no row", code: "PGRST116" } };
    };
    q.then = (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null });
    q.insert = (obj: Row) => {
      const rows = storeFor(table);
      const dup = rows.find(
        (r) =>
          r.account_id === obj.account_id &&
          r.flow_run_id === obj.flow_run_id &&
          r.integration_type === obj.integration_type,
      );
      if (dup) {
        const err = { message: "duplicate", code: "23505" };
        return { select: () => ({ single: async () => ({ data: null, error: err }) }) };
      }
      const created = { id: `link-${rows.length + 1}`, external_lead_id: null, ...obj };
      rows.push(created);
      return {
        select: () => ({ single: async () => ({ data: created, error: null }) }),
      };
    };
    q.update = (patch: Row) => {
      const chain: Record<string, unknown> = {};
      chain.eq = () => chain;
      chain.then = (resolve: (v: unknown) => void) => {
        for (const r of matched()) Object.assign(r, patch);
        resolve({ error: null });
      };
      return chain;
    };
    return q;
  };
  return api;
}

const LOOKUPS = {
  leadSources: [{ value: "WHATSAPP", label: "WhatsApp" }],
  leadTypes: [{ value: "HOT", label: "Hot" }],
  leadStages: [{ value: "NEW_LEAD", label: "New" }],
  serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
};

function mockTravel() {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/integrations/wacrm/lookups")) {
      const data = h.lookupsOverride ?? LOOKUPS;
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    }
    if (u.endsWith("/api/integrations/wacrm/leads")) {
      const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
      h.travelCalls.push({ url: u, body });
      return new Response(
        JSON.stringify({ success: true, data: { leadId: "tcrm-xyz", alreadyExists: false } }),
        { status: 201 },
      );
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch);
}

const { POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/integrations/travel-crm/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VARS_NO_DATE = {
  destination: "Goa",
  city: "Panaji",
  nights: "3",
  adults: "2",
  service: "Flight",
};

function seed(vars: Record<string, string> = VARS_NO_DATE) {
  h.flows = [{ id: "flow-1", account_id: "acct-1" }];
  h.flow_runs = [
    {
      id: "run-1",
      flow_id: "flow-1",
      user_id: "u-creator",
      contact_id: "c-1",
      vars,
    },
  ];
  h.contacts = [{ id: "c-1", phone: "+911234567890", name: "Rahul Sharma", email: "a@b.co" }];
  h.flow_nodes = [];
  h.workspace_fields = [{ id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" }];
  h.workspace_values = [{ flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" }];
  h.accounts = [{ id: "acct-1", owner_user_id: "u-owner" }];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-agent", email: "agent@acme.com", full_name: "Agent" },
    { account_id: "acct-1", user_id: "u-owner", email: "owner@acme.com", full_name: "Owner" },
  ];
  h.links = [];
  h.flowSettings = [];
}

const FUNNEL = { leadSource: "WHATSAPP", leadType: "HOT", leadStage: "NEW_LEAD" };

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.travelCalls = [];
  h.lookupsOverride = null;
  seed();
  mockTravel();
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST month-based travel timing (Phase 3: enabled)", () => {
  it("a valid month/year pair creates with numeric timing and null date", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, travelMonth: 5, travelYear: 2027 },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ travelMonth: 5, travelYear: 2027 });
    expect(h.travelCalls[0].body).toMatchObject({ travelStartDate: null });
    expect(typeof (h.travelCalls[0].body as Record<string, unknown>).travelMonth).toBe("number");
    expect(typeof (h.travelCalls[0].body as Record<string, unknown>).travelYear).toBe("number");
  });

  it("numeric strings are accepted like the dialog sends", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, travelMonth: "5", travelYear: "2027" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ travelMonth: 5, travelYear: 2027 });
  });

  it("invalid month or year rejects without calling Travel CRM", async () => {
    for (const bad of [
      { travelMonth: 0, travelYear: 2027 },
      { travelMonth: 13, travelYear: 2027 },
      { travelMonth: 5, travelYear: 1899 },
      { travelMonth: 5, travelYear: 2101 },
      { travelMonth: "five", travelYear: 2027 },
    ]) {
      h.travelCalls = [];
      const res = await POST(
        post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: { ...FUNNEL, ...bad } }),
      );
      const json = (await res.json()) as { code: string; fields: Record<string, string[]> };
      expect(json.code).toBe("INVALID_OVERRIDES");
      expect(h.travelCalls).toHaveLength(0);
    }
  });

  it("a half pair (month without year) rejects without calling Travel CRM", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, travelMonth: 5 },
      }),
    );
    const json = (await res.json()) as { code: string; fields: Record<string, string[]> };
    expect(json.code).toBe("INVALID_OVERRIDES");
    expect(json.fields).toHaveProperty("travelMonth");
    expect(json.fields).toHaveProperty("travelYear");
    expect(h.travelCalls).toHaveLength(0);
  });

  it("an exact date plus a complete month/year pair rejects as conflicting", async () => {
    seed({ ...VARS_NO_DATE, travel_date: "2026-12-01" });
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, travelMonth: 5, travelYear: 2027 },
      }),
    );
    const json = (await res.json()) as { code: string; fields: Record<string, string[]> };
    expect(json.code).toBe("INVALID_OVERRIDES");
    expect(json.fields).toHaveProperty("travelStartDate");
    expect(h.travelCalls).toHaveLength(0);
  });

  it("exact-date creation is unchanged (date sent, month keys null)", async () => {
    seed({ ...VARS_NO_DATE, travel_date: "2026-12-01" });
    const res = await POST(
      post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      travelStartDate: "2026-12-01",
      travelMonth: null,
      travelYear: null,
    });
  });

  it("month mode with a full itinerary still maps destinations and cities", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, travelMonth: 12, travelYear: 2027 },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      travelMonth: 12,
      travelYear: 2027,
      itinerary: [{ country: "Goa", destination: "Panaji", nights: 3, sequence: 1 }],
    });
  });
});
