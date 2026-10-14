import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDialogInputs } from "@/components/workspace/travel-crm-action";

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

describe("1+2. Name/Phone prefilled from the WACRM flow run", () => {
  it("prefill carries the canonical contact Name and normalized Phone", async () => {
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      code: string;
      prefill: { customerName: unknown; phone: unknown };
    };
    expect(json.code).toBe("MISSING_FIELDS");
    // Same Workspace submission/contact data already used (no second source).
    expect(json.prefill.customerName).toBe("Rahul Sharma");
    expect(json.prefill.phone).toBe("+911234567890");
  });

  it("dialog begins with Name then Phone, prefilled and editable", () => {
    const inputs = buildDialogInputs(
      { available: ["customerName", "phone"], missing: ["travelStartDate"], ambiguous: [], invalid: [], ready: false },
      { customerName: "Rahul Sharma", phone: "+911234567890", assignedToEmail: "a@x.co" },
      null,
      null,
    );
    expect(inputs[0].field).toBe("customerName");
    expect(inputs[0].label).toBe("Name");
    expect(inputs[0].value).toBe("Rahul Sharma");
    expect(inputs[0].kind).toBe("text");
    expect(inputs[1].field).toBe("phone");
    expect(inputs[1].label).toBe("Phone");
    expect(inputs[1].value).toBe("+911234567890");
    expect(inputs[1].kind).toBe("text");
  });
});

describe("3+4. agent can edit Name/Phone (dialog editable)", () => {
  it("Name and Phone inputs are text inputs (editable, not read-only)", () => {
    const inputs = buildDialogInputs(
      { available: [], missing: [], ambiguous: [], invalid: [], ready: true },
      { customerName: "Rahul", phone: "+911234567890", assignedToEmail: "a@x.co" },
      null,
      null,
    );
    const name = inputs.find((i) => i.field === "customerName");
    const phone = inputs.find((i) => i.field === "phone");
    expect(name?.kind).toBe("text");
    expect(phone?.kind).toBe("text");
  });
});

describe("5+6. edited Name/Phone sent as customerName/phone", () => {
  it("edited Name is sent as Travel CRM customerName", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, customerName: "Corrected Name" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ customerName: "Corrected Name" });
    // Phone untouched → canonical value preserved.
    expect(h.travelCalls[0].body).toMatchObject({ phone: "+911234567890" });
  });

  it("edited Phone is sent as Travel CRM phone", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, phone: "+919876543210" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ phone: "+919876543210" });
    expect(h.travelCalls[0].body).toMatchObject({ customerName: "Rahul Sharma" });
  });

  it("a 10-digit Phone without a country code is sent verbatim (no 91 added)", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, phone: "8885638563" },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ phone: "8885638563" });
  });

  it("rejects invalid Name/Phone edits without calling Travel CRM", async () => {
    const badName = await POST(
      post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: { ...FUNNEL, customerName: "A" } }),
    );
    expect(((await badName.json()) as { code: string }).code).toBe("INVALID_OVERRIDES");
    const badPhone = await POST(
      post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: { ...FUNNEL, phone: "123" } }),
    );
    expect(((await badPhone.json()) as { code: string }).code).toBe("INVALID_OVERRIDES");
    expect(h.travelCalls).toHaveLength(0);
  });
});

describe("7. existing field completion behavior unchanged", () => {
  it("missing funnel still returns MISSING_FIELDS with prefill", async () => {
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      code: string;
      mapping: { missing: string[] };
      prefill: Record<string, unknown>;
    };
    expect(json.code).toBe("MISSING_FIELDS");
    // TEMPORARY owner assignment: assignment always resolves, so only
    // funnel fields remain missing here.
    expect(json.mapping.missing).not.toContain("assignedToEmail");
    expect(json.mapping.missing.length).toBeGreaterThan(0);
    expect(json.prefill).toMatchObject({
      customerName: "Rahul Sharma",
      phone: "+911234567890",
      assignedToEmail: "owner@acme.com",
    });
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("full completion still creates with the existing payload structure", async () => {
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({
      wacrmAccountId: "acct-1",
      flowRunId: "run-1",
      customerName: "Rahul Sharma",
      phone: "+911234567890",
      assignedToEmail: "owner@acme.com",
      leadSource: "WHATSAPP",
    });
  });
});

describe("8. idempotency unchanged", () => {
  it("existing link reuses the real ID without new calls", async () => {
    await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const again = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(((await again.json()) as Record<string, unknown>)).toMatchObject({
      success: true,
      leadId: "tcrm-xyz",
      alreadyExists: true,
    });
    expect(h.travelCalls).toHaveLength(1);
  });
});
