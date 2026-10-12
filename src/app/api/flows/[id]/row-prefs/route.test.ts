import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_1 = "11111111-1111-4111-8111-111111111111";
const RUN_2 = "22222222-2222-4222-8222-222222222222";
const RUN_3 = "33333333-3333-4333-8333-333333333333";
const RUN_GONE = "99999999-9999-4999-8999-999999999999";
const USER_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => ({
  role: "agent" as string | null,
  accountId: "acct-1",
  // NOTE: vi.hoisted runs before module consts, so the user ids
  // below are set in beforeEach — never reference USER_1 here.
  userId: "",
  flow: {
    id: "flow-1",
    account_id: "acct-1",
  } as Record<string, unknown> | null,
  runs: [] as Array<{
    id: string;
    flow_id: string;
    account_id: string;
    contact_id: string | null;
  }>,
  contacts: [] as Array<{
    id: string;
    name: string | null;
    phone: string | null;
  }>,
  prefs: [] as Array<{
    user_id: string;
    account_id: string;
    flow_id: string;
    flow_run_id: string;
    is_pinned: boolean;
    is_hidden: boolean;
  }>,
  rpcError: null as { code: string; message: string } | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  failTable: null as string | null,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function rowsFor(table: string): Array<Record<string, unknown>> {
  if (table === "flow_runs")
    return h.runs as unknown as Array<Record<string, unknown>>;
  if (table === "contacts")
    return h.contacts as unknown as Array<Record<string, unknown>>;
  if (table === "workspace_row_prefs")
    return h.prefs as unknown as Array<Record<string, unknown>>;
  throw new Error(`unexpected table ${table}`);
}

function applyFilters(
  rows: Array<Record<string, unknown>>,
  filters: Filter[],
): Array<Record<string, unknown>> {
  return rows.filter((r) =>
    filters.every((f) =>
      f.op === "eq"
        ? r[f.col] === f.val
        : (f.val as unknown[]).includes(r[f.col]),
    ),
  );
}

// Chainable select builder: .eq().eq()… then .maybeSingle() or a
// direct await (thenable) — the two shapes the route uses.
function selectQuery(table: string) {
  const filters: Filter[] = [];
  const q: Record<string, unknown> = {};
  q.eq = (col: string, val: unknown) => {
    filters.push({ col, op: "eq", val });
    return q;
  };
  q.in = (col: string, vals: unknown) => {
    filters.push({ col, op: "in", val: vals });
    return q;
  };
  q.maybeSingle = async () => {
    if (h.failTable === table)
      return { data: null, error: { message: "db down", code: "XX000" } };
    return { data: applyFilters(rowsFor(table), filters)[0] ?? null, error: null };
  };
  q.then = (resolve: (v: unknown) => unknown) => {
    if (h.failTable === table)
      return resolve({
        data: null,
        error: { message: "db down", code: "XX000" },
      });
    return resolve({ data: applyFilters(rowsFor(table), filters), error: null });
  };
  return q;
}

// Mirrors migration 117's set_workspace_row_pref: NULL preserves,
// both-false deletes, upsert never duplicates.
function rpcSetPref(args: Record<string, unknown>) {
  const key = {
    user_id: h.userId,
    flow_id: args.p_flow_id as string,
    flow_run_id: args.p_flow_run_id as string,
  };
  const existing = h.prefs.find(
    (p) =>
      p.user_id === key.user_id &&
      p.flow_id === key.flow_id &&
      p.flow_run_id === key.flow_run_id,
  );
  const pinned =
    args.p_pinned === null || args.p_pinned === undefined
      ? (existing?.is_pinned ?? false)
      : (args.p_pinned as boolean);
  const hidden =
    args.p_hidden === null || args.p_hidden === undefined
      ? (existing?.is_hidden ?? false)
      : (args.p_hidden as boolean);
  h.prefs = h.prefs.filter(
    (p) =>
      !(
        p.user_id === key.user_id &&
        p.flow_id === key.flow_id &&
        p.flow_run_id === key.flow_run_id
      ),
  );
  if (pinned || hidden) {
    h.prefs.push({
      ...key,
      account_id: h.accountId,
      is_pinned: pinned,
      is_hidden: hidden,
    });
  }
  return { data: { flow_run_id: key.flow_run_id, pinned, hidden }, error: null };
}

// Mirrors restore_workspace_hidden_rows: clears hidden, keeps pins.
function rpcRestoreAll(args: Record<string, unknown>) {
  const mine = h.prefs.filter(
    (p) =>
      p.user_id === h.userId &&
      p.flow_id === (args.p_flow_id as string) &&
      p.is_hidden,
  );
  for (const p of mine) p.is_hidden = false;
  h.prefs = h.prefs.filter((p) => p.is_pinned || p.is_hidden);
  return { data: mine.length, error: null };
}

function fakeSupabase() {
  const chain: Record<string, unknown> = {};
  chain.from = (table: string) => {
    if (table === "flows") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: h.flow, error: null }),
          }),
        }),
      };
    }
    if (
      table === "flow_runs" ||
      table === "contacts" ||
      table === "workspace_row_prefs"
    ) {
      return { select: () => selectQuery(table) };
    }
    throw new Error(`unexpected table ${table}`);
  };
  chain.rpc = async (fn: string, args: Record<string, unknown>) => {
    h.rpcCalls.push({ fn, args });
    if (h.rpcError) {
      const err = h.rpcError;
      h.rpcError = null;
      return { data: null, error: err };
    }
    if (fn === "set_workspace_row_pref") return rpcSetPref(args);
    if (fn === "restore_workspace_hidden_rows") return rpcRestoreAll(args);
    throw new Error(`unexpected rpc ${fn}`);
  };
  return chain;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: h.userId,
  }),
  requireRole: async (min: string) => {
    if (!h.role) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = {
      viewer: 1,
      agent: 2,
      admin: 3,
      owner: 4,
    };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) {
      throw statusError(403, "Forbidden");
    }
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

const { GET, PUT, DELETE } = await import("./route");

function get(flowId: string) {
  return GET(new Request("https://app.test/x"), {
    params: Promise.resolve({ id: flowId }),
  });
}

function put(flowId: string, body: unknown) {
  return PUT(
    new Request("https://app.test/x", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: flowId }) },
  );
}

function del(flowId: string, body: unknown) {
  return DELETE(
    new Request("https://app.test/x", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: flowId }) },
  );
}

beforeEach(() => {
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = USER_1;
  h.flow = { id: "flow-1", account_id: "acct-1" };
  h.runs = [
    { id: RUN_1, flow_id: "flow-1", account_id: "acct-1", contact_id: "c-1" },
    { id: RUN_2, flow_id: "flow-1", account_id: "acct-1", contact_id: null },
    { id: RUN_3, flow_id: "flow-2", account_id: "acct-1", contact_id: "c-1" },
  ];
  h.contacts = [{ id: "c-1", name: "Asha", phone: "+91111" }];
  h.prefs = [];
  h.rpcError = null;
  h.rpcCalls = [];
  h.failTable = null;
});

describe("GET row prefs", () => {
  it("returns pinned ids + hidden rows with names/phones (viewers may read)", async () => {
    h.role = "viewer";
    h.prefs = [
      { user_id: USER_1, account_id: "acct-1", flow_id: "flow-1", flow_run_id: RUN_1, is_pinned: true, is_hidden: false },
      { user_id: USER_1, account_id: "acct-1", flow_id: "flow-1", flow_run_id: RUN_2, is_pinned: false, is_hidden: true },
    ];
    const res = await get("flow-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pinned: [RUN_1],
      hidden: [{ flow_run_id: RUN_2, name: null, phone: null }],
    });
  });

  it("identifies hidden rows by lead name + phone; drops runs gone from the flow", async () => {
    h.prefs = [
      { user_id: USER_1, account_id: "acct-1", flow_id: "flow-1", flow_run_id: RUN_1, is_pinned: false, is_hidden: true },
      { user_id: USER_1, account_id: "acct-1", flow_id: "flow-1", flow_run_id: RUN_GONE, is_pinned: false, is_hidden: true },
    ];
    expect(await (await get("flow-1")).json()).toEqual({
      pinned: [],
      hidden: [{ flow_run_id: RUN_1, name: "Asha", phone: "+91111" }],
    });
  });

  it("starts empty, scopes to this flow, and 404s cross-account flows", async () => {
    expect(await (await get("flow-1")).json()).toEqual({ pinned: [], hidden: [] });
    h.prefs = [
      { user_id: USER_1, account_id: "acct-1", flow_id: "flow-2", flow_run_id: RUN_3, is_pinned: true, is_hidden: true },
    ];
    expect(await (await get("flow-1")).json()).toEqual({ pinned: [], hidden: [] });
    h.flow = null;
    expect((await get("flow-1")).status).toBe(404);
  });

  it("never exposes another user's preferences", async () => {
    h.prefs = [
      { user_id: USER_2, account_id: "acct-1", flow_id: "flow-1", flow_run_id: RUN_1, is_pinned: true, is_hidden: true },
    ];
    expect(await (await get("flow-1")).json()).toEqual({ pinned: [], hidden: [] });
  });

  it("database failures surface as 500, never partial data", async () => {
    h.failTable = "workspace_row_prefs";
    const res = await get("flow-1");
    expect(res.status).toBe(500);
  });
});

describe("PUT row prefs — pin/unpin/hide (1/2/3/10)", () => {
  it("pins a row that GET then returns (persists across calls)", async () => {
    const res = await put("flow-1", { flow_run_id: RUN_1, pinned: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flow_run_id: RUN_1, pinned: true, hidden: false });
    expect(await (await get("flow-1")).json()).toEqual({ pinned: [RUN_1], hidden: [] });
  });

  it("pin and hide stay independent (setting one preserves the other)", async () => {
    await put("flow-1", { flow_run_id: RUN_1, pinned: true });
    await put("flow-1", { flow_run_id: RUN_1, hidden: true });
    expect(await (await get("flow-1")).json()).toEqual({
      pinned: [RUN_1],
      hidden: [{ flow_run_id: RUN_1, name: "Asha", phone: "+91111" }],
    });
    // Unpin keeps the hide.
    await put("flow-1", { flow_run_id: RUN_1, pinned: false });
    expect(await (await get("flow-1")).json()).toEqual({
      pinned: [],
      hidden: [{ flow_run_id: RUN_1, name: "Asha", phone: "+91111" }],
    });
  });

  it("clearing both flags deletes the preference row (restore converges here)", async () => {
    await put("flow-1", { flow_run_id: RUN_1, pinned: true, hidden: true });
    expect(h.prefs).toHaveLength(1);
    const res = await put("flow-1", { flow_run_id: RUN_1, pinned: false, hidden: false });
    expect(res.status).toBe(200);
    expect(h.prefs).toHaveLength(0);
    expect(await (await get("flow-1")).json()).toEqual({ pinned: [], hidden: [] });
  });

  it("repeated toggles never duplicate records (idempotent upsert)", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await put("flow-1", { flow_run_id: RUN_1, pinned: true })).status).toBe(200);
    }
    expect(h.prefs).toHaveLength(1);
    expect(h.rpcCalls).toHaveLength(3);
  });

  it("validates ids and body shape with 400s; writes nothing", async () => {
    for (const bad of [
      { flow_run_id: "not-a-uuid", pinned: true },
      { flow_run_id: RUN_1, pinned: "yes" },
      { flow_run_id: RUN_1, hidden: 1 },
      { flow_run_id: RUN_1 },
      null,
      [],
    ]) {
      expect((await put("flow-1", bad)).status).toBe(400);
    }
    expect(h.prefs).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("rejects runs outside this flow as not-found (no existence oracle)", async () => {
    // RUN_3 lives in flow-2; RUN_GONE lives nowhere.
    expect((await put("flow-1", { flow_run_id: RUN_3, pinned: true })).status).toBe(404);
    expect((await put("flow-1", { flow_run_id: RUN_GONE, hidden: true })).status).toBe(404);
    expect(h.prefs).toHaveLength(0);
  });

  it("maps RPC row-not-found to 404 and unexpected failures to safe errors", async () => {
    h.rpcError = { code: "22023", message: "Row not found in this flow" };
    expect((await put("flow-1", { flow_run_id: RUN_1, pinned: true })).status).toBe(404);
    h.rpcError = { code: "XX000", message: "boom" };
    expect((await put("flow-1", { flow_run_id: RUN_1, pinned: true })).status).toBe(500);
  });

  it("viewers cannot write; cross-account writes 404 (8/9)", async () => {
    h.role = "viewer";
    expect((await put("flow-1", { flow_run_id: RUN_1, pinned: true })).status).toBe(403);
    h.role = "agent";
    h.flow = null;
    expect((await put("flow-1", { flow_run_id: RUN_1, pinned: true })).status).toBe(404);
    expect(h.prefs).toHaveLength(0);
  });
});

describe("DELETE row prefs — restore all hidden (5/6/7)", () => {
  it("restores every hidden row but keeps pins", async () => {
    h.prefs = [
      { user_id: USER_1, account_id: "acct-1", flow_id: "flow-1", flow_run_id: RUN_1, is_pinned: true, is_hidden: true },
      { user_id: USER_1, account_id: "acct-1", flow_id: "flow-1", flow_run_id: RUN_2, is_pinned: false, is_hidden: true },
    ];
    const res = await del("flow-1", { all_hidden: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: 2 });
    expect(await (await get("flow-1")).json()).toEqual({ pinned: [RUN_1], hidden: [] });
  });

  it("restoring with nothing hidden returns zero (idempotent)", async () => {
    const res = await del("flow-1", { all_hidden: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: 0 });
  });

  it("never touches another user's or another flow's hidden rows", async () => {
    h.prefs = [
      { user_id: USER_2, account_id: "acct-1", flow_id: "flow-1", flow_run_id: RUN_1, is_pinned: false, is_hidden: true },
      { user_id: USER_1, account_id: "acct-1", flow_id: "flow-2", flow_run_id: RUN_3, is_pinned: false, is_hidden: true },
    ];
    expect(await (await del("flow-1", { all_hidden: true })).json()).toEqual({ restored: 0 });
    expect(h.prefs).toHaveLength(2);
  });

  it("rejects anything but { all_hidden: true }; viewers cannot restore", async () => {
    for (const bad of [{}, { all_hidden: false }, { flow_run_id: RUN_1 }, null]) {
      expect((await del("flow-1", bad)).status).toBe(400);
    }
    h.role = "viewer";
    expect((await del("flow-1", { all_hidden: true })).status).toBe(403);
    h.role = "agent";
    h.flow = null;
    expect((await del("flow-1", { all_hidden: true })).status).toBe(404);
  });
});
