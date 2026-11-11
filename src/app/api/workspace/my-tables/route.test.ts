// GET /api/workspace/my-tables — account-wide Meta table list for agents.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "u-agent",
  // Inbox permission grant for the caller (null = no grants).
  perm: null as null | { can_view_all: boolean; can_manage_assignments: boolean },
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
    maybeSingle: async () => {
      if (state.table === "agent_inbox_permissions") {
        if (!h.perm) return { data: null, error: null };
        return {
          data: {
            can_manage_assignments: h.perm.can_manage_assignments,
            can_view_all: h.perm.can_view_all,
          },
          error: null,
        };
      }
      return { data: null as unknown, error: null };
    },
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
  h.perm = null;
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
  it("agent WITHOUT View All sees only tables with own assigned leads", async () => {
    h.perm = null;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tables: [{ flow_id: "flow-own", name: "Hiring", assigned_count: 2 }],
    });
  });

  it("agent WITHOUT View All and no own leads sees no tables", async () => {
    h.values = [];
    h.perm = null;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tables: [] });
  });

  it("agent WITH View All sees all tables with own counts", async () => {
    h.perm = { can_view_all: true, can_manage_assignments: false };
    const res = await GET();
    expect(res.status).toBe(200);
    // Mock preserves insertion order (real DB orders by name).
    expect(await res.json()).toEqual({
      tables: [
        { flow_id: "flow-own", name: "Hiring", assigned_count: 2 },
        { flow_id: "flow-other", name: "Travel", assigned_count: 0 },
        { flow_id: "flow-empty", name: "Empty", assigned_count: 0 },
      ],
    });
  });

  it("agent WITH View All and no own leads still sees all tables", async () => {
    h.values = [];
    h.perm = { can_view_all: true, can_manage_assignments: false };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tables: [
        { flow_id: "flow-own", name: "Hiring", assigned_count: 0 },
        { flow_id: "flow-other", name: "Travel", assigned_count: 0 },
        { flow_id: "flow-empty", name: "Empty", assigned_count: 0 },
      ],
    });
  });

  it("Manage Assignments alone does not broaden the table list", async () => {
    h.perm = { can_view_all: false, can_manage_assignments: true };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tables: [{ flow_id: "flow-own", name: "Hiring", assigned_count: 2 }],
    });
  });

  it("ignores other accounts' rows (restricted agent sees nothing)", async () => {
    h.values = [
      { account_id: "other-acct", field_id: "f-own", flow_run_id: "run-x", value_text: "u-agent" },
    ];
    h.perm = null;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tables: [] });
  });

  it("agent WITH View All still lists all tables when only foreign rows exist", async () => {
    h.values = [
      { account_id: "other-acct", field_id: "f-own", flow_run_id: "run-x", value_text: "u-agent" },
    ];
    h.perm = { can_view_all: true, can_manage_assignments: false };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tables: [
        { flow_id: "flow-own", name: "Hiring", assigned_count: 0 },
        { flow_id: "flow-other", name: "Travel", assigned_count: 0 },
        { flow_id: "flow-empty", name: "Empty", assigned_count: 0 },
      ],
    });
  });

  it("requires sign-in; viewers are rejected", async () => {
    h.authed = false;
    expect((await GET()).status).toBe(401);
    h.authed = true;
    h.role = "viewer";
    expect((await GET()).status).toBe(403);
  });
});
