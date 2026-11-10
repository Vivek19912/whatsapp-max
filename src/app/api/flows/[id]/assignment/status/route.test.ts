// Per-table assignment status API — pause/resume flips only the
// enabled flag, never assignees/mode/templates. No production I/O.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  authed: true,
  flows: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  seq: 0,
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
        ? Number((err as { status?: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => fakeSupabase(),
}));

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function tableRows(table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "flows": return h.flows;
    case "lead_assignment_table_configs": return h.configs;
    case "lead_assignment_table_assignees": return h.assignees;
    case "profiles": return h.profiles;
    case "lead_assignment_table_config_state": return h.states;
    default: return [];
  }
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    insertRows: null as Array<Record<string, unknown>> | null,
    updateObj: null as Record<string, unknown> | null,
  };
  const matched = () =>
    tableRows(state.table).filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      state.filters.push({ col, op: "in", val: vals });
      return api;
    },
    order: () => api,
    update: (obj: Record<string, unknown>) => {
      state.updateObj = obj;
      return api;
    },
    maybeSingle: async () => {
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
    },
    single: async () => {
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return resolve({ data: list, error: null });
      }
      return resolve({ data: matched(), error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.insertRows = null;
      state.updateObj = null;
      return api;
    },
  };
}

const route = await import("./route");

const params = (flowId: string) => ({ params: Promise.resolve({ id: flowId }) });
const post = (body: unknown) =>
  new Request("https://x/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function seed() {
  h.role = "owner";
  h.accountId = "acct-1";
  h.userId = "owner-1";
  h.authed = true;
  h.flows = [
    { id: "flow-meta", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "formdb-1" },
    { id: "flow-other", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "formdb-2" },
    { id: "flow-foreign", account_id: "acct-2", kind: "meta_lead_ads", meta_form_id: "formdb-x" },
  ];
  h.configs = [
    {
      id: "config-1",
      account_id: "acct-1",
      flow_id: "flow-meta",
      enabled: true,
      mode: "round_robin",
      timezone: "Asia/Kolkata",
      whatsapp_template_name: "tpl",
      whatsapp_template_language: "en_US",
    },
  ];
  h.assignees = [
    {
      id: "a-1",
      config_id: "config-1",
      user_id: "u-asha",
      display_name: "Asha",
      email: "asha@x.com",
      phone: null,
      whatsapp_numbers: [],
      position: 0,
      weight: 0,
      is_active: true,
      paused_until: null,
      pause_reason: null,
      pause_scope: "table",
      notify_email: true,
      notify_whatsapp: false,
    },
  ];
  h.profiles = [
    { user_id: "u-asha", account_id: "acct-1", account_role: "agent" },
  ];
  h.states = [];
  h.seq = 0;
}

beforeEach(seed);

describe("POST /flows/[id]/assignment/status", () => {
  it("rejects non-owners", async () => {
    for (const role of ["admin", "agent", "viewer"]) {
      h.role = role;
      const res = await route.POST(post({ action: "pause" }), params("flow-meta"));
      expect(res.status).toBe(403);
    }
    h.role = "owner";
  });

  it("404s foreign tables and tables without a saved config", async () => {
    expect((await route.POST(post({ action: "pause" }), params("flow-foreign"))).status).toBe(404);
    expect((await route.POST(post({ action: "pause" }), params("nope"))).status).toBe(404);
    expect((await route.POST(post({ action: "pause" }), params("flow-other"))).status).toBe(404);
  });

  it("rejects invalid actions and bodies", async () => {
    expect((await route.POST(post({ action: "stop" }), params("flow-meta"))).status).toBe(400);
    expect((await route.POST(post({}), params("flow-meta"))).status).toBe(400);
    const bad = await route.POST(
      new Request("https://x/", { method: "POST", body: "not-json" }),
      params("flow-meta"),
    );
    expect(bad.status).toBe(400);
  });

  it("pause flips enabled to false without touching assignees", async () => {
    const before = JSON.stringify(h.assignees);
    const res = await route.POST(post({ action: "pause" }), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; config: { enabled: boolean; mode: string } };
    expect(json.ok).toBe(true);
    expect(json.config.enabled).toBe(false);
    expect(h.configs[0].enabled).toBe(false);
    // Roster, mode, and template untouched.
    expect(JSON.stringify(h.assignees)).toBe(before);
    expect(h.configs[0].mode).toBe("round_robin");
    expect(h.configs[0].whatsapp_template_name).toBe("tpl");
  });

  it("resume restores enabled without touching assignees", async () => {
    h.configs[0].enabled = false;
    const before = JSON.stringify(h.assignees);
    const res = await route.POST(post({ action: "resume" }), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; config: { enabled: boolean } };
    expect(json.config.enabled).toBe(true);
    expect(JSON.stringify(h.assignees)).toBe(before);
  });

  it("resume rejects a config with no active assignees", async () => {
    h.configs[0].enabled = false;
    h.assignees[0].is_active = false;
    const res = await route.POST(post({ action: "resume" }), params("flow-meta"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("active assignee");
    expect(h.configs[0].enabled).toBe(false);
  });

  it("resume rejects percentage shares that do not total 100%", async () => {
    h.configs[0].enabled = false;
    h.configs[0].mode = "percentage";
    h.assignees = [
      { ...h.assignees[0], id: "a-1", weight: 60 },
      {
        id: "a-2",
        config_id: "config-1",
        user_id: null,
        display_name: "Ext",
        email: "e@x.com",
        phone: null,
        whatsapp_numbers: [],
        position: 1,
        weight: 30,
        is_active: true,
        paused_until: null,
        pause_reason: null,
        pause_scope: "table",
        notify_email: true,
        notify_whatsapp: false,
      },
    ];
    const res = await route.POST(post({ action: "resume" }), params("flow-meta"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("exactly 100%");
    expect(h.configs[0].enabled).toBe(false);
  });

  it("never touches other tables", async () => {
    h.configs.push({
      id: "config-2",
      account_id: "acct-1",
      flow_id: "flow-other",
      enabled: true,
      mode: "round_robin",
      timezone: "Asia/Kolkata",
      whatsapp_template_name: null,
      whatsapp_template_language: "en_US",
    });
    await route.POST(post({ action: "pause" }), params("flow-meta"));
    expect(h.configs.find((c) => c.flow_id === "flow-meta")?.enabled).toBe(false);
    expect(h.configs.find((c) => c.flow_id === "flow-other")?.enabled).toBe(true);
  });
});
