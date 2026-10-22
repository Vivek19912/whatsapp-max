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
  flowOverrides: [] as Row[],
  travelCalls: [] as Array<{ url: string; body: unknown }>,
  travelBehavior: "ok" as "ok" | "unauthorized" | "bad-request" | "timeout",
  lookupsOverride: null as null | typeof LOOKUPS,
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

const LOOKUPS = {
  leadSources: [{ value: "WHATSAPP", label: "WhatsApp" }],
  leadTypes: [{ value: "HOT", label: "Hot" }],
  leadStages: [{ value: "NEW_LEAD", label: "New" }],
  serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
};

const LOOKUPS_SOCIAL = {
  leadSources: [
    { value: "WHATSAPP", label: "WhatsApp" },
    { value: "FACEBOOK_ADS", label: "Facebook Ads" },
    { value: "INSTAGRAM_ADS", label: "Instagram Ads" },
  ],
  leadTypes: [{ value: "HOT", label: "Hot" }],
  leadStages: [{ value: "NEW_LEAD", label: "New" }],
  serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
};

function mockTravel() {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/integrations/wacrm/lookups")) {
      const data = (h as { lookupsOverride?: typeof LOOKUPS | null }).lookupsOverride ?? LOOKUPS;
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    }
    if (u.endsWith("/api/integrations/wacrm/leads")) {
      const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
      h.travelCalls.push({ url: u, body });
      if (h.travelBehavior === "unauthorized") {
        return new Response(
          JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", message: "Bad token." } }),
          { status: 401 },
        );
      }
      if (h.travelBehavior === "bad-request") {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: "VALIDATION_ERROR", message: "Bad.", fields: { phone: ["short"] } },
          }),
          { status: 400 },
        );
      }
      if (h.travelBehavior === "timeout") {
        const err = new Error("timed out");
        err.name = "AbortError";
        throw err;
      }
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
  h.flowOverrides = [];
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

describe("POST /api/integrations/travel-crm/leads (Phase 3: connected)", () => {
  it("1. configured integration creates directly when complete (no NOT_CONNECTED)", async () => {
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      success: true,
      code: "CREATED",
      leadId: "tcrm-xyz",
      leadUrl: `${BASE}/queries/tcrm-xyz`,
      alreadyExists: false,
    });
    expect(h.links).toHaveLength(1);
    expect(h.links[0]).toMatchObject({ status: "created", external_lead_id: "tcrm-xyz" });
  });

  it("2. sends the exact contract with the Bearer credential", async () => {
    await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].url).toBe(`${BASE}/api/integrations/wacrm/leads`);
    expect(h.travelCalls[0].body).toMatchObject({
      wacrmAccountId: "acct-1",
      flowRunId: "run-1",
      customerName: "Rahul",
      phone: "+911234567890",
      assignedToEmail: "owner@acme.com",
      leadSource: "WHATSAPP",
      // Raw WACRM value canonicalized against live lookup options.
      services: ["FLIGHT"],
    });
  });

  it("3+4. missing fields return MISSING_FIELDS with prefill, no lead call", async () => {
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    const mapping = json.mapping as { missing: string[] };
    // TEMPORARY owner assignment: the account owner email always
    // resolves, so assignment is never missing; other fields still are.
    expect(mapping.missing).not.toContain("assignedToEmail");
    expect(mapping.missing.length).toBeGreaterThan(0);
    const prefill = json.prefill as Record<string, unknown>;
    expect(prefill).toMatchObject({
      customerName: "Rahul",
      phone: "+911234567890",
      assignedToEmail: "owner@acme.com",
    });
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
    expect(h.links).toHaveLength(0);
  });

  it("5+6. TEMPORARY: Assign To override is ignored, owner email sent onward", async () => {
    h.workspace_values = [];
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, assignedUserId: "u-agent" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(true);
    expect(json.leadId).toBe("tcrm-xyz");
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ assignedToEmail: "owner@acme.com" });
  });

  it("7. real external lead ID is stored on the link", async () => {
    await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(h.links[0].external_lead_id).toBe("tcrm-xyz");
    expect(h.links[0].status).toBe("created");
  });

  it("8. failed creation stores failed link and never shows Created", async () => {
    h.travelBehavior = "bad-request";
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.code).toBe("TRAVEL_CRM_VALIDATION_FAILED");
    expect(JSON.stringify(json)).not.toContain("CREATED");
    expect(h.links[0]).toMatchObject({ status: "failed" });
    expect(String(h.links[0].last_error ?? "")).not.toContain(SECRET);
  });

  it("9+10. duplicate clicks and existing links reuse the real ID without new calls", async () => {
    await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const again = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await again.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED", leadId: "tcrm-xyz", alreadyExists: true });
    expect(h.travelCalls).toHaveLength(1);
    expect(h.links).toHaveLength(1);
  });

  it("11. authentication failure surfaces without leaking the secret", async () => {
    h.travelBehavior = "unauthorized";
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: false, code: "TRAVEL_CRM_UNAUTHORIZED" });
    expect(JSON.stringify(json)).not.toContain(SECRET);
    expect(h.links[0].status).toBe("failed");
  });

  it("12. timeout maps to unavailable", async () => {
    h.travelBehavior = "timeout";
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: false, code: "TRAVEL_CRM_UNAVAILABLE" });
  });

  it("13. cross-account leads are rejected before any external call", async () => {
    h.flows = [{ id: "flow-1", account_id: "acct-2" }];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(res.status).toBe(404);
    expect(h.travelCalls).toHaveLength(0);
  });

  it("14. responses never carry the credential", async () => {
    const okRes = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(JSON.stringify(await okRes.json())).not.toContain(SECRET);
    h.workspace_values = [];
    const missingRes = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(JSON.stringify(await missingRes.json())).not.toContain(SECRET);
  });

  it("unconfigured integration reports configuration error without calling out", async () => {
    vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", "");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: false, code: "TRAVEL_CRM_NOT_CONFIGURED" });
    expect(h.travelCalls).toHaveLength(0);
  });

  it("inferred Received sends the canonical enum without manual selection", async () => {
    h.lookupsOverride = LOOKUPS_SOCIAL;
    h.flow_runs[0].vars = {
      ...((h.flow_runs[0].vars ?? {}) as Record<string, unknown>),
      lead_source: "Facebook",
    };
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { leadType: "HOT", leadStage: "NEW_LEAD" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED", leadId: "tcrm-xyz" });
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: "FACEBOOK_ADS" });
  });

  it("unmatched inference falls back to manual Received selection", async () => {
    // Default lookups have no Facebook entry: inference cannot resolve.
    h.flow_runs[0].vars = {
      ...((h.flow_runs[0].vars ?? {}) as Record<string, unknown>),
      lead_source: "Facebook",
    };
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { leadType: "HOT", leadStage: "NEW_LEAD" },
      }),
    );
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).toContain("leadSource");
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("explicit Received override wins over inference", async () => {
    h.lookupsOverride = LOOKUPS_SOCIAL;
    h.flow_runs[0].vars = {
      ...((h.flow_runs[0].vars ?? {}) as Record<string, unknown>),
      lead_source: "Facebook",
    };
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: "WHATSAPP" });
  });
});

describe("Received inference from the Lead Source icon signal", () => {
  const EXPECTED_LABELS = [
    "Website",
    "Social Media",
    "Facebook Ads",
    "Instagram Ads",
    "Google Ads",
    "Whatsapp",
    "Phone Call",
    "Referral",
    "Walk In",
    "Repeat Customer",
    "Partner",
    "Other",
  ];

  it("MISSING_FIELDS carries exactly the 12 Received options", async () => {
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      code: string;
      receivedOptions: Array<{ value: string; label: string }>;
    };
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.receivedOptions.map((o) => o.label)).toEqual(EXPECTED_LABELS);
  });

  it("screenshot case: instagram icon resolves and creates without manual pick", async () => {
    h.lookupsOverride = LOOKUPS_SOCIAL;
    h.contacts = [
      {
        id: "c-1",
        phone: "+911234567890",
        name: "Rahul",
        email: "a@b.co",
        source_url: "https://instagram.com/p/abc123",
      },
    ];
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { leadType: "HOT", leadStage: "NEW_LEAD" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED", leadId: "tcrm-xyz" });
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: "INSTAGRAM_ADS" });
  });

  it("unmatched inference falls back to manual selection (no lead call)", async () => {
    // Default lookups carry no Instagram entry.
    h.contacts = [
      {
        id: "c-1",
        phone: "+911234567890",
        name: "Rahul",
        email: "a@b.co",
        source_url: "https://instagram.com/p/abc123",
      },
    ];
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { leadType: "HOT", leadStage: "NEW_LEAD" },
      }),
    );
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).toContain("leadSource");
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });
});

describe("renamed business fields and Travel CRM compatibility", () => {
  it("13+14+15. dialog-selected funnel enums reach the payload verbatim", async () => {
    h.lookupsOverride = {
      ...LOOKUPS_SOCIAL,
      leadTypes: [
        { value: "HOT", label: "Hot" },
        { value: "COLD", label: "Cold" },
      ],
      leadStages: [
        { value: "NEW_LEAD", label: "New" },
        { value: "CONTACTED", label: "Contacted" },
      ],
    };
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { leadSource: "FACEBOOK_ADS", leadType: "COLD", leadStage: "CONTACTED" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({
      leadSource: "FACEBOOK_ADS",
      leadType: "COLD",
      leadStage: "CONTACTED",
    });
  });

  it("explicit dialog funnel choices win over the selected-row snapshot", async () => {
    h.lookupsOverride = {
      leadSources: [
        { value: "WHATSAPP", label: "WhatsApp" },
        { value: "REFERRAL", label: "Referral" },
      ],
      leadTypes: [
        { value: "HOT", label: "Hot" },
        { value: "PROSPECT", label: "Prospect" },
      ],
      leadStages: [
        { value: "NEW_LEAD", label: "New" },
        { value: "LOST", label: "Lost" },
      ],
      serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
    };
    h.workspace_fields = [
      { id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
      { id: "f-lt", flow_id: "flow-1", name: "Lead Type", field_type: "single_select" },
      { id: "f-st", flow_id: "flow-1", name: "Stage", field_type: "single_select" },
      { id: "f-lr", flow_id: "flow-1", name: "Lead Received", field_type: "single_select" },
    ];
    h.workspace_values = [
      { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
      { flow_run_id: "run-1", field_id: "f-lt", value_text: "Prospect" },
      { flow_run_id: "run-1", field_id: "f-st", value_text: "Lost" },
      { flow_run_id: "run-1", field_id: "f-lr", value_text: "Referral" },
    ];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    // The agent's explicit dialog picks ride the normal override
    // path to the Travel CRM payload — the row snapshot only fills
    // fields the dialog leaves unset.
    expect(h.travelCalls[0].body).toMatchObject({
      leadSource: "WHATSAPP",
      leadType: "HOT",
      leadStage: "NEW_LEAD",
    });
    // …and after the successful create they sync back to the same
    // selected row (labels, never enums — columns store labels).
    expect(json).toMatchObject({
      workspaceSync: {
        updated: expect.arrayContaining(["leadSource", "leadType", "leadStage"]),
        failed: [],
      },
    });
    const byField = Object.fromEntries(
      h.workspace_values
        .filter((v) => v.flow_run_id === "run-1")
        .map((v) => [v.field_id, v.value_text]),
    );
    expect(byField).toMatchObject({ "f-lt": "Hot", "f-st": "New Lead", "f-lr": "Whatsapp" });
    expect(
      (json.workspaceSync as { rowPatch: { customValues: Record<string, string> } }).rowPatch
        .customValues,
    ).toEqual({ "f-lr": "Whatsapp", "f-lt": "Hot", "f-st": "New Lead" });
  });

  it("Type/Stage dialog options are the canonical Workspace sets with live enum values", async () => {
    // Default lookups: leadTypes [HOT], leadStages [NEW_LEAD].
    // No overrides and no stored funnel values → MISSING_FIELDS
    // carrying the dialog option lists.
    h.workspace_values = [{ flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" }];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      options: { leadType: Array<{ value: string; label: string }>; leadStage: Array<{ value: string; label: string }> };
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    // Exact Workspace order and labels; live enums where the live
    // lookups match, the label itself otherwise (never invented).
    expect(json.options.leadType).toEqual([
      { value: "Fresh", label: "Fresh" },
      { value: "HOT", label: "Hot" },
      { value: "Warm", label: "Warm" },
      { value: "Cold", label: "Cold" },
      { value: "Prospect", label: "Prospect" },
    ]);
    expect(json.options.leadStage.map((o) => o.label)).toEqual([
      "New Lead",
      "Contacted",
      "Qualified",
      "Quotation Required",
      "Quotation Sent",
      "In Negotiation",
      "Ready To Book",
      "Booking Confirmed",
      "Follow Up",
      "Amendment",
      "Lost",
      "Cancelled",
      "Invalid",
      "On Hold",
    ]);
    expect(json.options.leadStage[0]).toEqual({ value: "NEW_LEAD", label: "New Lead" });
  });

  it("funnel overrides outside the canonical sets reject without side effects", async () => {
    const before = JSON.parse(JSON.stringify(h.workspace_values)) as unknown;
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, leadType: "BOGUS" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: false, code: "INVALID_OVERRIDES" });
    expect(h.travelCalls).toHaveLength(0);
    expect(h.workspace_values).toEqual(before);
    expect(json).not.toHaveProperty("workspaceSync");
  });
});

describe("renamed business fields: row snapshot create (no dialog overrides)", () => {
  it("selected-row snapshot fills funnel fields the dialog leaves unset", async () => {
    h.lookupsOverride = {
      leadSources: [
        { value: "WHATSAPP", label: "WhatsApp" },
        { value: "REFERRAL", label: "Referral" },
      ],
      leadTypes: [
        { value: "HOT", label: "Hot" },
        { value: "PROSPECT", label: "Prospect" },
      ],
      leadStages: [
        { value: "NEW_LEAD", label: "New" },
        { value: "LOST", label: "Lost" },
      ],
      serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
    };
    h.workspace_fields = [
      { id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
      { id: "f-lt", flow_id: "flow-1", name: "Lead Type", field_type: "single_select" },
      { id: "f-st", flow_id: "flow-1", name: "Stage", field_type: "single_select" },
      { id: "f-lr", flow_id: "flow-1", name: "Lead Received", field_type: "single_select" },
    ];
    h.workspace_values = [
      { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
      { flow_run_id: "run-1", field_id: "f-lt", value_text: "Prospect" },
      { flow_run_id: "run-1", field_id: "f-st", value_text: "Lost" },
      { flow_run_id: "run-1", field_id: "f-lr", value_text: "Referral" },
    ];
    // No dialog overrides: the selected-row snapshot carries the
    // create (row enums reach the payload) and the sync is a no-op —
    // nothing changed, so the row is never rewritten.
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    expect(h.travelCalls[0].body).toMatchObject({
      leadSource: "REFERRAL",
      leadType: "PROSPECT",
      leadStage: "LOST",
    });
    expect(json).toMatchObject({
      workspaceSync: { updated: [], failed: [] },
    });
    const byField = Object.fromEntries(
      h.workspace_values
        .filter((v) => v.flow_run_id === "run-1")
        .map((v) => [v.field_id, v.value_text]),
    );
    expect(byField).toMatchObject({ "f-lt": "Prospect", "f-st": "Lost", "f-lr": "Referral" });
  });
});

describe("dialog funnel prefill from the Workspace row", () => {
  const FULL_LOOKUPS = {
    leadSources: [
      { value: "WHATSAPP", label: "Whatsapp" },
      { value: "FACEBOOK_ADS", label: "Facebook Ads" },
      { value: "INSTAGRAM_ADS", label: "Instagram Ads" },
      { value: "REFERRAL", label: "Referral" },
    ],
    leadTypes: [
      { value: "FRESH", label: "Fresh" },
      { value: "HOT", label: "Hot" },
      { value: "WARM", label: "Warm" },
      { value: "COLD", label: "Cold" },
      { value: "PROSPECT", label: "Prospect" },
    ],
    leadStages: [
      { value: "NEW_LEAD", label: "New Lead" },
      { value: "CONTACTED", label: "Contacted" },
      { value: "QUALIFIED", label: "Qualified" },
      { value: "QUOTATION_REQUIRED", label: "Quotation Required" },
      { value: "QUOTATION_SENT", label: "Quotation Sent" },
      { value: "IN_NEGOTIATION", label: "In Negotiation" },
      { value: "READY_TO_BOOK", label: "Ready To Book" },
      { value: "BOOKING_CONFIRMED", label: "Booking Confirmed" },
      { value: "FOLLOW_UP", label: "Follow Up" },
      { value: "AMENDMENT", label: "Amendment" },
      { value: "LOST", label: "Lost" },
      { value: "CANCELLED", label: "Cancelled" },
      { value: "INVALID", label: "Invalid" },
      { value: "ON_HOLD", label: "On Hold" },
    ],
    serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
  };

  type PrefillJson = {
    success: boolean;
    code: string;
    prefill: { leadSource: unknown; leadType: unknown; leadStage: unknown };
  };

  // Every case forces MISSING_FIELDS (travel date withheld) so the
  // prepare response carries the dialog prefill with no lead call.
  const seedPrefillScenario = () => {
    h.lookupsOverride = FULL_LOOKUPS;
    h.workspace_fields = [
      { id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
      { id: "f-lt", flow_id: "flow-1", name: "Lead Type", field_type: "single_select" },
      { id: "f-st", flow_id: "flow-1", name: "Stage", field_type: "single_select" },
      { id: "f-lr", flow_id: "flow-1", name: "Lead Received", field_type: "single_select" },
    ];
    h.workspace_values = [{ flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" }];
    const vars = (h.flow_runs[0] as Row).vars as Record<string, unknown>;
    delete vars.travel_date;
  };

  const storeRow = (entries: Array<[string, string]>) => {
    for (const [fieldId, value] of entries) {
      h.workspace_values.push({ flow_run_id: "run-1", field_id: fieldId, value_text: value });
    }
  };

  const preparePrefill = async (): Promise<PrefillJson["prefill"]> => {
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as PrefillJson;
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(h.travelCalls).toHaveLength(0);
    return json.prefill;
  };

  it("1. Workspace Received = Facebook Ads → dialog prefilled Facebook Ads", async () => {
    seedPrefillScenario();
    storeRow([["f-lr", "Facebook Ads"]]);
    const prefill = await preparePrefill();
    expect(prefill.leadSource).toBe("FACEBOOK_ADS");
  });

  it("2. Workspace Type = Fresh → dialog prefilled Fresh", async () => {
    seedPrefillScenario();
    storeRow([["f-lt", "Fresh"]]);
    const prefill = await preparePrefill();
    expect(prefill.leadType).toBe("FRESH");
  });

  it("3. Workspace Stage = New Lead → dialog prefilled New Lead", async () => {
    seedPrefillScenario();
    storeRow([["f-st", "New Lead"]]);
    const prefill = await preparePrefill();
    expect(prefill.leadStage).toBe("NEW_LEAD");
  });

  it("4. Workspace Type = Hot → dialog prefilled Hot", async () => {
    seedPrefillScenario();
    storeRow([["f-lt", "Hot"]]);
    const prefill = await preparePrefill();
    expect(prefill.leadType).toBe("HOT");
  });

  it("5. Workspace Stage = Qualified → dialog prefilled Qualified", async () => {
    seedPrefillScenario();
    storeRow([["f-st", "Qualified"]]);
    const prefill = await preparePrefill();
    expect(prefill.leadStage).toBe("QUALIFIED");
  });

  it("6. Workspace Received = Instagram Ads → dialog prefilled Instagram Ads", async () => {
    seedPrefillScenario();
    storeRow([["f-lr", "Instagram Ads"]]);
    const prefill = await preparePrefill();
    expect(prefill.leadSource).toBe("INSTAGRAM_ADS");
  });

  it("7. Empty Received → remains empty (no arbitrary default)", async () => {
    seedPrefillScenario();
    const prefill = await preparePrefill();
    expect(prefill.leadSource).toBeNull();
  });

  it("8. Empty Type → defaults to Fresh", async () => {
    seedPrefillScenario();
    const prefill = await preparePrefill();
    expect(prefill.leadType).toBe("FRESH");
  });

  it("9. Empty Stage → defaults to New Lead", async () => {
    seedPrefillScenario();
    const prefill = await preparePrefill();
    expect(prefill.leadStage).toBe("NEW_LEAD");
  });

  it("10. Workspace override values take precedence over original flow answers", async () => {
    seedPrefillScenario();
    h.flow_nodes = [
      {
        node_key: "n1",
        node_type: "collect_input",
        flow_id: "flow-1",
        config: { var_key: "source", label: "Source" },
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const vars = (h.flow_runs[0] as Row).vars as Record<string, unknown>;
    vars.source = "Website";
    // Control: the original answer infers nothing usable.
    expect(await preparePrefill()).toMatchObject({ leadSource: null });
    // Override wins: the agent's table edit is the current row value.
    h.flowOverrides = [
      {
        account_id: "acct-1",
        flow_id: "flow-1",
        flow_run_id: "run-1",
        field_key: "source",
        value_text: "Instagram",
      },
    ];
    expect(await preparePrefill()).toMatchObject({ leadSource: "INSTAGRAM_ADS" });
  });

  it("regression: row labels prefill even when live lookups lack every match", async () => {
    // The screenshot bug: the row showed Facebook Ads / Fresh /
    // New Lead while all three dialog selects opened empty. Live
    // lookups without matches must never blank the prefill — the
    // row-display values resolve against the dialog option lists.
    seedPrefillScenario();
    h.lookupsOverride = {
      leadSources: [{ value: "WHATSAPP", label: "Whatsapp" }],
      leadTypes: [{ value: "HOT", label: "Hot" }],
      leadStages: [{ value: "CONTACTED", label: "Contacted" }],
      serviceTypes: [{ value: "FLIGHT", label: "Flight" }],
    };
    storeRow([
      ["f-lr", "Facebook Ads"],
      ["f-lt", "Fresh"],
      ["f-st", "New Lead"],
    ]);
    const prefill = await preparePrefill();
    expect(prefill).toMatchObject({
      leadSource: "FACEBOOK_ADS",
      leadType: "Fresh",
      leadStage: "New Lead",
    });
  });
});

describe("two-way sync: Name/Phone and row scoping", () => {
  it("dialog Name/Phone edits sync to the contact after create", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, customerName: "Rahul Sharma", phone: "+919876543210" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    expect(h.travelCalls[0].body).toMatchObject({
      customerName: "Rahul Sharma",
      phone: "+919876543210",
    });
    expect(h.contacts.find((c) => c.id === "c-1")).toMatchObject({
      name: "Rahul Sharma",
      phone: "+919876543210",
    });
    expect(json).toMatchObject({
      workspaceSync: {
        updated: expect.arrayContaining(["customerName", "phone"]),
        failed: [],
        rowPatch: { name: "Rahul Sharma", phone: "+919876543210" },
      },
    });
  });

  it("unchanged Name/Phone never touch the contact", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, customerName: "Rahul", phone: "+911234567890" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    const sync = json.workspaceSync as { updated: string[] };
    expect(sync.updated).not.toContain("customerName");
    expect(sync.updated).not.toContain("phone");
    expect(h.contacts.find((c) => c.id === "c-1")).toMatchObject({
      name: "Rahul",
      phone: "+911234567890",
    });
  });

  it("funnel sync is scoped to the selected row", async () => {
    h.workspace_fields = [
      { id: "f-asg", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
      { id: "f-lt", flow_id: "flow-1", name: "Lead Type", field_type: "single_select" },
    ];
    h.flow_runs.push({
      id: "run-2",
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
    });
    h.workspace_values = [
      { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
      { flow_run_id: "run-2", field_id: "f-asg", value_text: "u-agent" },
      { flow_run_id: "run-2", field_id: "f-lt", value_text: "Cold" },
    ];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED" });
    // run-2 keeps its own stored value — no cross-row writes.
    expect(
      h.workspace_values.find((v) => v.flow_run_id === "run-2" && v.field_id === "f-lt")
        ?.value_text,
    ).toBe("Cold");
  });

  it("failed create writes nothing to the row", async () => {
    h.travelBehavior = "bad-request";
    const before = JSON.parse(JSON.stringify(h.workspace_values)) as unknown;
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: { ...FUNNEL, customerName: "Changed Name" },
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(h.workspace_values).toEqual(before);
    expect(h.contacts.find((c) => c.id === "c-1")).toMatchObject({ name: "Rahul" });
    expect(json).not.toHaveProperty("workspaceSync");
  });
});

describe("flow service defaults", () => {
  const SERVICE_LOOKUPS = {
    leadSources: [{ value: "WHATSAPP", label: "WhatsApp" }],
    leadTypes: [{ value: "HOT", label: "Hot" }],
    leadStages: [{ value: "NEW_LEAD", label: "New" }],
    serviceTypes: [
      { value: "FLIGHT", label: "Flight" },
      { value: "HOTEL", label: "Hotel" },
      { value: "SIGHTSEEING", label: "Sightseeing" },
      { value: "CRUISE", label: "Cruise" },
    ],
  };

  function dropLeadServices() {
    const vars = { ...(h.flow_runs[0].vars as Record<string, unknown>) };
    delete vars.service;
    h.flow_runs[0].vars = vars;
  }

  function saveSettings(flowId: string, services: string[], accountId = "acct-1") {
    h.flowSettings.push({ account_id: accountId, flow_id: flowId, services });
  }

  it("fills missing services from the flow configuration and creates", async () => {
    dropLeadServices();
    saveSettings("flow-1", ["Hotel", "Sightseeing"]);
    h.lookupsOverride = SERVICE_LOOKUPS;
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, code: "CREATED", leadId: "tcrm-xyz" });
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ services: ["HOTEL", "SIGHTSEEING"] });
    expect(h.links[0]).toMatchObject({ status: "created", external_lead_id: "tcrm-xyz" });
  });

  it("prefills dialog services from defaults without calling Travel CRM", async () => {
    dropLeadServices();
    saveSettings("flow-1", ["Hotel", "Sightseeing"]);
    h.lookupsOverride = SERVICE_LOOKUPS;
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
      prefill: Record<string, unknown>;
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    // Services resolved from defaults; TEMPORARY owner assignment
    // resolves too, so neither is missing.
    expect(json.mapping.missing).not.toContain("services");
    expect(json.mapping.missing).not.toContain("assignedToEmail");
    // Prefill carries Settings labels; dialog checkboxes match case-insensitively.
    expect(json.prefill.services).toEqual(["Hotel", "Sightseeing"]);
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("defaults that match no live enum stay missing for manual pick", async () => {
    dropLeadServices();
    saveSettings("flow-1", ["Hotel", "Sightseeing"]);
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
    };
    // Default lookups only know FLIGHT: stale defaults degrade to asking.
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).toContain("services");
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
    expect(h.flowSettings).toHaveLength(1);
  });

  it("lead data wins over flow defaults", async () => {
    saveSettings("flow-1", ["Hotel"]);
    h.lookupsOverride = SERVICE_LOOKUPS;
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ success: true });
    // Seed vars carry service "Flight" — defaults stay out.
    expect(h.travelCalls[0].body).toMatchObject({ services: ["FLIGHT"] });
  });

  it("dialog override wins over flow defaults without modifying them", async () => {
    dropLeadServices();
    saveSettings("flow-1", ["Hotel"]);
    h.lookupsOverride = SERVICE_LOOKUPS;
    const res = await POST(
      post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: { ...FUNNEL, services: "Cruise" } }),
    );
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ success: true });
    expect(h.travelCalls[0].body).toMatchObject({ services: ["CRUISE"] });
    expect(h.flowSettings).toHaveLength(1);
    expect(h.flowSettings[0].services).toEqual(["Hotel"]);
  });

  it("isolates defaults by flow", async () => {
    dropLeadServices();
    saveSettings("flow-9", ["Cruise"]);
    h.lookupsOverride = SERVICE_LOOKUPS;
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    // No applicable defaults: services still missing.
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect((json.mapping as { missing: string[] }).missing).toContain("services");
  });

  it("no configuration invents nothing", async () => {
    dropLeadServices();
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect((json.mapping as { missing: string[] }).missing).toContain("services");
    expect((json.prefill as Record<string, unknown>).services).toEqual([]);
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });
});

describe("TEMPORARY: Travel CRM leads always assign the account owner", () => {
  it("account owner email resolves and is sent as assignedToEmail", async () => {
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ assignedToEmail: "owner@acme.com" });
  });

  it("dialog response carries the resolved owner assignment", async () => {
    h.workspace_values = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json).toMatchObject({ assignedOwnerEmail: "owner@acme.com", assignmentIssue: null });
    expect((json.prefill as Record<string, unknown>).assignedToEmail).toBe("owner@acme.com");
    expect((json.mapping as { missing: string[] }).missing).not.toContain("assignedToEmail");
  });

  it("Workspace Assign To value does not affect the temporary owner assignment", async () => {
    h.workspace_values = [
      { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
    ];
    for (const overrides of [
      { ...FUNNEL, assignedUserId: "u-agent" },
      { ...FUNNEL, assignedUserId: "u-owner" },
      { ...FUNNEL, assignedUserId: "" },
      { ...FUNNEL },
    ]) {
      h.links = [];
      h.travelCalls = [];
      const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides }));
      expect(await res.json()).toMatchObject({ success: true });
      expect(h.travelCalls).toHaveLength(1);
      expect(h.travelCalls[0].body).toMatchObject({ assignedToEmail: "owner@acme.com" });
    }
  });

  it("no owner email is accepted from request input", async () => {
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: {
          ...FUNNEL,
          assignedUserId: "u-agent",
          assignedToEmail: "attacker@example.com",
        },
      }),
    );
    expect(await res.json()).toMatchObject({ success: true });
    expect(h.travelCalls[0].body).toMatchObject({ assignedToEmail: "owner@acme.com" });
    expect(JSON.stringify(h.travelCalls[0].body)).not.toContain("attacker@example.com");
  });

  it("missing owner email fails safely without sending null", async () => {
    h.accounts = [];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect((json.mapping as { missing: string[] }).missing).toContain("assignedToEmail");
    expect((json.prefill as Record<string, unknown>).assignedToEmail).toBeNull();
    expect(json).toMatchObject({ assignedOwnerEmail: null, assignmentIssue: "assignment-required" });
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
    expect(h.links).toHaveLength(0);
  });
});

describe("agent ownership on Meta Lead Ads Tables", () => {
  function seedMetaOwned() {
    h.role = "agent";
    h.userId = "u-agent";
    h.flows = [{ id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads" }];
    h.workspace_fields = [
      { id: "f-asg", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To", field_type: "select" },
    ];
    // run-1 stays assigned to the caller via the seeded value row.
    h.workspace_values = [
      { account_id: "acct-1", flow_run_id: "run-1", field_id: "f-asg", value_text: "u-agent" },
    ];
  }

  it("lets an agent sync their own Meta lead", async () => {
    seedMetaOwned();
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.success).toBe(true);
  });

  it("404s an agent syncing another agent's Meta lead", async () => {
    seedMetaOwned();
    h.workspace_values = [
      { account_id: "acct-1", flow_run_id: "run-1", field_id: "f-asg", value_text: "u-teammate" },
    ];
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe("LEAD_NOT_FOUND");
    expect(h.travelCalls.filter((c) => c.url.endsWith("/leads"))).toHaveLength(0);
  });

  it("leaves admins and Flow Tables untouched", async () => {
    seedMetaOwned();
    h.role = "admin";
    h.userId = "u-admin";
    h.workspace_values = [
      { flow_run_id: "run-1", field_id: "f-asg", value_text: "u-teammate" },
    ];
    const adminRes = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(adminRes.status).toBe(200);
    h.role = "agent";
    h.userId = "u-agent";
    h.flows = [{ id: "flow-1", account_id: "acct-1", kind: "whatsapp_flow" }];
    const flowRes = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1", overrides: FUNNEL }));
    expect(flowRes.status).toBe(200);
  });
});
