// GET /api/workspace/my-tables — agent-scoped Meta table list.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "u-agent",
  flows: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
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
    return {
      supabase: fakeSupabase(),
      accountId: h.accountId,
      userId: h.userId,
      role: h.role,
    };
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

function fakeSupabase() {
  const state = { table: "", filters: [] as Array<{ col: string; val: unknown }> };
  const rows = () => {
    if (state.table === "flows") return h.flows;
    if (state.table === "workspace_fields") return h.fields;
    if (state.table === "workspace_values") return h.values;
    return [];
  };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, val });
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      state.filters.push({ col, val: vals });
      return api;
    },
    order: () => api,
    maybeSingle: async () => ({ data: null as unknown, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const matched = rows().filter((r) =>
        state.filters.every((f) =>
          Array.isArray(f.val) ? (f.val as unknown[]).includes(r[f.col]) : r[f.col] === f.val,
        ),
      );
      return resolve({ data: matched, error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      return api;
    },
  };
}

const { GET } = await import("./route");

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "u-agent";
  h.flows = [
    { id: "flow-own", account_id: "acct-1", kind: "meta_lead_ads", name: "Hiring" },
    { id: "flow-other", account_id: "acct-1", kind: "meta_lead_ads", name: "Travel" },
    { id: "flow-empty", account_id: "acct-1", kind: "meta_lead_ads", name: "Empty" },
    { id: "flow-wa", account_id: "acct-1", kind: "whatsapp_flow", name: "Chat" },
  ];
  h.fields = [
    { id: "f-own", account_id: "acct-1", flow_id: "flow-own", name: "Assigned To" },
    { id: "f-other", account_id: "acct-1", flow_id: "flow-other", name: "Assigned To" },
    { id: "f-empty", account_id: "acct-1", flow_id: "flow-empty", name: "Assigned To" },
  ];
  h.values = [
    { account_id: "acct-1", field_id: "f-own", flow_run_id: "run-1", value_text: "u-agent" },
    { account_id: "acct-1", field_id: "f-own", flow_run_id: "run-2", value_text: "u-agent" },
    { account_id: "acct-1", field_id: "f-other", flow_run_id: "run-9", value_text: "u-teammate" },
  ];
});

describe("GET /api/workspace/my-tables", () => {
  it("lists only Meta tables with the agent's assigned leads + counts", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tables: [{ flow_id: "flow-own", name: "Hiring", assigned_count: 2 }],
    });
  });

  it("returns an empty list when the agent owns nothing", async () => {
    h.values = [];
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tables: [] });
  });

  it("ignores other accounts' rows", async () => {
    h.values = [
      { account_id: "other-acct", field_id: "f-own", flow_run_id: "run-x", value_text: "u-agent" },
    ];
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tables: [] });
  });

  it("requires sign-in; viewers are rejected", async () => {
    h.authed = false;
    expect((await GET()).status).toBe(401);
    h.authed = true;
    h.role = "viewer";
    expect((await GET()).status).toBe(403);
  });
});
