import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  flows: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  forms: [] as Array<Record<string, unknown>>,
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
      err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status },
    );
  },
}));

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const state: { table: string; filters: Filter[]; orderCol: string | null } = {
      table,
      filters: [],
      orderCol: null,
    };
    const store = (): Array<Record<string, unknown>> => {
      if (table === "flows") return h.flows;
      if (table === "lead_assignment_table_configs") return h.configs;
      if (table === "lead_assignment_table_assignees") return h.assignees;
      if (table === "profiles") return h.profiles;
      if (table === "meta_lead_forms") return h.forms;
      return [];
    };
    const matched = () => {
      let list = store().filter((r) =>
        state.filters.every((f) =>
          f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
        ),
      );
      if (state.orderCol) {
        const col = state.orderCol;
        list = [...list].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
      }
      return list;
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        state.filters.push({ col, op: "eq", val });
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        state.filters.push({ col, op: "in", val: vals });
        return q;
      },
      order: (col: string) => {
        state.orderCol = col;
        return q;
      },
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
    };
    return q;
  };
  return api;
}

const { GET } = await import("./route");

beforeEach(() => {
  h.authed = true;
  h.role = "owner";
  h.accountId = "acct-1";
  h.userId = "owner-1";
  h.flows = [
    { id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads", name: "Meta Lead Ads · Hiring", meta_form_id: "form-1" },
    { id: "flow-2", account_id: "acct-1", kind: "meta_lead_ads", name: "Meta Lead Ads · Travel", meta_form_id: "form-2" },
    { id: "flow-3", account_id: "acct-1", kind: "meta_lead_ads", name: "Meta Lead Ads · Hidden", meta_form_id: "form-3" },
    { id: "flow-9", account_id: "acct-1", kind: "whatsapp_flow", name: "Chat", meta_form_id: null },
    { id: "flow-x", account_id: "acct-OTHER", kind: "meta_lead_ads", name: "Meta Lead Ads · Foreign", meta_form_id: null },
  ];
  h.forms = [
    { id: "form-1", account_id: "acct-1", form_name: "Hiring" },
    { id: "form-2", account_id: "acct-1", form_name: "Travel" },
  ];
  h.configs = [
    {
      id: "cfg-1", account_id: "acct-1", flow_id: "flow-1", enabled: true, mode: "percentage",
      timezone: "Asia/Kolkata", whatsapp_template_name: null, whatsapp_template_language: "en_US",
      updated_at: "2026-11-20T10:00:00.000Z",
    },
    {
      id: "cfg-2", account_id: "acct-1", flow_id: "flow-2", enabled: false, mode: "round_robin",
      timezone: "Asia/Kolkata", whatsapp_template_name: "alert", whatsapp_template_language: "en_US",
      updated_at: "2026-11-18T10:00:00.000Z",
    },
  ];
  h.assignees = [
    { id: "a-1", config_id: "cfg-1", user_id: "u-mohan", display_name: "Mohan", weight: 60, is_active: true, position: 0, notify_email: true, notify_whatsapp: false },
    { id: "a-2", config_id: "cfg-1", user_id: null, display_name: "External Priya", weight: 40, is_active: true, position: 1, notify_email: true, notify_whatsapp: false },
    { id: "a-3", config_id: "cfg-2", user_id: "u-rita", display_name: "Rita", weight: 0, is_active: true, position: 0, notify_email: false, notify_whatsapp: true },
  ];
  h.profiles = [
    { user_id: "u-mohan", account_id: "acct-1", full_name: "Mohan Live" },
    { user_id: "u-rita", account_id: "acct-1", full_name: "Rita Live" },
  ];
});

describe("GET /api/workspace/table-assignments", () => {
  it("403s for admin, agent, and viewer (owner only)", async () => {
    for (const role of ["admin", "agent", "viewer"]) {
      h.role = role;
      const res = await GET();
      expect(res.status).toBe(403);
    }
    h.role = "owner";
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it("401s when unauthenticated", async () => {
    h.authed = false;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("includes every Meta table including hidden/disabled; excludes other kinds + tenants", async () => {
    const res = await GET();
    const body = (await res.json()) as { tables: Array<{ flowId: string }> };
    const ids = body.tables.map((t) => t.flowId).sort();
    // flow-3 has no config (disabled/never configured) but must appear;
    // whatsapp_flow and foreign-tenant flows must not.
    expect(ids).toEqual(["flow-1", "flow-2", "flow-3"]);
  });

  it("returns configs keyed by flow with live roster names and no contact channels", async () => {
    const res = await GET();
    const body = (await res.json()) as {
      tables: Array<{
        flowId: string;
        tableName: string;
        formName: string | null;
        config: { enabled: boolean; mode: string; updated_at: string } | null;
        assignees: Array<Record<string, unknown>>;
      }>;
    };
    const hiring = body.tables.find((t) => t.flowId === "flow-1")!;
    // Canonical display name is the verbatim Workspace table name ...
    expect(hiring.tableName).toBe("Meta Lead Ads · Hiring");
    // ... with the original form name alongside for search richness.
    expect(hiring.formName).toBe("Hiring");
    expect(hiring.config?.enabled).toBe(true);
    expect(hiring.config?.updated_at).toBe("2026-11-20T10:00:00.000Z");
    expect(hiring.assignees).toHaveLength(2);
    // Live roster name wins over the saved display name ...
    expect(hiring.assignees[0].display_name).toBe("Mohan Live");
    // ... while private contact channels stay server-side.
    for (const row of body.tables) {
      for (const a of row.assignees) {
        expect(a).not.toHaveProperty("email");
        expect(a).not.toHaveProperty("phone");
        expect(a).not.toHaveProperty("whatsapp_numbers");
      }
    }
    const travel = body.tables.find((t) => t.flowId === "flow-2")!;
    expect(travel.config?.enabled).toBe(false);
    expect(body.tables.find((t) => t.flowId === "flow-3")!.config).toBeNull();
  });

  it("keeps the full Workspace table name when the form row is gone", async () => {
    h.forms = [];
    const res = await GET();
    const body = (await res.json()) as {
      tables: Array<{ flowId: string; tableName: string; formName: string | null }>;
    };
    const hiring = body.tables.find((t) => t.flowId === "flow-1")!;
    expect(hiring.tableName).toBe("Meta Lead Ads · Hiring");
    expect(hiring.formName).toBeNull();
  });

  it("falls back to the form name (never blank) when the flow name is missing", async () => {
    h.flows = [
      { id: "flow-blank", account_id: "acct-1", kind: "meta_lead_ads", name: "   ", meta_form_id: "form-1" },
      { id: "flow-noname", account_id: "acct-1", kind: "meta_lead_ads", name: null, meta_form_id: null },
    ];
    const res = await GET();
    const body = (await res.json()) as {
      tables: Array<{ flowId: string; tableName: string; formName: string | null }>;
    };
    expect(body.tables.find((t) => t.flowId === "flow-blank")!.tableName).toBe("Hiring");
    expect(body.tables.find((t) => t.flowId === "flow-noname")!.tableName).toBe("Untitled table");
  });

  it("returns an empty list when the account has no Meta tables", async () => {
    h.flows = h.flows.filter((f) => f.kind !== "meta_lead_ads" || f.account_id !== "acct-1");
    const res = await GET();
    expect(await res.json()).toEqual({ tables: [] });
  });
});
