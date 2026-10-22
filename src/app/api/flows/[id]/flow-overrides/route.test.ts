import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  authed: true,
  role: "viewer",
  accountId: "acct-1",
  userId: "user-1",
  flows: [] as Row[],
  flow_runs: [] as Row[],
  flow_nodes: [] as Row[],
  overrides: [] as Row[],
  workspace_fields: [] as Row[],
  workspace_values: [] as Row[],
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

function tables(): Record<string, Row[]> {
  return {
    flows: h.flows,
    flow_runs: h.flow_runs,
    flow_nodes: h.flow_nodes,
    workspace_flow_overrides: h.overrides,
    workspace_fields: h.workspace_fields,
    workspace_values: h.workspace_values,
  };
}

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const rows = tables()[table] ?? [];
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    const matched = () => rows.filter((r) => filters.every((f) => f(r)));
    q.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    q.single = async () => {
      const hit = matched()[0] ?? null;
      return hit
        ? { data: hit, error: null }
        : { data: null, error: { message: "no row", code: "PGRST116" } };
    };
    q.then = (resolve: (v: unknown) => void) =>
      resolve({ data: matched(), error: null });
    q.upsert = (obj: Row) => {
      const at = rows.findIndex(
        (r) =>
          r.account_id === obj.account_id &&
          r.flow_id === obj.flow_id &&
          r.flow_run_id === obj.flow_run_id &&
          r.field_key === obj.field_key,
      );
      const saved = { ...obj };
      if (at >= 0) rows[at] = { ...rows[at], ...saved };
      else rows.push(saved);
      return {
        select: () => ({ single: async () => ({ data: saved, error: null }) }),
      };
    };
    q.delete = () => {
      const chain: Record<string, unknown> = {};
      chain.eq = () => chain;
      chain.then = (resolve: (v: unknown) => void) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (filters.every((f) => f(rows[i]))) rows.splice(i, 1);
        }
        resolve({ error: null });
      };
      return chain;
    };
    return q;
  };
  return api;
}

const { PUT, DELETE } = await import("./route");

function req(method: string, body?: unknown) {
  return new Request("https://app.test/api/flows/flow-1/flow-overrides", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "flow-1" }) };

function seed() {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.flows = [{ id: "flow-1", account_id: "acct-1", entry_node_id: "start" }];
  h.flow_runs = [
    {
      id: "run-1",
      account_id: "acct-1",
      flow_id: "flow-1",
      vars: { Hotel: "5 Star Hotel", City: "Goa" },
    },
    {
      id: "run-2",
      account_id: "acct-1",
      flow_id: "flow-1",
      vars: { Hotel: "3 Star Hotel", City: "Bali" },
    },
  ];
  h.flow_nodes = [
    { node_key: "start", node_type: "start", flow_id: "flow-1", config: {}, created_at: "2026-01-01T00:00:00.000Z" },
    {
      node_key: "q0",
      node_type: "collect_input",
      flow_id: "flow-1",
      config: { prompt_text: "Which hotel?", var_key: "Hotel" },
      created_at: "2026-01-01T00:00:01.000Z",
    },
    {
      node_key: "q1",
      node_type: "collect_input",
      flow_id: "flow-1",
      config: { prompt_text: "Which city?", var_key: "City" },
      created_at: "2026-01-01T00:00:02.000Z",
    },
  ];
  h.overrides = [];
  h.workspace_fields = [];
  h.workspace_values = [];
}

beforeEach(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

function put(body: unknown) {
  return PUT(req("PUT", body), params);
}

describe("PUT flow overrides (agent edits, originals untouched)", () => {
  it("2+3. saves the edit and reports the Workspace value", async () => {
    const res = await put({ flow_run_id: "run-1", field_key: "Hotel", value: "4 Star Hotel" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "4 Star Hotel" });
    expect(h.overrides).toHaveLength(1);
    expect(h.overrides[0]).toMatchObject({
      account_id: "acct-1",
      flow_id: "flow-1",
      flow_run_id: "run-1",
      field_key: "Hotel",
      value_text: "4 Star Hotel",
    });
  });

  it("4+21. the original flow-run answer is never rewritten", async () => {
    await put({ flow_run_id: "run-1", field_key: "Hotel", value: "4 Star Hotel" });
    expect(h.flow_runs[0].vars).toMatchObject({ Hotel: "5 Star Hotel" });
  });

  it("8. one run's edit never leaks into another run", async () => {
    await put({ flow_run_id: "run-1", field_key: "Hotel", value: "4 Star Hotel" });
    expect(h.overrides.every((r) => r.flow_run_id === "run-1")).toBe(true);
  });

  it("9. one field's edit never touches another field", async () => {
    await put({ flow_run_id: "run-1", field_key: "Hotel", value: "4 Star Hotel" });
    expect(h.overrides.map((r) => r.field_key)).toEqual(["Hotel"]);
  });

  it("14. an empty original still accepts a Workspace value", async () => {
    h.flow_runs[0].vars = { Hotel: "", City: "Goa" };
    const res = await put({ flow_run_id: "run-1", field_key: "Hotel", value: "5 Star Hotel" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "5 Star Hotel" });
  });

  it("15. clearing stores an explicit empty (distinct from no override)", async () => {
    const res = await put({ flow_run_id: "run-1", field_key: "Hotel", value: "" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: null });
    expect(h.overrides).toHaveLength(1);
    expect(h.overrides[0].value_text).toBeNull();
  });

  it("saving the original value deletes any override (treated as unchanged)", async () => {
    await put({ flow_run_id: "run-1", field_key: "Hotel", value: "4 Star Hotel" });
    const res = await put({ flow_run_id: "run-1", field_key: "Hotel", value: "5 Star Hotel" });
    expect(await res.json()).toEqual({ value: "5 Star Hotel" });
    expect(h.overrides).toHaveLength(0);
  });

  it("rejects unknown keys, system columns, and foreign runs", async () => {
    expect(
      (await put({ flow_run_id: "run-1", field_key: "Nope", value: "x" })).status,
    ).toBe(400);
    for (const system of ["phone", "submission_time", "status"]) {
      expect(
        (await put({ flow_run_id: "run-1", field_key: system, value: "x" })).status,
      ).toBe(400);
    }
    expect(
      (await put({ flow_run_id: "run-9", field_key: "Hotel", value: "x" })).status,
    ).toBe(404);
    expect(h.overrides).toHaveLength(0);
  });

  it("403s viewers on write", async () => {
    h.role = "viewer";
    const res = await put({ flow_run_id: "run-1", field_key: "Hotel", value: "x" });
    expect(res.status).toBe(403);
  });
});

describe("DELETE flow overrides (Restore original)", () => {
  it("6+7. restore removes the row and reports the original", async () => {
    await put({ flow_run_id: "run-1", field_key: "Hotel", value: "4 Star Hotel" });
    const res = await DELETE(
      req("DELETE", { flow_run_id: "run-1", field_key: "Hotel" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "5 Star Hotel" });
    expect(h.overrides).toHaveLength(0);
    expect(h.flow_runs[0].vars).toMatchObject({ Hotel: "5 Star Hotel" });
  });

  it("16. restore after clearing returns the original value", async () => {
    await put({ flow_run_id: "run-1", field_key: "Hotel", value: "" });
    expect(h.overrides).toHaveLength(1);
    const res = await DELETE(
      req("DELETE", { flow_run_id: "run-1", field_key: "Hotel" }),
      params,
    );
    expect(await res.json()).toEqual({ value: "5 Star Hotel" });
    expect(h.overrides).toHaveLength(0);
  });

  it("restoring a never-edited cell succeeds idempotently", async () => {
    const res = await DELETE(
      req("DELETE", { flow_run_id: "run-1", field_key: "Hotel" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "5 Star Hotel" });
  });
});

describe("select-question option validation", () => {
  function buttonNodes(): void {
    h.flow_nodes = [
      { node_key: "start", node_type: "start", flow_id: "flow-1", config: {}, created_at: "2026-01-01T00:00:00.000Z" },
      {
        node_key: "q0",
        node_type: "send_buttons",
        flow_id: "flow-1",
        config: { text: "Pick", buttons: [{ title: "A" }, { title: "B" }] },
        created_at: "2026-01-01T00:00:01.000Z",
      },
    ];
    h.flow_runs[0].vars = { q0: "A" };
  }

  it("10. accepts a listed option, rejects anything else", async () => {
    buttonNodes();
    expect((await put({ flow_run_id: "run-1", field_key: "q0", value: "B" })).status).toBe(200);
    expect((await put({ flow_run_id: "run-1", field_key: "q0", value: "Z" })).status).toBe(400);
    expect(h.overrides.map((r) => r.value_text)).toEqual(["B"]);
  });
});

describe("agent ownership on Meta Lead Ads Tables", () => {
  function seedMetaOwned() {
    h.role = "agent";
    h.userId = "u-agent";
    h.flows = [
      { id: "flow-1", account_id: "acct-1", kind: "meta_lead_ads", entry_node_id: "start" },
    ];
    h.flow_runs = [
      {
        id: "run-own",
        account_id: "acct-1",
        flow_id: "flow-1",
        vars: { Hotel: "5 Star Hotel" },
      },
      {
        id: "run-other",
        account_id: "acct-1",
        flow_id: "flow-1",
        vars: { Hotel: "3 Star Hotel" },
      },
    ];
    h.workspace_fields = [
      { id: "f-assign", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To" },
    ];
    h.workspace_values = [
      {
        account_id: "acct-1",
        field_id: "f-assign",
        flow_run_id: "run-own",
        value_text: "u-agent",
      },
      {
        account_id: "acct-1",
        field_id: "f-assign",
        flow_run_id: "run-other",
        value_text: "u-teammate",
      },
    ];
  }

  it("lets an agent edit their own Meta lead", async () => {
    seedMetaOwned();
    const res = await put({ flow_run_id: "run-own", field_key: "Hotel", value: "4 Star Hotel" });
    expect(res.status).toBe(200);
    expect(h.overrides).toHaveLength(1);
  });

  it("404s an agent editing another agent's Meta lead (PUT and DELETE)", async () => {
    seedMetaOwned();
    const res = await put({ flow_run_id: "run-other", field_key: "Hotel", value: "x" });
    expect(res.status).toBe(404);
    const del = await DELETE(
      req("DELETE", { flow_run_id: "run-other", field_key: "Hotel" }),
      params,
    );
    expect(del.status).toBe(404);
    expect(h.overrides).toHaveLength(0);
  });

  it("404s an agent on unassigned Meta leads", async () => {
    seedMetaOwned();
    h.workspace_values = h.workspace_values.filter(
      (r) => r.flow_run_id !== "run-other",
    );
    const res = await put({ flow_run_id: "run-other", field_key: "Hotel", value: "x" });
    expect(res.status).toBe(404);
    expect(h.overrides).toHaveLength(0);
  });

  it("leaves admins and Flow Tables untouched", async () => {
    seedMetaOwned();
    h.role = "admin";
    h.userId = "u-admin";
    const adminRes = await put({ flow_run_id: "run-other", field_key: "Hotel", value: "x" });
    expect(adminRes.status).toBe(200);
    // Non-Meta flows keep existing behavior for agents.
    h.role = "agent";
    h.userId = "u-agent";
    h.flows = [{ id: "flow-1", account_id: "acct-1", entry_node_id: "start" }];
    const flowRes = await put({ flow_run_id: "run-own", field_key: "City", value: "Goa" });
    expect(flowRes.status).toBe(200);
    expect(h.overrides).toHaveLength(2);
  });
});
