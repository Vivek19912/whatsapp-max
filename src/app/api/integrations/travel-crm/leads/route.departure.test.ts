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
  leadTypes: [{ value: "FRESH", label: "Fresh" }],
  leadStages: [{ value: "NEW_LEAD", label: "New Lead" }],
  serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
  destinations: [
    { value: "India", label: "Country One" },
    { value: "United Arab Emirates", label: "Country Two" },
  ],
  cities: [
    { value: "Delhi", label: "City One A", destinationValue: "India" },
    { value: "Dubai", label: "City Two A", destinationValue: "United Arab Emirates" },
  ],
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

function seed() {
  h.flows = [{ id: "flow-1", account_id: "acct-1" }];
  h.flow_runs = [
    {
      id: "run-1",
      flow_id: "flow-1",
      user_id: "u-creator",
      contact_id: "c-1",
      vars: {
        travel_date: "2026-12-01",
        destination: "Goa",
        city: "Panaji",
        nights: "3",
        adults: "2",
        service: "Flight",
      },
    },
  ];
  h.contacts = [{ id: "c-1", phone: "+911234567890", name: "Rahul", email: "a@b.co" }];
  h.flow_nodes = [];
  h.workspace_fields = [{ id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" }];
  h.workspace_values = [{ flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" }];
  h.accounts = [{ id: "acct-1", owner_user_id: "u-owner" }];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-agent", email: "agent@acme.com", full_name: "Agent" },
    { account_id: "acct-1", user_id: "u-owner", email: "owner@acme.com", full_name: "Owner" },];
  h.links = [];
  h.flowSettings = [];
}

const FUNNEL = {
  leadSource: "WHATSAPP",
  leadType: "FRESH",
  leadStage: "NEW_LEAD",
};

function saveDeparture(country: string | null, city: string | null) {
  h.flowSettings.push({
    account_id: "acct-1",
    flow_id: "flow-1",
    services: [],
    itinerary: [],
    departure_country: country,
    departure_city: city,
  });
}

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

describe("7+10. saved departure defaults prefill the dialog and payload", () => {
  it("prefills dialog departure fields without calling Travel CRM", async () => {
    saveDeparture("India", "Delhi");
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
      prefill: { departureCountry: unknown; departureCity: unknown };
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    // Departure resolved from defaults; assignment still missing.
    expect(json.mapping.missing).not.toContain("departureCountry");
    expect(json.mapping.missing).not.toContain("departureCity");
    expect(json.prefill.departureCountry).toBe("India");
    expect(json.prefill.departureCity).toBe("Delhi");
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("sends stored identifiers in the existing payload structure", async () => {
    saveDeparture("India", "Delhi");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({
      departureCountry: "India",
      departureCity: "Delhi",
    });
  });

  it("country-only defaults send country with a null city", async () => {
    saveDeparture("United Arab Emirates", null);
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      departureCountry: "United Arab Emirates",
      departureCity: null,
    });
  });
});

describe("2. saved defaults reload identically (reopening Workspace)", () => {
  it("sequential prepares return the same departure prefill", async () => {
    saveDeparture("India", "Delhi");
    h.workspace_values = [];
    const first = (await (
      await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }))
    ).json()) as {
      code: string;
      prefill: { departureCountry: unknown; departureCity: unknown };
    };
    const second = (await (
      await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }))
    ).json()) as typeof first;
    for (const json of [first, second]) {
      expect(json.code).toBe("MISSING_FIELDS");
      expect(json.prefill.departureCountry).toBe("India");
      expect(json.prefill.departureCity).toBe("Delhi");
    }
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });
});

describe("6. manually selected city reaches the payload without saved defaults", () => {
  it("dialog Mumbai pick overrides the empty defaults", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, departureCountry: "India", departureCity: "Mumbai" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({
      departureCountry: "India",
      departureCity: "Mumbai",
    });
  });
});

describe("8. services and departure settings stay independent", () => {
  it("departure-overridden create leaves services defaults and payload intact", async () => {
    h.flowSettings.push({
      account_id: "acct-1",
      flow_id: "flow-1",
      services: ["Flight"],
      itinerary: [],
      departure_country: "India",
      departure_city: "Delhi",
    });
    const before = JSON.parse(JSON.stringify(h.flowSettings)) as unknown;
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, departureCity: "Mumbai" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      services: ["FLIGHT"],
      departureCountry: "India",
      departureCity: "Mumbai",
    });
    expect(h.flowSettings).toEqual(before);
  });
});

describe("8. no saved defaults default the country to India; city stays empty", () => {
  it("prefill country is India, city stays null, country leaves missing", async () => {
    h.workspace_values = [];
    // TEMPORARY owner assignment: simulate an unresolvable owner so
    // assignment stays missing and the dialog path (not a create) is
    // observed. Proves missing owner email fails safely.
    h.accounts = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
      prefill: { departureCountry: unknown; departureCity: unknown; assignedToEmail: unknown };
      assignedOwnerEmail: unknown;
      assignmentIssue: unknown;
    };
    // Seed has no departure answers and no flow defaults; the
    // Workspace creation-dialog default supplies India while the
    // city stays empty for the agent to pick. Assignment is missing
    // so the dialog path (not a create) is observed.
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).not.toContain("departureCountry");
    expect(json.mapping.missing).toEqual(
      expect.arrayContaining(["departureCity", "assignedToEmail"]),
    );
    expect(json.prefill.departureCountry).toBe("India");
    expect(json.prefill.departureCity).toBeNull();
    expect(json.prefill.assignedToEmail).toBeNull();
    expect(json.assignedOwnerEmail).toBeNull();
    expect(json.assignmentIssue).toBe("assignment-required");
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("new-entry default sends India with a null city when the agent picks no city", async () => {
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({
      departureCountry: "India",
      departureCity: null,
    });
  });

  it("manual country change wins over the India default for one lead", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, departureCountry: "United Arab Emirates", departureCity: "Dubai" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      departureCountry: "United Arab Emirates",
      departureCity: "Dubai",
    });
  });
});

describe("9. editing one lead never mutates saved Workspace defaults", () => {
  it("dialog override wins for one lead while stored defaults stay intact", async () => {
    saveDeparture("India", "Delhi");
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, departureCountry: "United Arab Emirates", departureCity: "Dubai" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      departureCountry: "United Arab Emirates",
      departureCity: "Dubai",
    });
    expect(h.flowSettings).toHaveLength(1);
    expect(h.flowSettings[0].departure_country).toBe("India");
    expect(h.flowSettings[0].departure_city).toBe("Delhi");
  });
});

describe("lead answers still win over defaults (existing mapping preserved)", () => {
  it("mapped departure answers reach the payload untouched", async () => {
    saveDeparture("India", "Delhi");
    h.flow_runs[0].vars = {
      ...((h.flow_runs[0].vars ?? {}) as Record<string, unknown>),
      departure_country: "United Arab Emirates",
      departure_city: "Dubai",
    };
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      departureCountry: "United Arab Emirates",
      departureCity: "Dubai",
    });
    expect(h.flowSettings[0].departure_country).toBe("India");
  });
});
