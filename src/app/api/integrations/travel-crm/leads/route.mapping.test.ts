import { afterEach, describe, expect, it, vi } from "vitest";

// Focused coverage for CRM User Mapping in lead creation:
// the mapped salesperson id travels in the payload (never the email),
// unmapped creators fall back to the owner, and stale mappings retry
// unmapped instead of failing.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: "agent",
  accountId: "acct-1",
  userId: "u-agent",
  flows: [] as Row[],
  flow_runs: [] as Row[],
  contacts: [] as Row[],
  flow_nodes: [] as Row[],
  workspace_fields: [] as Row[],
  workspace_values: [] as Row[],
  profiles: [] as Row[],
  accounts: [] as Row[],
  links: [] as Row[],
  mappings: [] as Row[],
  flowSettings: [] as Row[],
  flowOverrides: [] as Row[],
  travelCalls: [] as Array<{ url: string; body: Record<string, unknown> }>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
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

vi.mock("@/lib/integrations/travel-crm/config", () => ({
  getTravelCrmConfig: () => ({ baseUrl: "https://crm.example.com", secret: "wacrm_secret_123" }),
  travelCrmLeadUrl: (base: string, id: string) => `${base}/queries/${id}`,
}));

function storeFor(table: string): Row[] {
  switch (table) {
    case "flows": return h.flows;
    case "flow_runs": return h.flow_runs;
    case "contacts": return h.contacts;
    case "flow_nodes": return h.flow_nodes;
    case "workspace_fields": return h.workspace_fields;
    case "workspace_values": return h.workspace_values;
    case "profiles": return h.profiles;
    case "accounts": return h.accounts;
    case "travel_crm_lead_links": return h.links;
    case "travel_crm_flow_settings": return h.flowSettings;
    case "workspace_flow_overrides": return h.flowOverrides;
    case "crm_user_mappings": return h.mappings;
    default: return [];
  }
}

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.order = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    q.in = (col: string, vals: unknown[]) => {
      filters.push((r) => (vals as unknown[]).includes(r[col]));
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
      const created = { id: `row-${rows.length + 1}`, ...obj };
      rows.push(created);
      return { select: () => ({ single: async () => ({ data: created, error: null }) }) };
    };
    q.update = (patch: Row) => {
      const chain: Record<string, unknown> = {};
      chain.eq = () => chain;
      chain.select = () => ({
        single: async () => {
          const hit = matched()[0];
          if (hit) Object.assign(hit, patch);
          return { data: hit ?? null, error: hit ? null : { message: "no row" } };
        },
      });
      chain.then = (resolve: (v: unknown) => void) => {
        for (const r of matched()) Object.assign(r, patch);
        resolve({ error: null });
      };
      return chain;
    };
    q.upsert = (obj: Row, opts?: { onConflict?: string }) => {
      const rows = storeFor(table);
      const keys = String(opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const hit = keys.length > 0 ? rows.find((r) => keys.every((k) => r[k] === obj[k])) : undefined;
      const saved = hit ?? { ...obj };
      if (hit) Object.assign(hit, obj);
      else rows.push(saved);
      return { select: () => ({ single: async () => ({ data: saved, error: null }) }) };
    };
    q.delete = () => {
      const chain: Record<string, unknown> = {};
      chain.eq = () => chain;
      chain.then = (resolve: (v: unknown) => void) => {
        const rows = storeFor(table);
        for (const r of matched()) rows.splice(rows.indexOf(r), 1);
        resolve({ error: null });
      };
      return chain;
    };
    return q;
  };
  return api;
}

function mockTravel() {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/integrations/wacrm/lookups")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            leadSources: [{ value: "WHATSAPP", label: "WhatsApp" }],
            leadTypes: [{ value: "HOT", label: "Hot" }],
            leadStages: [{ value: "NEW_LEAD", label: "New" }],
            serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
            destinations: [],
            cities: [],
          },
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/api/integrations/wacrm/leads")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      h.travelCalls.push({ url: u, body });
      // Stale mapping: Travel CRM rejects the unknown salesperson id.
      if (body.assignedToUserId === "crm-stale") {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: "ASSIGNED_USER_NOT_FOUND", message: "No assignable Travel CRM user matches id." },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ success: true, data: { leadId: "tcrm-xyz", alreadyExists: false } }),
        { status: 201 },
      );
    }
    if (u.includes("/api/integrations/wacrm/leads/")) {
      return new Response(JSON.stringify({ success: true, data: { exists: false } }), { status: 200 });
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
  h.role = "agent";
  h.userId = "u-agent";
  h.travelCalls = [];
  h.mappings = [];
  h.flows = [{ id: "flow-1", account_id: "acct-1" }];
  h.flow_runs = [
    {
      id: "run-1",
      flow_id: "flow-1",
      user_id: "u-agent",
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
  h.workspace_fields = [];
  h.workspace_values = [];
  h.accounts = [{ id: "acct-1", owner_user_id: "u-owner" }];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-agent", email: "agent@wacrm.test", full_name: "Agent A" },
    { account_id: "acct-1", user_id: "u-owner", email: "owner@acme.com", full_name: "Owner" },
  ];
  h.links = [];
  h.flowSettings = [];
  h.flowOverrides = [];
}

afterEach(() => {
  vi.restoreAllMocks();
});

const FUNNEL = { leadSource: "WHATSAPP", leadType: "HOT", leadStage: "NEW_LEAD" };

describe("lead creation with CRM user mapping", () => {
  it("sends the mapped salesperson id for a mapped agent", async () => {
    seed();
    mockTravel();
    // Different emails across systems — the join is by ID only.
    h.mappings = [{ account_id: "acct-1", wacrm_user_id: "u-agent", crm_user_id: "crm-501" }];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe("CREATED");
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0]!.body.assignedToUserId).toBe("crm-501");
    // Owner email still travels as the tenant locator + fallback.
    expect(h.travelCalls[0]!.body.assignedToEmail).toBe("owner@acme.com");
  });

  it("sends the mapped id for the owner too when mapped", async () => {
    seed();
    mockTravel();
    h.userId = "u-owner";
    h.role = "owner";
    h.mappings = [{ account_id: "acct-1", wacrm_user_id: "u-owner", crm_user_id: "crm-500" }];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(res.status).toBe(200);
    expect(h.travelCalls[0]!.body.assignedToUserId).toBe("crm-500");
  });

  it("omits the id for unmapped creators (owner fallback, unchanged)", async () => {
    seed();
    mockTravel();
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBe("CREATED");
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0]!.body.assignedToUserId).toBeUndefined();
    expect(h.travelCalls[0]!.body.assignedToEmail).toBe("owner@acme.com");
  });

  it("ignores mappings from other workspaces", async () => {
    seed();
    mockTravel();
    h.mappings = [{ account_id: "acct-OTHER", wacrm_user_id: "u-agent", crm_user_id: "crm-999" }];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(res.status).toBe(200);
    expect(h.travelCalls[0]!.body.assignedToUserId).toBeUndefined();
  });

  it("retries unmapped when the mapped salesperson is stale", async () => {
    seed();
    mockTravel();
    h.mappings = [{ account_id: "acct-1", wacrm_user_id: "u-agent", crm_user_id: "crm-stale" }];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    // Lead still created via the owner fallback — never blocked.
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBe("CREATED");
    expect(h.travelCalls).toHaveLength(2);
    expect(h.travelCalls[0]!.body.assignedToUserId).toBe("crm-stale");
    expect(h.travelCalls[1]!.body.assignedToUserId).toBeUndefined();
    expect(h.travelCalls[1]!.body.assignedToEmail).toBe("owner@acme.com");
  });
});
