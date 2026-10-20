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
  triggers: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({}),
}));

vi.mock("@/lib/meta-capi/triggers", () => ({
  recordWorkspaceStatusChanged: async (
    _db: unknown,
    change: Record<string, unknown>,
  ) => {
    h.triggers.push(change);
    return true;
  },
}));

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
    q.upsert = (obj: Row) => {
    const rows = storeFor(table);
    const idx = rows.findIndex(
      (r) => (r as Row).field_id === obj.field_id && (r as Row).flow_run_id === obj.flow_run_id,
    );
    if (idx >= 0) rows[idx] = { ...rows[idx], ...obj };
    else rows.push({ ...obj });
    return { error: null };
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
  leadSources: [
    { value: "WHATSAPP", label: "WhatsApp" },
    { value: "INSTAGRAM_ADS", label: "Instagram Ads" },
    { value: "FACEBOOK_ADS", label: "Facebook Ads" },
  ],
  leadTypes: [
    { value: "FRESH", label: "Fresh" },
    { value: "HOT", label: "Hot" },
  ],
  leadStages: [
    { value: "NEW_LEAD", label: "New Lead" },
    { value: "QUOTATION_SENT", label: "Quotation Sent" },
  ],
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
  h.contacts = [{ id: "c-1", phone: "+911234567890", name: "Rahul Sharma", email: "a@b.co" }];
  h.flow_nodes = [];
  h.workspace_fields = [
    { id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
    { id: "f-lt", flow_id: "flow-1", name: "Lead Type", field_type: "single_select" },
    { id: "f-st", flow_id: "flow-1", name: "Stage", field_type: "single_select" },
    { id: "f-lr", flow_id: "flow-1", name: "Lead Received", field_type: "single_select" },
  ];
  h.workspace_values = [
    { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
  ];
  h.accounts = [{ id: "acct-1", owner_user_id: "u-owner" }];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-agent", email: "agent@acme.com", full_name: "Agent" },
    { account_id: "acct-1", user_id: "u-owner", email: "owner@acme.com", full_name: "Owner" },];
  h.links = [];
  h.flowSettings = [];
}

/** Set (or clear with null) the three business values for run-1. */
function setRowValues(type: string | null, stage: string | null, received: string | null) {
  h.workspace_values = h.workspace_values.filter(
    (v) => !["f-lt", "f-st", "f-lr"].includes(v.field_id as string),
  );
  const put = (fieldId: string, value: string | null) => {
    if (value !== null) {
      h.workspace_values.push({ flow_run_id: "run-1", field_id: fieldId, value_text: value });
    }
  };
  put("f-lt", type);
  put("f-st", stage);
  put("f-lr", received);
}

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.travelCalls = [];
  h.lookupsOverride = null;
  h.triggers = [];
  seed();
  mockTravel();
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Workspace row is the source of truth for Type/Stage/Received", () => {
  it("1+3+5. Fresh / New Lead / Instagram Ads row creates with those enums (no overrides)", async () => {
    setRowValues("Fresh", "New Lead", "Instagram Ads");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({
      leadType: "FRESH",
      leadStage: "NEW_LEAD",
      leadSource: "INSTAGRAM_ADS",
    });
  });

  it("2+4+6. Hot / Quotation Sent / Facebook Ads row creates with those enums", async () => {
    setRowValues("Hot", "Quotation Sent", "Facebook Ads");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      leadType: "HOT",
      leadStage: "QUOTATION_SENT",
      leadSource: "FACEBOOK_ADS",
    });
  });

  it("11. empty row values stay empty and block creation (nothing invented)", async () => {
    setRowValues(null, null, null);
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      prefill: { rowLeadType: unknown; rowLeadStage: unknown; rowLeadSource: unknown };
    };
    // Type/Stage show their Workspace defaults; Received stays empty.
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.prefill.rowLeadType).toBe("Fresh");
    expect(json.prefill.rowLeadStage).toBe("New Lead");
    expect(json.prefill.rowLeadSource).toBeNull();
    expect(h.travelCalls).toHaveLength(0);
  });

  it("12. unset Type/Stage fall back to Fresh/New Lead while Received reads the row", async () => {
    setRowValues(null, null, "Instagram Ads");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      leadType: "FRESH",
      leadStage: "NEW_LEAD",
      leadSource: "INSTAGRAM_ADS",
    });
  });

  it("CAPI stays silent when the sync writes nothing new", async () => {
    setRowValues("Fresh", "New Lead", "Instagram Ads");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.triggers).toHaveLength(0);
  });

  it("a Travel CRM Stage change triggers exactly one status event", async () => {
    setRowValues("Fresh", "New Lead", "Instagram Ads");
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { leadStage: "QUOTATION_SENT" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.triggers).toEqual([
      {
        accountId: "acct-1",
        flowRunId: "run-1",
        contactId: "c-1",
        fieldName: "Stage",
        previousValue: "New Lead",
        newValue: "Quotation Sent",
      },
    ]);
  });

  it("stale row values block with an informative invalid state (never substituted)", async () => {
    setRowValues("Teleport", "New Lead", "Instagram Ads");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { invalid: Array<{ field: string }> };
      prefill: { rowLeadType: unknown };
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.invalid.map((v) => v.field)).toContain("leadType");
    expect(json.prefill.rowLeadType).toBe("Teleport");
    expect(h.travelCalls).toHaveLength(0);
  });
});
