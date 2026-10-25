import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDialogInputs } from "@/components/workspace/travel-crm-action";

// ---------------------------------------------------------------------------
// Lead Source prefill + payload (Complete Travel CRM Fields dialog).
//
// The selected Workspace row's Source value — a Meta form "Source"
// answer, the ad-platform signal, or the stored Lead Received cell —
// must prefill the dialog's Lead Source field with the matching
// Travel CRM option (Facebook → Facebook Ads, WhatsApp → Whatsapp,
// Website → Website, …). Missing or unsupported sources leave the
// field unselected (never guessed), and the prefilled/confirmed
// value rides the lead-creation payload.
//
// Live lookups here carry the full 12-option Travel CRM
// configuration (values verified against the shared LEAD_SOURCES
// enum), so resolution matches production.
// ---------------------------------------------------------------------------

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
        ? { data: hit, error: hit }
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

// Full 12-option Travel CRM lead-source configuration (values match
// the shared LEAD_SOURCES enum; the Whatsapp label mirrors the
// dialog's canonical label set).
const LEAD_SOURCES_12 = [
  { value: "WEBSITE", label: "Website" },
  { value: "SOCIAL_MEDIA", label: "Social Media" },
  { value: "FACEBOOK_ADS", label: "Facebook Ads" },
  { value: "INSTAGRAM_ADS", label: "Instagram Ads" },
  { value: "GOOGLE_ADS", label: "Google Ads" },
  { value: "WHATSAPP", label: "Whatsapp" },
  { value: "PHONE_CALL", label: "Phone Call" },
  { value: "REFERRAL", label: "Referral" },
  { value: "WALK_IN", label: "Walk In" },
  { value: "REPEAT_CUSTOMER", label: "Repeat Customer" },
  { value: "PARTNER", label: "Partner" },
  { value: "OTHER", label: "Other" },
];

const LOOKUPS = {
  leadSources: LEAD_SOURCES_12,
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

const COMPLETE_VARS = {
  travel_date: "2026-12-01",
  destination: "Goa",
  city: "Panaji",
  nights: "3",
  adults: "2",
  service: "Flight",
};

function seed(vars: Record<string, unknown> = COMPLETE_VARS) {
  h.flows = [{ id: "flow-1", account_id: "acct-1" }];
  h.flow_runs = [
    {
      id: "run-1",
      flow_id: "flow-1",
      user_id: "u-creator",
      contact_id: "c-1",
      vars: { ...vars },
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

/** Add a Meta-form "Source" answer to the run vars. */
function withSourceAnswer(value: string) {
  const run = h.flow_runs[0] as { vars: Record<string, unknown> };
  run.vars = { ...run.vars, source: value };
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

describe("Lead Source answers resolve to Travel CRM options", () => {
  it.each([
    ["Facebook", "FACEBOOK_ADS"],
    ["Instagram", "INSTAGRAM_ADS"],
    ["Website", "WEBSITE"],
    ["WhatsApp", "WHATSAPP"],
    ["Phone Call", "PHONE_CALL"],
  ])("%s source answer creates with %s (no overrides)", async (answer, expected) => {
    withSourceAnswer(answer);
    setRowValues("Fresh", "New Lead", null);
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: expected });
  });

  it("stored row Website resolves to WEBSITE (actual row Source value)", async () => {
    setRowValues("Fresh", "New Lead", "Website");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: "WEBSITE" });
  });

  it.each([
    ["Facebook", "FACEBOOK_ADS"],
    ["Instagram", "INSTAGRAM_ADS"],
    [" facebook ", "FACEBOOK_ADS"],
    ["instagram", "INSTAGRAM_ADS"],
  ])(
    "stored row %s resolves to %s (bare/case variants, never unknown-option)",
    async (stored, expected) => {
      setRowValues("Fresh", "New Lead", stored);
      const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
      const json = (await res.json()) as {
        success: boolean;
        mapping?: { invalid: Array<{ field: string }> };
      };
      expect(json.success).toBe(true);
      expect(json.mapping?.invalid ?? []).toEqual([]);
      expect(h.travelCalls).toHaveLength(1);
      expect(h.travelCalls[0].body).toMatchObject({ leadSource: expected });
    },
  );

  it("stored bare Facebook prefills the dialog (no Select Lead Source placeholder)", async () => {
    const incomplete: Record<string, unknown> = { ...COMPLETE_VARS };
    delete incomplete.travel_date;
    seed(incomplete);
    // No source answer, no ad signal — only the row's stored Source.
    setRowValues(null, null, "Facebook");
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { invalid: Array<{ field: string }> };
      prefill: { leadSource: unknown; rowLeadSource: unknown };
      receivedOptions: Array<{ value: string; label: string }>;
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    // The row value is preserved for the read-only block…
    expect(json.prefill.rowLeadSource).toBe("Facebook");
    // …and resolves to the exact accepted dropdown option.
    expect(json.prefill.leadSource).toBe("FACEBOOK_ADS");
    expect(json.mapping.invalid ?? []).toEqual([]);
    expect(
      json.receivedOptions.find((o) => o.label === "Facebook Ads")?.value,
    ).toBe("FACEBOOK_ADS");
  });

  it("missing source leaves the field unselected and blocks creation", async () => {
    setRowValues("Fresh", "New Lead", null);
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
      prefill: { leadSource: unknown; rowLeadSource: unknown };
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.mapping.missing).toContain("leadSource");
    expect(json.prefill.leadSource).toBeNull();
    expect(json.prefill.rowLeadSource).toBeNull();
    expect(h.travelCalls).toHaveLength(0);
  });

  it("unsupported source leaves the field unselected (never guessed)", async () => {
    withSourceAnswer("Teleport");
    setRowValues("Fresh", "New Lead", null);
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      mapping: { missing: string[] };
      prefill: { leadSource: unknown };
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    expect(json.prefill.leadSource).toBeNull();
    expect(h.travelCalls).toHaveLength(0);
  });
});

describe("Meta Source column end to end (reported bug shape)", () => {
  // Production Meta submissions store the Source answer under the
  // virtual-flow key "meta_lead_source" (label falls back to that
  // same key — the node config carries no header/label/title).
  // That is the exact value the Workspace Source column displays.
  function withMetaSource(value: string) {
    const run = h.flow_runs[0] as { vars: Record<string, unknown> };
    run.vars = { ...run.vars, meta_lead_source: value };
  }

  it.each([
    ["Facebook", "FACEBOOK_ADS"],
    ["Instagram", "INSTAGRAM_ADS"],
  ])("row Source %s creates with %s (no overrides)", async (answer, expected) => {
    withMetaSource(answer);
    setRowValues("Fresh", "New Lead", null);
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: expected });
  });

  it("unknown-platform Other resolves to the Other option (never guessed)", async () => {
    withMetaSource("Other");
    setRowValues("Fresh", "New Lead", null);
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: "OTHER" });
  });

  it("dialog preselects the Meta Source value and Create sends it", async () => {
    const incomplete: Record<string, unknown> = { ...COMPLETE_VARS };
    delete incomplete.travel_date;
    seed(incomplete);
    withMetaSource("Facebook");
    setRowValues(null, null, null);
    const prepare = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const prefill = (
      (await prepare.json()) as {
        success: boolean;
        code: string;
        prefill: { leadSource: unknown };
        receivedOptions: Array<{ value: string; label: string }>;
      }
    );
    expect(prefill.success).toBe(false);
    expect(prefill.code).toBe("MISSING_FIELDS");
    // The dialog opens preselected — never "Select Lead Source".
    expect(prefill.prefill.leadSource).toBe("FACEBOOK_ADS");
    expect(
      prefill.receivedOptions.find((o) => o.label === "Facebook Ads")?.value,
    ).toBe("FACEBOOK_ADS");
    // The confirmed dialog value rides the Create payload.
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: {
          travelStartDate: "2026-12-01",
          leadSource: prefill.prefill.leadSource,
          leadType: "FRESH",
          leadStage: "NEW_LEAD",
        },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: "FACEBOOK_ADS" });
  });

  it("dialog still renders the preselected value (controlled select)", () => {
    const inputs = buildDialogInputs(
      {
        available: ["customerName", "phone", "leadSource"],
        missing: ["travelStartDate"],
        ambiguous: [],
        invalid: [],
        ready: false,
      },
      { leadSource: "FACEBOOK_ADS", assignedToEmail: "agent@acme.com" },
      { leadSource: LEAD_SOURCES_12, leadType: null, leadStage: null, services: null },
      null,
      LEAD_SOURCES_12,
    );
    const received = inputs.find((i) => i.field === "leadSource");
    expect(received?.kind).toBe("select");
    expect(received?.value).toBe("FACEBOOK_ADS");
    expect(received?.options?.find((o) => o.value === "FACEBOOK_ADS")?.label).toBe(
      "Facebook Ads",
    );
  });
});

describe("Lead Source dialog prefill and Create", () => {
  it("the dialog offers exactly the 12 Travel CRM options", async () => {
    const incomplete: Record<string, unknown> = { ...COMPLETE_VARS };
    delete incomplete.travel_date;
    seed(incomplete);
    withSourceAnswer("Facebook");
    setRowValues(null, null, null);
    const res = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const json = (await res.json()) as {
      success: boolean;
      code: string;
      prefill: { leadSource: unknown };
      receivedOptions: Array<{ value: string; label: string }>;
    };
    expect(json.success).toBe(false);
    expect(json.code).toBe("MISSING_FIELDS");
    // Prefilled from the row's Source value (resolves to the live enum).
    expect(json.prefill.leadSource).toBe("FACEBOOK_ADS");
    // No invented or substituted options — labels match Travel CRM exactly.
    expect(json.receivedOptions.map((o) => o.label)).toEqual(EXPECTED_LABELS);
    expect(
      json.receivedOptions.find((o) => o.label === "Facebook Ads")?.value,
    ).toBe("FACEBOOK_ADS");
  });

  it("the prefilled source renders selected in the dialog", () => {
    const inputs = buildDialogInputs(
      {
        available: ["customerName", "phone", "leadSource"],
        missing: ["travelStartDate"],
        ambiguous: [],
        invalid: [],
        ready: false,
      },
      { leadSource: "FACEBOOK_ADS", assignedToEmail: "agent@acme.com" },
      { leadSource: LEAD_SOURCES_12, leadType: null, leadStage: null, services: null },
      null,
      LEAD_SOURCES_12,
    );
    const received = inputs.find((i) => i.field === "leadSource");
    expect(received?.kind).toBe("select");
    expect(received?.label).toBe("Lead Source");
    expect(received?.value).toBe("FACEBOOK_ADS");
    expect(received?.options?.map((o) => o.label)).toEqual(EXPECTED_LABELS);
  });

  it("the dialog-confirmed source is sent when Create is clicked", async () => {
    const incomplete: Record<string, unknown> = { ...COMPLETE_VARS };
    delete incomplete.travel_date;
    seed(incomplete);
    withSourceAnswer("Facebook");
    setRowValues(null, null, null);
    const prepare = await POST(post({ flow_id: "flow-1", flow_run_id: "run-1" }));
    const prefill = (
      (await prepare.json()) as { prefill: { leadSource: unknown } }
    ).prefill;
    expect(prefill.leadSource).toBe("FACEBOOK_ADS");
    // Agent confirms the prefilled source and fills the missing date.
    const res = await POST(
      post({
        flow_id: "flow-1",
        flow_run_id: "run-1",
        overrides: {
          travelStartDate: "2026-12-01",
          leadSource: prefill.leadSource,
          leadType: "FRESH",
          leadStage: "NEW_LEAD",
        },
      }),
    );
    expect(((await res.json()) as Record<string, unknown>).success).toBe(true);
    expect(h.travelCalls).toHaveLength(1);
    expect(h.travelCalls[0].body).toMatchObject({ leadSource: "FACEBOOK_ADS" });
  });
});
