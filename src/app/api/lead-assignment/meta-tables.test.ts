// Lead Assignment tables + events APIs — coverage display and audit reads.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "admin",
  accountId: "acct-1",
  userId: "admin-1",
  rules: [] as Array<Record<string, unknown>>,
  ruleTables: [] as Array<Record<string, unknown>>,
  ruleMembers: [] as Array<Record<string, unknown>>,
  forms: [
    { id: "form-1", account_id: "acct-1", form_id: "F1", form_name: "Hiring" },
    { id: "form-2", account_id: "acct-1", form_id: "F2", form_name: "Travel" },
  ] as Array<Record<string, unknown>>,
  flows: [
    { id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads", name: "V", meta_form_id: "form-1" },
    { id: "flow-2", account_id: "acct-1", kind: "meta_lead_ads", name: "W", meta_form_id: "form-2" },
    { id: "flow-9", account_id: "acct-1", kind: "whatsapp_flow", name: "Chat", meta_form_id: null },
  ] as Array<Record<string, unknown>>,
  profiles: [
    { user_id: "u-mohan", account_id: "acct-1", account_role: "agent" },
  ] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
  },
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

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    orderCol: null as string | null,
    limitN: null as number | null,
  };
  function rows(): Array<Record<string, unknown>> {
    switch (state.table) {
      case "lead_assignment_rules": return h.rules;
      case "lead_assignment_rule_tables": return h.ruleTables;
      case "lead_assignment_rule_members": return h.ruleMembers;
      case "meta_lead_forms": return h.forms;
      case "flows": return h.flows;
      case "profiles": return h.profiles;
      case "lead_assignment_events": return h.events;
      default: return [];
    }
  }
  const matched = () => {
    let list = rows().filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
    if (state.orderCol) {
      const col = state.orderCol;
      list = [...list].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
    }
    if (state.limitN !== null) list = list.slice(0, state.limitN);
    return list;
  };
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
    order: (col: string) => {
      state.orderCol = col;
      return api;
    },
    limit: (n: number) => {
      state.limitN = n;
      return api;
    },
    maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
    single: async () => ({ data: matched()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.orderCol = null;
      state.limitN = null;
      return api;
    },
  };
}

const { GET: tablesGET } = await import("./tables/route");
const { GET: eventsGET } = await import("./events/route");

beforeEach(() => {
  h.authed = true;
  h.role = "admin";
  h.rules = [
    {
      id: "rule-1", account_id: "acct-1", name: "Video", scope: "specific",
      mode: "round_robin", status: "active", created_by: "a",
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    },
  ];
  h.ruleTables = [{ rule_id: "rule-1", form_id: "form-1" }];
  h.ruleMembers = [{ rule_id: "rule-1", user_id: "u-mohan", position: 0, weight: 0 }];
  h.events = [
    {
      id: "e-1", account_id: "acct-1", rule_id: "rule-1", flow_id: "flow-1",
      flow_run_id: "run-1", form_id: "form-1", assigned_user_id: "u-mohan",
      previous_user_id: null, kind: "auto", reason: "round_robin",
      created_by: null, created_at: "2026-01-02T00:00:00Z",
    },
  ];
});

describe("GET /api/lead-assignment/tables", () => {
  it("lists Meta tables with governing rules (WhatsApp flows excluded)", async () => {
    const res = await tablesGET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { tables: Array<Record<string, unknown>> };
    expect(json.tables.map((t) => t.form_id)).toEqual(["form-1", "form-2"]);
    expect(json.tables[0]).toMatchObject({
      label: "Meta Lead Ads · Hiring",
      flow_id: "flow-1",
      governing_rule: { id: "rule-1", name: "Video", mode: "round_robin" },
    });
    expect(json.tables[1]).toMatchObject({ governing_rule: null });
  });

  it("requires admin", async () => {
    h.role = "viewer";
    expect((await tablesGET()).status).toBe(403);
  });
});

describe("GET /api/lead-assignment/events", () => {
  it("returns account audit rows with filters", async () => {
    const all = (await (await eventsGET(new Request("https://app.test/x"))).json()) as {
      events: Array<Record<string, unknown>>;
    };
    expect(all.events).toHaveLength(1);
    const byRun = (await (
      await eventsGET(new Request("https://app.test/x?run_id=run-1"))
    ).json()) as { events: unknown[] };
    expect(byRun.events).toHaveLength(1);
    const none = (await (
      await eventsGET(new Request("https://app.test/x?run_id=run-9"))
    ).json()) as { events: unknown[] };
    expect(none.events).toHaveLength(0);
  });
});
