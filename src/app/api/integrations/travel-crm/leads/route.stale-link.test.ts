import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyTravelCrmLead } from "@/lib/integrations/travel-crm/client";

type Row = Record<string, unknown>;

const SECRET = "wacrm_secret_123";
const BASE = "https://crm.example.com";

const h = vi.hoisted(() => ({
  authed: true,
  accountId: "acct-1",
  userId: "user-1",
  flows: [] as Row[],
  flow_runs: [] as Row[],
  contacts: [] as Row[],
  profiles: [] as Row[],
  accounts: [] as Row[],
  links: [] as Row[],
  flowSettings: [] as Row[],
  flow_nodes: [] as Row[],
  workspace_fields: [] as Row[],
  workspace_values: [] as Row[],
  flowOverrides: [] as Row[],
  travelLeadPosts: [] as Array<{ url: string; body: unknown }>,
  verifyBehavior: "exists" as "exists" | "missing" | "throw" | "unauthorized",
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    void min;
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
    case "profiles":
      return h.profiles;
    case "accounts":
      return h.accounts;
    case "travel_crm_lead_links":
      return h.links;
    case "travel_crm_flow_settings":
      return h.flowSettings;
    case "flow_nodes":
      return h.flow_nodes;
    case "workspace_fields":
      return h.workspace_fields;
    case "workspace_values":
      return h.workspace_values;
    case "workspace_flow_overrides":
      return h.flowOverrides;
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
    q.delete = () => {
      const chain: Record<string, unknown> = {};
      chain.eq = (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      };
      chain.then = (resolve: (v: unknown) => void) => {
        const rows = storeFor(table);
        const gone = matched();
        for (const r of gone) rows.splice(rows.indexOf(r), 1);
        resolve({ error: null });
      };
      return chain;
    };
    q.upsert = (obj: Row, opts?: { onConflict?: string }) => {
      const rows = storeFor(table);
      const keys = String(opts?.onConflict ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const hit =
        keys.length > 0 ? rows.find((r) => keys.every((k) => r[k] === obj[k])) : undefined;
      const saved = hit ?? { ...obj };
      if (hit) Object.assign(hit, obj);
      else rows.push(saved);
      return { select: () => ({ single: async () => ({ data: saved, error: null }) }) };
    };
    return q;
  };
  return api;
}

function mockTravel() {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    const u = String(url);
    const verifyMatch = u.match(/\/api\/integrations\/wacrm\/leads\/([^/?]+)/);
    if (verifyMatch && (init.method ?? "GET") === "GET") {
      if (h.verifyBehavior === "throw") {
        const err = new Error("timed out");
        err.name = "AbortError";
        throw err;
      }
      if (h.verifyBehavior === "unauthorized") {
        return new Response(
          JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", message: "Bad token." } }),
          { status: 401 },
        );
      }
      const exists = h.verifyBehavior !== "missing";
      return new Response(
        JSON.stringify({ success: true, data: { exists, leadId: decodeURIComponent(verifyMatch[1]) } }),
        { status: 200 },
      );
    }
    if (u.endsWith("/api/integrations/wacrm/leads")) {
      const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
      h.travelLeadPosts.push({ url: u, body });
      return new Response(
        JSON.stringify({ success: true, data: { leadId: "tcrm-xyz", alreadyExists: false } }),
        { status: 201 },
      );
    }
    if (u.includes("/api/integrations/wacrm/lookups")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            leadSources: [{ value: "WHATSAPP", label: "WhatsApp" }],
            leadTypes: [{ value: "HOT", label: "Hot" }],
            leadStages: [{ value: "NEW_LEAD", label: "New" }],
            serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
          },
        }),
        { status: 200 },
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

const FUNNEL = { leadSource: "WHATSAPP", leadType: "HOT", leadStage: "NEW_LEAD" };

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
  h.accounts = [{ id: "acct-1", owner_user_id: "u-owner" }];
  h.profiles = [
    { account_id: "acct-1", user_id: "u-owner", email: "owner@acme.com", full_name: "Owner" },
  ];
  h.links = [];
  h.flowSettings = [];
  h.flow_nodes = [];
  h.workspace_fields = [
    { id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
  ];
  h.workspace_values = [
    { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
  ];
  h.flowOverrides = [];
}

function seedStaleLink() {
  h.links = [
    {
      id: "link-1",
      account_id: "acct-1",
      flow_run_id: "run-1",
      integration_type: "travel-crm",
      status: "created",
      external_lead_id: "tcrm-OLD",
    },
  ];
}

beforeEach(() => {
  h.authed = true;
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.travelLeadPosts = [];
  h.verifyBehavior = "exists";
  seed();
  mockTravel();
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("verifyTravelCrmLead client (stale-link probe)", () => {
  const stubFetch = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("returns exists for a live lead, including the ownerEmail locator", async () => {
    let seenUrl = "";
    const out = await verifyTravelCrmLead(
      BASE,
      SECRET,
      "tcrm-xyz",
      (async (url: string) => {
        seenUrl = url;
        return new Response(
          JSON.stringify({ success: true, data: { exists: true, leadId: "tcrm-xyz" } }),
          { status: 200 },
        );
      }) as typeof fetch,
      { ownerEmail: "owner@acme.com" },
    );
    expect(out).toEqual({ exists: true, leadId: "tcrm-xyz" });
    expect(seenUrl).toContain("/api/integrations/wacrm/leads/tcrm-xyz?ownerEmail=owner%40acme.com");
  });

  it("returns exists:false only on an explicit negative", async () => {
    const out = await verifyTravelCrmLead(
      BASE,
      SECRET,
      "tcrm-xyz",
      stubFetch(200, { success: true, data: { exists: false, leadId: "tcrm-xyz" } }),
    );
    expect(out).toEqual({ exists: false, leadId: "tcrm-xyz" });
  });

  it("throws (inconclusive) on 401, timeouts, and unreadable bodies", async () => {
    await expect(
      verifyTravelCrmLead(BASE, SECRET, "x", stubFetch(401, {})),
    ).rejects.toMatchObject({ code: "TRAVEL_CRM_UNAUTHORIZED" });
    await expect(
      verifyTravelCrmLead(
        BASE,
        SECRET,
        "x",
        (async () => {
          throw Object.assign(new Error("boom"), { name: "AbortError" });
        }) as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "TRAVEL_CRM_UNAVAILABLE" });
    await expect(
      verifyTravelCrmLead(BASE, SECRET, "x", stubFetch(200, { success: true, data: {} })),
    ).rejects.toMatchObject({ code: "TRAVEL_CRM_ERROR" });
    await expect(
      verifyTravelCrmLead(BASE, SECRET, "x", stubFetch(500, {})),
    ).rejects.toMatchObject({ code: "TRAVEL_CRM_ERROR" });
  });
});

describe("POST stale-link recovery (deleted Travel CRM lead)", () => {
  it("a verified live link returns CREATED without creating a duplicate", async () => {
    seedStaleLink();
    const res = await POST(
      post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED", leadId: "tcrm-OLD", alreadyExists: true });
    expect(h.travelLeadPosts).toHaveLength(0);
    expect(h.links).toHaveLength(1);
    expect(h.links[0]).toMatchObject({ external_lead_id: "tcrm-OLD", status: "created" });
  });

  it("a confirmed-missing link is cleared and the lead is re-created with a new ID", async () => {
    seedStaleLink();
    h.verifyBehavior = "missing";
    const res = await POST(
      post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED", leadId: "tcrm-xyz", alreadyExists: false });
    expect(h.travelLeadPosts).toHaveLength(1);
    // Exactly one link row remains, carrying the NEW id — the stale
    // association is gone, not duplicated.
    expect(h.links).toHaveLength(1);
    expect(h.links[0]).toMatchObject({ status: "created", external_lead_id: "tcrm-xyz" });
  });

  it("an inconclusive verification keeps the link and returns CREATED", async () => {
    for (const behavior of ["throw", "unauthorized"] as const) {
      seedStaleLink();
      h.verifyBehavior = behavior;
      h.travelLeadPosts = [];
      const res = await POST(
        post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }),
      );
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toMatchObject({ success: true, code: "CREATED", leadId: "tcrm-OLD", alreadyExists: true });
      expect(h.travelLeadPosts).toHaveLength(0);
      expect(h.links).toHaveLength(1);
      expect(h.links[0]).toMatchObject({ external_lead_id: "tcrm-OLD" });
    }
  });
});
