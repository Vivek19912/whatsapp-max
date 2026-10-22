import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  authed: true,
  role: null as string | null,
  contact: { id: "c-1", account_id: "acct-1" } as Record<string, unknown> | null,
  runs: [] as Array<Record<string, unknown>>,
  flows: [] as Array<Record<string, unknown>>,
  // RPC pages keyed `${flowId}|${view}|${page}` → rows.
  pages: {} as Record<string, Array<Record<string, unknown>>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  contactFilters: [] as Array<Array<[string, unknown]>>,
}));

// Minimal thenable query builder honoring the exact chains the
// route builds: contacts(select→eq→eq→maybeSingle) and
// flow_runs(select→eq→eq→order→limit→await).
function builder(table: string) {
  const state = {
    filters: [] as Array<{ col: string; op: string; val: unknown }>,
    orderCol: "",
    orderAsc: true,
    limitN: Number.POSITIVE_INFINITY,
  };
  const rowsFor = () => (table === "flows" ? h.flows : h.runs);
  const applyFilters = (rows: Array<Record<string, unknown>>) =>
    rows.filter((r) =>
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
    order: (col: string, opts?: { ascending?: boolean }) => {
      state.orderCol = col;
      state.orderAsc = opts?.ascending !== false;
      return api;
    },
    limit: (n: number) => {
      state.limitN = n;
      return api;
    },
    maybeSingle: async () => {
      if (table === "contacts") {
        h.contactFilters.push(
          state.filters.map((f) => [f.col, f.val] as [string, unknown]),
        );
        const match =
          h.contact &&
          state.filters.every((f) =>
            f.op === "eq"
              ? h.contact?.[f.col] === f.val
              : (f.val as unknown[]).includes(h.contact?.[f.col]),
          );
        return { data: match ? h.contact : null, error: null };
      }
      return { data: null, error: null };
    },
    then: (resolve: (v: unknown) => unknown) => {
      let rows = [...rowsFor()];
      rows = applyFilters(rows);
      if (state.orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = String(a[state.orderCol] ?? "");
          const bv = String(b[state.orderCol] ?? "");
          if (av === bv) return 0;
          return state.orderAsc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
        });
      }
      return resolve({ data: rows.slice(0, state.limitN), error: null });
    },
  };
  return api;
}

function fakeSupabase() {
  return {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      const key = `${args.p_flow_id}|${args.p_view}|${args.p_page}`;
      return { data: { rows: h.pages[key] ?? [] }, error: null };
    },
  };
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) {
      const err = Object.assign(new Error("Unauthorized"), { status: 401 });
      throw err;
    }
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: "u-1", role: h.role };
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

const { GET } = await import("./route");

const C1 = "11111111-1111-4111-8111-111111111111";

function run(
  id: string,
  flow: string,
  started: string,
  contact = C1,
): Record<string, unknown> {
  return {
    id,
    flow_id: flow,
    contact_id: contact,
    account_id: "acct-1",
    started_at: started,
  };
}

function pageRow(runId: string, contact = C1): Record<string, unknown> {
  return { run_id: runId, contact_id: contact };
}

function get(url: string) {
  return GET(new Request(url));
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.authed = true;
  h.role = null;
  h.contact = { id: C1, account_id: "acct-1" };
  h.runs = [];
  h.flows = [];
  h.pages = {};
  h.rpcCalls = [];
  h.contactFilters = [];
});

describe("GET /api/workspace/locate-contact", () => {
  it("finds a contact on the first page of the default tab", async () => {
    h.runs = [run("r-1", "flow-A", "2026-09-12T10:00:00.000Z")];
    h.pages = { "flow-A|completed|0": [pageRow("r-1")] };
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      found: true,
      flow_id: "flow-A",
      view: "completed",
      page: 0,
      run_id: "r-1",
    });
  });

  it("audit scenario: 81 completed rows, target below page 0 → page 3", async () => {
    h.runs = [run("r-old", "flow-A", "2026-09-12T17:40:00.000Z")];
    const filler = (p: number) =>
      Array.from({ length: 25 }, (_, i) => pageRow(`other-${p}-${i}`, "c-x"));
    h.pages = {
      "flow-A|completed|0": filler(0),
      "flow-A|completed|1": filler(1),
      "flow-A|completed|2": filler(2),
      "flow-A|completed|3": [...filler(3).slice(0, 24), pageRow("r-old")],
    };
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      found: true,
      flow_id: "flow-A",
      view: "completed",
      page: 3,
      run_id: "r-old",
    });
    // Pages scanned ascending with the default page size.
    const calledPages = h.rpcCalls.map((c) => c.args.p_page);
    expect(calledPages).toEqual([0, 1, 2, 3]);
    expect(h.rpcCalls[0]?.args.p_page_size).toBe(25);
  });

  it("finds the contact in another flow (most-recent flow first)", async () => {
    h.runs = [
      run("r-new", "flow-B", "2026-10-01T10:00:00.000Z"),
      run("r-old", "flow-A", "2026-09-01T10:00:00.000Z"),
    ];
    h.pages = {
      "flow-B|completed|0": [pageRow("r-new")],
      "flow-A|completed|0": [pageRow("r-old")],
    };
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(await res.json()).toMatchObject({
      found: true,
      flow_id: "flow-B",
      page: 0,
      run_id: "r-new",
    });
    // Most-recent flow attempted before the older one.
    expect(h.rpcCalls[0]?.args.p_flow_id).toBe("flow-B");
  });

  it("falls back to the incomplete tab when completed is empty", async () => {
    h.runs = [run("r-1", "flow-A", "2026-09-12T10:00:00.000Z")];
    h.pages = {
      "flow-A|completed|0": [],
      "flow-A|incomplete|0": [pageRow("r-1")],
    };
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(await res.json()).toMatchObject({
      found: true,
      flow_id: "flow-A",
      view: "incomplete",
      page: 0,
    });
    const views = h.rpcCalls.map((c) => c.args.p_view);
    expect(views[0]).toBe("completed");
    expect(views).toContain("incomplete");
  });

  it("passes the client's page size through (and clamps garbage)", async () => {
    h.runs = [run("r-1", "flow-A", "2026-09-12T10:00:00.000Z")];
    h.pages = { "flow-A|completed|0": [pageRow("r-1")] };
    await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}&page_size=50`,
    );
    expect(h.rpcCalls[0]?.args.p_page_size).toBe(50);
    h.rpcCalls.length = 0;
    await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}&page_size=bogus`,
    );
    expect(h.rpcCalls[0]?.args.p_page_size).toBe(25);
  });

  it("rejects a malformed contact id", async () => {
    const res = await get(
      "https://app.test/api/workspace/locate-contact?contact_id=nope",
    );
    expect(res.status).toBe(400);
    expect(h.rpcCalls).toEqual([]);
  });

  it("unknown contact → 404 found:false, no table scans", async () => {
    h.contact = null;
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ found: false });
    expect(h.rpcCalls).toEqual([]);
  });

  it("foreign-account contact → same 404 shape (no oracle)", async () => {
    // Contact exists but under another account: the account-scoped
    // lookup returns nothing, identical to "unknown".
    h.contact = null;
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ found: false });
    // …and the contact lookup itself was account-scoped.
    expect(h.contactFilters[0]).toContainEqual(["account_id", "acct-1"]);
    expect(h.contactFilters[0]).toContainEqual(["id", C1]);
  });

  it("contact with zero runs → 200 found:false", async () => {
    h.runs = [];
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false });
    expect(h.rpcCalls).toEqual([]);
  });

  it("unauthenticated → error passthrough, no queries", async () => {
    h.authed = false;
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(res.status).toBe(401);
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("agent scoping on Meta Lead Ads Tables", () => {
  const META = "flow-meta";
  const WA = "flow-wa";

  function seedAgent() {
    h.role = "agent";
    h.flows = [
      { id: META, account_id: "acct-1", kind: "meta_lead_ads" },
      { id: WA, account_id: "acct-1", kind: "whatsapp_flow" },
    ];
  }

  it("forces p_assignee to the agent and finds their own Meta lead", async () => {
    seedAgent();
    h.runs = [run("r-1", META, "2026-09-12T10:00:00.000Z")];
    // The server-side assignee filter returns only the agent's row.
    h.pages = { [`${META}|completed|0`]: [pageRow("r-1")] };
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(await res.json()).toMatchObject({
      found: true,
      flow_id: META,
      run_id: "r-1",
    });
    expect(h.rpcCalls[0]?.args).toMatchObject({
      p_flow_id: META,
      p_assignee: "u-1",
    });
  });

  it("does not surface another agent's lead (server returns no row)", async () => {
    seedAgent();
    h.runs = [run("r-9", META, "2026-09-12T10:00:00.000Z")];
    // The forced assignee filter excludes it server-side.
    h.pages = {};
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(await res.json()).toEqual({ found: false });
    expect(h.rpcCalls[0]?.args).toMatchObject({ p_assignee: "u-1" });
  });

  it("skips non-Meta flows entirely for agents", async () => {
    seedAgent();
    h.runs = [run("r-1", WA, "2026-10-01T10:00:00.000Z")];
    h.pages = { [`${WA}|completed|0`]: [pageRow("r-1")] };
    const res = await get(
      `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
    );
    expect(await res.json()).toEqual({ found: false });
    expect(h.rpcCalls.map((c) => c.args.p_flow_id)).not.toContain(WA);
  });

  it("leaves admins and viewers unfiltered", async () => {
    for (const role of ["admin", "owner", null]) {
      h.role = role;
      h.flows = [{ id: "flow-A", account_id: "acct-1", kind: "meta_lead_ads" }];
      h.runs = [run("r-1", "flow-A", "2026-09-12T10:00:00.000Z")];
      h.pages = { "flow-A|completed|0": [pageRow("r-1")] };
      h.rpcCalls = [];
      const res = await get(
        `https://app.test/api/workspace/locate-contact?contact_id=${C1}`,
      );
      expect(await res.json()).toMatchObject({ found: true, flow_id: "flow-A" });
      expect(h.rpcCalls[0]?.args.p_assignee).toBeNull();
    }
  });
});
