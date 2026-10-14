import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRAVEL_CRM_SERVICE_LABELS } from "@/lib/integrations/travel-crm/services";

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
  // Production-like catalog: Travel CRM derives labels from enums, so
  // VEHICLE_TRANSFER/OTHER_ADD_ON do NOT carry WACRM's display labels.
  serviceTypes: [
    { value: "CRUISE", label: "Cruise" },
    { value: "FLIGHT", label: "Flight" },
    { value: "HOTEL", label: "Hotel" },
    { value: "VEHICLE_TRANSFER", label: "Vehicle Transfer" },
    { value: "SIGHTSEEING", label: "Sightseeing" },
    { value: "OTHER_ADD_ON", label: "Other Add On" },
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

function seed(withServices: boolean) {
  h.flows = [
    { id: "flow-1", account_id: "acct-1" },
    { id: "flow-2", account_id: "acct-1" },
  ];
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
        ...(withServices ? { service: "Flight" } : {}),
      },
    },
    {
      id: "run-2",
      flow_id: "flow-2",
      user_id: "u-creator",
      contact_id: "c-2",
      vars: {
        travel_date: "2026-12-01",
        destination: "Goa",
        city: "Panaji",
        nights: "3",
        adults: "2",
      },
    },
  ];
  h.contacts = [
    { id: "c-1", phone: "+911234567890", name: "Rahul", email: "a@b.co" },
    { id: "c-2", phone: "+911234567891", name: "Priya", email: "p@b.co" },
  ];
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

const FUNNEL = { leadSource: "WHATSAPP", leadType: "FRESH", leadStage: "NEW_LEAD" };

function saveSettings(flowId: string, services: string[]) {
  h.flowSettings.push({ account_id: "acct-1", flow_id: flowId, services });
}

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.travelCalls = [];
  h.lookupsOverride = null;
  seed(false);
  mockTravel();
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type MissingPayload = {
  success: boolean;
  code: string;
  mapping: { missing: string[] };
  prefill: Record<string, unknown>;
  configuredServices?: unknown;
};

describe("saved Services defaults reach the completion dialog", () => {
  it("1. defaults load for the selected flow (prefill + available, no lead call)", async () => {
    saveSettings("flow-1", ["Cruise", "Flight", "Hotel"]);
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as MissingPayload;
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).not.toContain("services");
    // Dialog prefill carries Settings labels; the dialog renders exactly
    // the per-flow configuration (never the full live catalog).
    expect(json.prefill.services).toEqual(["Cruise", "Flight", "Hotel"]);
    expect(json.configuredServices).toEqual(["Cruise", "Flight", "Hotel"]);
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("9. reopening starts again from the saved defaults (never stale edits)", async () => {
    saveSettings("flow-1", ["Cruise", "Flight", "Hotel"]);
    h.workspace_values = [];
    const first = (await (
      await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }))
    ).json()) as MissingPayload;
    expect(first.prefill.services).toEqual(["Cruise", "Flight", "Hotel"]);
    expect(first.configuredServices).toEqual(["Cruise", "Flight", "Hotel"]);
    const second = (await (
      await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }))
    ).json()) as MissingPayload;
    // Stored defaults are untouched by dialog rounds — same prefill.
    expect(second.prefill.services).toEqual(["Cruise", "Flight", "Hotel"]);
    expect(second.configuredServices).toEqual(["Cruise", "Flight", "Hotel"]);
    expect(h.flowSettings).toHaveLength(1);
    expect(h.flowSettings[0].services).toEqual(["Cruise", "Flight", "Hotel"]);
  });

  it("10+11. switching flows loads each flow's own defaults", async () => {
    saveSettings("flow-1", ["Cruise", "Hotel"]);
    saveSettings("flow-2", ["Flight", "Sightseeing"]);
    h.workspace_values = [];
    const a = (await (
      await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }))
    ).json()) as MissingPayload;
    expect(a.prefill.services).toEqual(["Cruise", "Hotel"]);
    expect(a.configuredServices).toEqual(["Cruise", "Hotel"]);
    const b = (await (
      await POST(
        post({
          flow_id: "flow-2",
          flow_run_id: "run-2",
          overrides: { assignedUserId: "u-agent" },
        }),
      )
    ).json()) as MissingPayload;
    expect(b.prefill.services).toEqual(["Flight", "Sightseeing"]);
    expect(b.configuredServices).toEqual(["Flight", "Sightseeing"]);
  });

  it("12. no configuration invents nothing (missing + empty prefill)", async () => {
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as MissingPayload;
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).toContain("services");
    expect(json.prefill.services).toEqual([]);
    // Empty configuration list: the dialog shows no service options.
    expect(json.configuredServices).toEqual([]);
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });
});

describe("per-lead Services edits ride the dedicated override path", () => {
  it("7. agent edits mapped services without ambiguity (lead data + defaults present)", async () => {
    seed(true);
    saveSettings("flow-1", ["Hotel"]);
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, services: "Hotel; Sightseeing" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ services: ["HOTEL", "SIGHTSEEING"] });
  });

  it("8. editing one lead never modifies saved Workspace defaults", async () => {
    seed(true);
    saveSettings("flow-1", ["Hotel"]);
    await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, services: "Cruise" },
      }),
    );
    expect(h.flowSettings).toHaveLength(1);
    expect(h.flowSettings[0].services).toEqual(["Hotel"]);
  });

  it("13. all six enums reach the payload verbatim", async () => {
    seed(false);
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: {
          ...FUNNEL,
          services:
            "Cruise; Flight; Hotel; Vehicle (disposal); Sightseeing; Add-on Service (Rail, Passport, etc.)",
        },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      services: [
        "CRUISE",
        "FLIGHT",
        "HOTEL",
        "VEHICLE_TRANSFER",
        "SIGHTSEEING",
        "OTHER_ADD_ON",
      ],
    });
  });

  it("clearing every checkbox blocks creation (services stay missing)", async () => {
    seed(true);
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, services: "" },
      }),
    );
    const json = (await res.json()) as MissingPayload;
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).toContain("services");
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("unknown service labels reject without calling Travel CRM", async () => {
    seed(false);
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, services: "Teleport" },
      }),
    );
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      fields: Record<string, string[]>;
    };
    expect(json.success).toBe(false);
    // Dialog-override validation (same code as every other override).
    expect(json.code).toBe("INVALID_OVERRIDES");
    expect(json.fields.services?.join(" ")).toContain("FLIGHT");
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });
});

describe("server still sends per-flow defaults for the dialog (dialog shows all six)", () => {
  // Production-like full catalog: 13 live entries with their own labels.
  const FULL_CATALOG = {
    leadSources: [{ value: "WHATSAPP", label: "WhatsApp" }],
    leadTypes: [{ value: "FRESH", label: "Fresh" }],
    leadStages: [{ value: "NEW_LEAD", label: "New Lead" }],
    serviceTypes: [
      { value: "FLIGHT", label: "Flight" },
      { value: "HOTEL", label: "Hotel" },
      { value: "CRUISE", label: "Cruise" },
      { value: "VEHICLE_TRANSFER", label: "Vehicle Transfer" },
      { value: "SIGHTSEEING", label: "Sightseeing" },
      { value: "VISA", label: "Visa" },
      { value: "TRAVEL_INSURANCE", label: "Travel Insurance" },
      { value: "RAIL", label: "Rail" },
      { value: "PASSPORT_ASSISTANCE", label: "Passport Assistance" },
      { value: "MEAL", label: "Meal" },
      { value: "GUIDE", label: "Guide" },
      { value: "OTHER_ADD_ON", label: "Other Add On" },
      { value: "GENERAL_ENQUIRY", label: "General Enquiry" },
    ],
  };
  const CONFIGURED = [
    "Cruise",
    "Hotel",
    "Sightseeing",
    "Add-on Service (Rail, Passport, etc.)",
  ];

  it("dialog carries exactly the four configured services, never the catalog", async () => {
    seed(false);
    saveSettings("flow-1", CONFIGURED);
    h.lookupsOverride = FULL_CATALOG;
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as MissingPayload;
    expect(json.code).toBe("MISSING_FIELDS");
    // Exactly the configured categories…
    expect(json.configuredServices).toEqual(CONFIGURED);
    expect(json.prefill.services).toEqual(CONFIGURED);
    // …while the live catalog stays intact for payload validation.
    expect(
      ((json as unknown as { options: { services: Array<{ value: string }> } }).options.services ??
        []).map((o) => o.value),
    ).toEqual(FULL_CATALOG.serviceTypes.map((o) => o.value));
    // Unconfigured catalog entries are absent from the dialog list…
    for (const absent of ["Flight", "Vehicle Transfer", "Visa", "Rail", "General Enquiry"]) {
      expect(json.configuredServices as string[]).not.toContain(absent);
    }
    // …and Add-on Service stays a single option (never expanded).
    expect((json.configuredServices as string[]).filter((s) => s.includes("Rail"))).toEqual([
      "Add-on Service (Rail, Passport, etc.)",
    ]);
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("checked configured labels still map to payload enums", async () => {
    seed(true);
    saveSettings("flow-1", ["Cruise", "Hotel"]);
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, services: "Cruise; Hotel" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ services: ["CRUISE", "HOTEL"] });
  });

  it("all six display labels map to exact enums against the production-like catalog", async () => {
    seed(true);
    saveSettings("flow-1", [...TRAVEL_CRM_SERVICE_LABELS]);
    h.lookupsOverride = FULL_CATALOG;
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: {
          ...FUNNEL,
          services:
            "Cruise; Flight; Hotel; Vehicle (disposal); Sightseeing; Add-on Service (Rail, Passport, etc.)",
        },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      services: ["CRUISE", "FLIGHT", "HOTEL", "VEHICLE_TRANSFER", "SIGHTSEEING", "OTHER_ADD_ON"],
    });
  });
});
