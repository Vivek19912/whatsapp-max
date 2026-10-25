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
  travelBehavior: "ok" as const,
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
  destinations: [
    { value: "dest-sg", label: "Singapore" },
    { value: "dest-bali", label: "Bali" },
  ],
  cities: [
    { value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" },
    { value: "city-sentosa", label: "Sentosa Island", destinationValue: "dest-sg" },
    { value: "city-kuta", label: "Kuta", destinationValue: "dest-bali" },
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
        adults: "2",
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

const FUNNEL = { leadSource: "WHATSAPP", leadType: "HOT", leadStage: "NEW_LEAD" };

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.travelCalls = [];
  h.travelBehavior = "ok";
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

describe("3. no configured defaults produces an empty itinerary", () => {
  it("prefill.itinerary is [] and itinerary stays missing", async () => {
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
      prefill: { itinerary: unknown[] };
    };
    // Seed has no destination vars and no flow defaults → itinerary missing.
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).toContain("itinerary");
    expect(json.prefill.itinerary).toEqual([]);
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });
});

describe("4. configured defaults are loaded into the lead dialog", () => {
  it("prefills dialog itinerary from Workspace defaults without calling Travel CRM", async () => {
    h.flowSettings.push({
      account_id: "acct-1",
      flow_id: "flow-1",
      services: [],
      itinerary: [
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        { destination: "dest-bali", city: "city-kuta", nights: 3 },
      ],
    });
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
      prefill: { itinerary: Array<{ destination: string; city: string; nights: number }> };
      destinations: Array<{ value: string; label: string }>;
      cities: Array<{ value: string; label: string; destinationValue: string | null }>;
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    // Itinerary resolved from defaults; assignment still missing.
    expect(json.mapping.missing).not.toContain("itinerary");
    expect(json.prefill.itinerary).toEqual([
      { destination: "dest-sg", city: "city-marina", nights: 4 },
      { destination: "dest-bali", city: "city-kuta", nights: 3 },
    ]);
    // Destination/city lookups come from Travel CRM (same upstream payload).
    expect(json.destinations.map((d) => d.value)).toEqual(["dest-sg", "dest-bali"]);
    expect(json.cities.map((c) => c.value)).toEqual(["city-marina", "city-sentosa", "city-kuta"]);
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("creates directly when defaults + funnel + assignment are complete", async () => {
    h.flowSettings.push({
      account_id: "acct-1",
      flow_id: "flow-1",
      services: [],
      itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
    });
    // Seed itinerary via vars so mapping has itinerary; defaults path also covered above.
    h.flow_runs[0].vars = {
      ...(h.flow_runs[0].vars as Record<string, unknown>),
      destination: "dest-sg",
      city: "city-marina",
      nights: "4",
      service: "Flight",
    };
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    expect(h.travelCalls).toHaveLength(1);
  });
});

describe("5. editing a lead itinerary does not mutate saved defaults", () => {
  it("override wins for one lead while stored defaults stay intact", async () => {
    h.flowSettings.push({
      account_id: "acct-1",
      flow_id: "flow-1",
      services: [],
      itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
    });
    h.flow_runs[0].vars = {
      ...(h.flow_runs[0].vars as Record<string, unknown>),
      service: "Flight",
    };
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: {
          ...FUNNEL,
          itinerary: [{ destination: "dest-sg", city: "city-sentosa", nights: 3 }],
        },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      itinerary: [
        { country: "Singapore", destination: "Sentosa Island", nights: 3, sequence: 1 },
      ],
    });
    // Saved default unchanged.
    expect(h.flowSettings).toHaveLength(1);
    expect(h.flowSettings[0].itinerary).toEqual([
      { destination: "dest-sg", city: "city-marina", nights: 4 },
    ]);
  });
});

describe("city-less dialog overrides are accepted (Destination + Nights only)", () => {
  it("a city-less row creates with the destination name and empty city", async () => {
    h.flow_runs[0].vars = {
      ...(h.flow_runs[0].vars as Record<string, unknown>),
      service: "Flight",
    };
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: {
          ...FUNNEL,
          itinerary: [{ destination: "dest-sg", nights: 3 }],
        },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      itinerary: [{ country: "Singapore", destination: "", nights: 3, sequence: 1 }],
    });
  });

  it("a destination-less row is still dropped while valid rows send", async () => {
    h.flow_runs[0].vars = {
      ...(h.flow_runs[0].vars as Record<string, unknown>),
      service: "Flight",
    };
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: {
          ...FUNNEL,
          itinerary: [
            { destination: "", nights: 2 },
            { destination: "dest-bali", nights: 4 },
          ],
        },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      itinerary: [{ country: "Bali", destination: "", nights: 4, sequence: 1 }],
    });
  });
});

describe("13. existing Travel CRM lead payload mapping remains correct", () => {
  it("sends itinerary as country/destination/nights/sequence", async () => {
    h.flowSettings.push({
      account_id: "acct-1",
      flow_id: "flow-1",
      services: [],
      itinerary: [
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        { destination: "dest-sg", city: "city-sentosa", nights: 3 },
      ],
    });
    h.flow_runs[0].vars = {
      ...(h.flow_runs[0].vars as Record<string, unknown>),
      service: "Flight",
    };
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      itinerary: [
        { country: "Singapore", destination: "Marina Bay", nights: 4, sequence: 1 },
        { country: "Singapore", destination: "Sentosa Island", nights: 3, sequence: 2 },
      ],
    });
  });
});

describe("6. itinerary master UUIDs resolve to display names in the Travel CRM payload", () => {
  // Destination/city values in the stored defaults are master UUIDs (the
  // mock lookups' `value`). The create payload must carry the display
  // NAMES (like manually-created Travel CRM leads), resolved only against
  // the workspace-scoped lookups — never an unscoped lookup.
  it("resolves destination UUID → destination name and city UUID → city name", async () => {
    h.flowSettings.push({
      account_id: "acct-1",
      flow_id: "flow-1",
      services: [],
      itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
    });
    h.flow_runs[0].vars = {
      ...(h.flow_runs[0].vars as Record<string, unknown>),
      service: "Flight",
    };
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      itinerary: [{ country: "Singapore", destination: "Marina Bay", nights: 4, sequence: 1 }],
    });
  });

  it("leaves non-matching and already-name values unchanged", async () => {
    h.flowSettings.push({
      account_id: "acct-1",
      flow_id: "flow-1",
      services: [],
      itinerary: [
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        // Unknown values that match no master UUID → untouched.
        { destination: "Unknown-Dest", city: "Free Text City", nights: 2 },
        // Flow-answer/name-based values (already display names) → untouched.
        { destination: "Singapore", city: "Sentosa Island", nights: 1 },
      ],
    });
    h.flow_runs[0].vars = {
      ...(h.flow_runs[0].vars as Record<string, unknown>),
      service: "Flight",
    };
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      itinerary: [
        { country: "Singapore", destination: "Marina Bay", nights: 4, sequence: 1 },
        { country: "Unknown-Dest", destination: "Free Text City", nights: 2, sequence: 2 },
        { country: "Singapore", destination: "Sentosa Island", nights: 1, sequence: 3 },
      ],
    });
  });

  it("never resolves a UUID that is absent from this workspace's scoped lookups", async () => {
    // `dest-foreign`/`city-foreign` belong to another workspace: they are
    // not in the scoped lookups, so they must pass through unchanged and
    // must NOT be resolved from another workspace's master.
    h.flowSettings.push({
      account_id: "acct-1",
      flow_id: "flow-1",
      services: [],
      itinerary: [{ destination: "dest-foreign", city: "city-foreign", nights: 3 }],
    });
    h.flow_runs[0].vars = {
      ...(h.flow_runs[0].vars as Record<string, unknown>),
      service: "Flight",
    };
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      itinerary: [
        { country: "dest-foreign", destination: "city-foreign", nights: 3, sequence: 1 },
      ],
    });
  });
});

describe("15. idempotency unaffected + 14. services still work", () => {
  it("existing link short-circuits without new Travel CRM calls", async () => {
    h.links.push({
      id: "link-1",
      account_id: "acct-1",
      flow_run_id: "run-1",
      integration_type: "travel-crm",
      status: "created",
      external_lead_id: "tcrm-existing",
    });
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, leadId: "tcrm-existing", alreadyExists: true });
    expect(h.travelCalls).toHaveLength(0);
  });
});
