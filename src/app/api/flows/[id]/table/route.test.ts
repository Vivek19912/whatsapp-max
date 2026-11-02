import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "u-1" } as { id: string } | null,
  flow: {
    id: "flow-1",
    account_id: "acct-1",
    name: "Singapore Chat Automation",
    completion_node_id: null,
    entry_node_id: "start",
  } as Record<string, unknown> | null,
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "q0" },
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      node_key: "q0",
      node_type: "collect_input",
      config: {
        prompt_text: "May I know your Full Name?",
        var_key: "Name",
        next_node_key: "q1",
      },
      created_at: "2026-01-01T00:00:01.000Z",
    },
    {
      node_key: "q1",
      node_type: "collect_input",
      config: {
        prompt_text: "Travel date?",
        var_key: "TravelDate",
        next_node_key: "end",
      },
      created_at: "2026-01-01T00:00:02.000Z",
    },
    { node_key: "end", node_type: "end", config: {} },
  ] as Array<Record<string, unknown>>,
  rpc: {
    total: 2,
    rows: [
      {
        run_id: "run-1",
        contact_id: "c-1",
        contact_name: "Rahul",
        contact_phone: "+91111",
        conversation_id: "conv-1",
        status: "completed",
        started_at: "2026-09-18T10:00:00.000Z",
        last_advanced_at: "2026-09-18T10:05:00.000Z",
        ended_at: "2026-09-18T10:05:00.000Z",
        reached_at: null,
        is_completed: true,
        vars: { Name: "Rahul", TravelDate: "October" },
      },
      {
        run_id: "run-2",
        contact_id: "c-2",
        contact_name: null,
        contact_phone: "+91222",
        conversation_id: null,
        status: "active",
        started_at: "2026-09-18T09:00:00.000Z",
        last_advanced_at: "2026-09-18T09:01:00.000Z",
        ended_at: null,
        reached_at: null,
        is_completed: false,
        vars: {},
      },
    ],
  } as Record<string, unknown>,
  rpcArgs: null as Record<string, unknown> | null,
  // Agent flow-answer overrides (workspace_flow_overrides rows).
  overrides: [] as Array<Record<string, unknown>>,
  // Media messages for the page's conversations (messages rows).
  messages: [] as Array<Record<string, unknown>>,
  // Call recordings for the page's contacts (call_recordings rows).
  recordings: [] as Array<Record<string, unknown>>,
  // Uploader profiles (profiles rows).
  profiles: [] as Array<Record<string, unknown>>,
  // Service-role provisioning capture (default business columns).
  adminFields: [] as Array<Record<string, unknown>>,
  adminInserts: [] as Array<Record<string, unknown>[]>,
  adminScopes: [] as Array<{ accountId: unknown; flowId: unknown }>,
  // Meta form row (questions with option metadata) for Meta tables.
  metaForm: null as Record<string, unknown> | null,
}));

function tableBuilder(rows: unknown) {
  const builder: Record<string, (...args: never[]) => unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.order = () => builder;
  builder.maybeSingle = async () => ({ data: rows, error: null });
  return builder;
}

function adminFieldsBuilder() {
  return {
    select: () => ({
      eq: (col: string, val: unknown) => ({
        eq: async (col2: string, val2: unknown) => {
          const scope = { accountId: undefined as unknown, flowId: undefined as unknown };
          for (const [c, v] of [
            [col, val],
            [col2, val2],
          ] as Array<[string, unknown]>) {
            if (c === "account_id") scope.accountId = v;
            if (c === "flow_id") scope.flowId = v;
          }
          h.adminScopes.push(scope);
          return { data: h.adminFields, error: null };
        },
      }),
    }),
    insert: async (rows: Array<Record<string, unknown>>) => {
      h.adminInserts.push(rows);
      return { data: rows, error: null };
    },
  };
}

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "workspace_fields") return adminFieldsBuilder();
      throw new Error(`unexpected admin table ${table}`);
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: (table: string) => {
      if (table === "flows") return tableBuilder(h.flow);
      if (table === "workspace_fields") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "workspace_values") {
        return {
          select: () => ({
            in: async () => ({ data: [], error: null }),
          }),
        };
      }
      if (table === "workspace_flow_overrides") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: async () => ({ data: h.overrides, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "meta_lead_forms") {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: h.metaForm, error: null });
        return chain;
      }
      if (table === "contacts") {
        return {
          select: () => ({
            in: async () => ({
              data: [
                { id: "c-1", source_url: "https://fb.me/9NXAdJ5P2" },
                { id: "c-2", source_url: null },
              ],
              error: null,
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          select: () => ({
            in: () => ({
              not: () => ({
                order: async () => ({ data: h.messages, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "call_recordings") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => ({
                  order: () => ({
                    order: () => ({
                      order: async () => ({ data: h.recordings, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            in: async () => ({ data: h.profiles, error: null }),
            eq: (_col: string, val: unknown) => ({
              maybeSingle: async () => ({
                data:
                  (h.profiles as Array<Record<string, unknown>>).find(
                    (p) => p.user_id === val,
                  ) ?? null,
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: h.nodes, error: null }),
          }),
        }),
      };
    },
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      h.rpcArgs = args;
      return { data: h.rpc, error: null };
    },
  };
  return {
    createClient: async () => client,
    createBufferedServerClient: async () => ({
      client,
      commit: vi.fn(),
      discard: vi.fn(),
    }),
  };
});

const { GET } = await import("./route");

beforeEach(() => {
  h.user = { id: "u-1" };
  h.flow = {
    id: "flow-1",
    account_id: "acct-1",
    name: "Singapore Chat Automation",
    completion_node_id: null,
    entry_node_id: "start",
  };
  h.rpcArgs = null;
  h.overrides = [];
  h.messages = [];
  h.recordings = [];
  h.profiles = [];
  h.adminFields = [];
  h.adminInserts = [];
  h.adminScopes = [];
  h.metaForm = null;
});

describe("GET /api/flows/[id]/table", () => {
  it("3. returns the dynamic flow name with derived columns and run rows", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const meta = json.meta as Record<string, unknown>;
    // Flow name is dynamic — straight from the flow record.
    expect(meta.flowName).toBe("Singapore Chat Automation");
    expect(meta.completionNodeId).toBeNull();
    const columns = json.columns as Array<{ key: string; label: string }>;
    expect(columns.map((c) => c.key)).toContain("TravelDate");
    const rows = json.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // One row per flow_run_id with classification attached.
    expect(rows[0]).toMatchObject({ runId: "run-1", status: "completed" });
    expect(rows[1]).toMatchObject({ runId: "run-2", status: "incomplete" });
    // Dynamic answers projected; RPC was scoped to this flow.
    expect((rows[0] as { answers: unknown }).answers).toMatchObject({
      TravelDate: "October",
    });
    expect(h.rpcArgs).toMatchObject({ p_flow_id: "flow-1", p_view: "all" });
  });

  it("forwards the completed/incomplete view server-side", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table?view=completed"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({ p_view: "completed" });
  });

  it("exposes custom Workspace fields/values additively", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.customFields).toEqual([]);
    expect(json.customValues).toEqual({});
    // Existing shape preserved.
    expect(Array.isArray(json.columns)).toBe(true);
    expect(Array.isArray(json.rows)).toBe(true);
  });

  it("attaches each row's own contact source URL (batched, per contact)", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      rows: Array<{ runId: string; sourceUrl?: string | null }>;
    };
    const byRun = new Map(json.rows.map((r) => [r.runId, r.sourceUrl]));
    // run-1's contact c-1 carries the ad URL; run-2's has none.
    expect(byRun.get("run-1")).toBe("https://fb.me/9NXAdJ5P2");
    expect(byRun.get("run-2") ?? null).toBeNull();
  });

  it("rejects unknown views and unauthorized callers", async () => {
    const bad = await GET(
      new Request("https://app.test/api/flows/flow-1/table?view=done"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(bad.status).toBe(400);
    h.user = null;
    const anon = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(anon.status).toBe(401);
  });

  it("16. isolates accounts — another account's flow reads as not found", async () => {
    h.flow = null;
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(404);
    // No provisioning is attempted for a flow the caller may not see.
    expect(h.adminInserts).toHaveLength(0);
  });

  it("provisions the same flow-scoped defaults for Completed and Incomplete", async () => {
    for (const view of ["completed", "incomplete"]) {
      const res = await GET(
        new Request(`https://app.test/api/flows/flow-1/table?view=${view}`),
        { params: Promise.resolve({ id: "flow-1" }) },
      );
      expect(res.status).toBe(200);
    }
    // Both views share ONE flow-scoped definition — the same 12
    // names scoped to the same (account, flow), never per-view
    // records. (Cross-request dedupe is covered by the idempotency
    // unit tests; the route mock does not persist between calls.)
    expect(h.adminInserts).toHaveLength(2);
    for (const rows of h.adminInserts) {
      expect(rows.map((r) => r.name)).toEqual([
        "Assigned To",
        "Call Status",
        "No. of Calls Tried",
        "Lead Type",
        "Stage",
        "Follow-Up Status",
        "Last Contact Date",
        "Customer Response",
        "Next Follow-up Date & Time",
        "Next Action",
        "Reason for Lost Lead",
        "Final Remark",
        "Lead Received",
      ]);
      for (const row of rows) {
        expect(row.account_id).toBe("acct-1");
        expect(row.flow_id).toBe("flow-1");
      }
    }
    expect(h.adminScopes).toEqual([
      { accountId: "acct-1", flowId: "flow-1" },
      { accountId: "acct-1", flowId: "flow-1" },
    ]);
  });

  it("skips provisioning when the flow already has its defaults", async () => {
    h.adminFields = [{ name: "Assigned To", position: 0 }];
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table?view=completed"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    // Only the 12 missing columns are filled — the existing one kept.
    expect(h.adminInserts).toHaveLength(1);
    expect(h.adminInserts[0]).toHaveLength(12);
    expect(
      (h.adminInserts[0] as Array<Record<string, unknown>>).map((r) => r.name),
    ).not.toContain("Assigned To");
  });
});

describe("GET table with Workspace filters (server-side)", () => {
  const MEMBER = "11111111-1111-4111-8111-111111111111";
  const FROM = "2026-09-18T00:00:00.000Z";
  const TO = "2026-09-25T00:00:00.000Z";

  it("forwards date + assignee into the paginated RPC", async () => {
    const res = await GET(
      new Request(
        `https://app.test/api/flows/flow-1/table?view=completed&dateFrom=${encodeURIComponent(FROM)}&dateTo=${encodeURIComponent(TO)}&assignee=${MEMBER}`,
      ),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    // Server-side: the RPC paginates the FILTERED set (total + page
    // slice computed after every predicate — rows are never fanned
    // out to the browser).
    expect(h.rpcArgs).toMatchObject({
      p_flow_id: "flow-1",
      p_view: "completed",
      p_started_from: FROM,
      p_started_to: TO,
      p_assignee: MEMBER,
    });
    const json = (await res.json()) as {
      meta: { filters: { dateFrom: string; dateTo: string; assignee: string } };
    };
    expect(json.meta.filters).toEqual({ dateFrom: FROM, dateTo: TO, assignee: MEMBER });
  });

  it("12. completed and incomplete both respect the filters", async () => {
    for (const view of ["completed", "incomplete"]) {
      const res = await GET(
        new Request(
          `https://app.test/api/flows/flow-1/table?view=${view}&dateFrom=${encodeURIComponent(FROM)}&dateTo=${encodeURIComponent(TO)}&assignee=unassigned`,
        ),
        { params: Promise.resolve({ id: "flow-1" }) },
      );
      expect(res.status).toBe(200);
      expect(h.rpcArgs).toMatchObject({
        p_view: view,
        p_started_from: FROM,
        p_started_to: TO,
        p_assignee: "unassigned",
      });
    }
  });

  it("7/13. unassigned + search combine with filters in one RPC call", async () => {
    const res = await GET(
      new Request(
        `https://app.test/api/flows/flow-1/table?view=incomplete&search=rahul&page=2&pageSize=50&assignee=unassigned`,
      ),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({
      p_view: "incomplete",
      p_search: "rahul",
      p_page: 2,
      p_page_size: 50,
      p_assignee: "unassigned",
      p_started_from: null,
      p_started_to: null,
    });
  });

  it("11. unfiltered reads pass null/all (byte-identical to before)", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table?view=all"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({
      p_started_from: null,
      p_started_to: null,
      p_assignee: "all",
    });
    const json = (await res.json()) as {
      meta: { filters: { dateFrom: null; dateTo: null; assignee: string } };
    };
    expect(json.meta.filters).toEqual({ dateFrom: null, dateTo: null, assignee: "all" });
  });

  it("unknown member ids forward for zero-match (never 400 the table)", async () => {
    const res = await GET(
      new Request(
        "https://app.test/api/flows/flow-1/table?assignee=99999999-9999-4999-8999-999999999999",
      ),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    // Account isolation holds inside the account-scoped RPC — a
    // foreign id simply matches zero rows.
    expect(h.rpcArgs).toMatchObject({
      p_assignee: "99999999-9999-4999-8999-999999999999",
    });
  });

  it("400s half, malformed, and inverted date ranges", async () => {
    const half = await GET(
      new Request(
        `https://app.test/api/flows/flow-1/table?dateFrom=${encodeURIComponent(FROM)}`,
      ),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(half.status).toBe(400);

    const bad = await GET(
      new Request("https://app.test/api/flows/flow-1/table?dateFrom=soon&dateTo=later"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(bad.status).toBe(400);

    const inverted = await GET(
      new Request(
        `https://app.test/api/flows/flow-1/table?dateFrom=${encodeURIComponent(TO)}&dateTo=${encodeURIComponent(FROM)}`,
      ),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(inverted.status).toBe(400);
  });
});

describe("GET table with column filters (five business columns, server-side)", () => {
  function tableWith(qs: string) {
    return GET(new Request(`https://app.test/api/flows/flow-1/table?${qs}`), {
      params: Promise.resolve({ id: "flow-1" }),
    });
  }

  it("forwards multi-selects, numeric, date, and datetime filters into one RPC call", async () => {
    const nfFrom = "2026-10-01T00:00:00.000Z";
    const nfTo = "2026-10-20T00:00:00.000Z";
    const res = await tableWith(
      `view=completed&callStatus=${encodeURIComponent("Connected")}&callStatus=${encodeURIComponent("Not Answering")}` +
        `&callsTriedOp=between&callsTriedMin=2&callsTriedMax=5` +
        `&followUpStatus=${encodeURIComponent("Follow-up Pending")}` +
        `&lastContactFrom=2026-10-01&lastContactTo=2026-10-15` +
        `&nextFollowUpFrom=${encodeURIComponent(nfFrom)}&nextFollowUpTo=${encodeURIComponent(nfTo)}` +
        `&search=rahul&page=1&pageSize=10`,
    );
    expect(res.status).toBe(200);
    // Server-side: the RPC paginates the FILTERED set — every
    // predicate rides one call, and totals stay correct.
    expect(h.rpcArgs).toMatchObject({
      p_flow_id: "flow-1",
      p_view: "completed",
      p_search: "rahul",
      p_call_status: ["Connected", "Not Answering"],
      p_calls_tried_op: "between",
      p_calls_tried_value: null,
      p_calls_tried_min: 2,
      p_calls_tried_max: 5,
      p_followup_status: ["Follow-up Pending"],
      p_last_contact_from: "2026-10-01",
      p_last_contact_to: "2026-10-15",
      p_next_followup_from: nfFrom,
      p_next_followup_to: nfTo,
    });
  });

  it("forwards eq/gt/lt numerics and trims/dedupes categorical values", async () => {
    const res = await tableWith(
      `callsTriedOp=gt&callsTriedValue=3&callStatus=${encodeURIComponent(" Busy ")}&callStatus=Busy&callStatus=`,
    );
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({
      p_calls_tried_op: "gt",
      p_calls_tried_value: 3,
      p_calls_tried_min: null,
      p_calls_tried_max: null,
      p_call_status: ["Busy"],
    });
  });

  it("unknown statuses forward for zero-match (never 400 the table)", async () => {
    const res = await tableWith(`callStatus=Nope&followUpStatus=Whatever`);
    expect(res.status).toBe(200);
    // Account isolation holds inside the RPC — unknown values
    // simply match zero rows.
    expect(h.rpcArgs).toMatchObject({
      p_call_status: ["Nope"],
      p_followup_status: ["Whatever"],
    });
  });

  it("unfiltered reads pass nulls for every column param (byte-identical shape)", async () => {
    const res = await tableWith(`view=all`);
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({
      p_call_status: null,
      p_calls_tried_op: null,
      p_calls_tried_value: null,
      p_calls_tried_min: null,
      p_calls_tried_max: null,
      p_followup_status: null,
      p_last_contact_from: null,
      p_last_contact_to: null,
      p_next_followup_from: null,
      p_next_followup_to: null,
    });
    // The meta.filters echo shape is unchanged.
    const json = (await res.json()) as {
      meta: { filters: { dateFrom: null; dateTo: null; assignee: string } };
    };
    expect(json.meta.filters).toEqual({ dateFrom: null, dateTo: null, assignee: "all" });
  });

  it("400s bad operators, non-integer counts, and inverted numerics", async () => {
    for (const qs of [
      `callsTriedOp=gte&callsTriedValue=3`,
      `callsTriedOp=eq`,
      `callsTriedOp=eq&callsTriedValue=abc`,
      `callsTriedOp=eq&callsTriedValue=3.5`,
      `callsTriedOp=eq&callsTriedValue=`,
      `callsTriedOp=eq&callsTriedValue=1000`,
      `callsTriedOp=between&callsTriedMin=2`,
      `callsTriedOp=between&callsTriedMin=6&callsTriedMax=5`,
      `callsTriedOp=lt&callsTriedValue=-1`,
    ]) {
      expect((await tableWith(qs)).status, qs).toBe(400);
    }
  });

  it("400s malformed/inverted dates and datetimes, 400s oversized values", async () => {
    for (const qs of [
      `lastContactFrom=2026-13-01`,
      `lastContactFrom=2026-02-30`,
      `lastContactFrom=10-15-2026`,
      `lastContactFrom=2026-10-16&lastContactTo=2026-10-15`,
      `nextFollowUpFrom=soon`,
      `nextFollowUpFrom=2026-10-20T00:00:00.000Z&nextFollowUpTo=2026-10-01T00:00:00.000Z`,
      `callStatus=${encodeURIComponent("x".repeat(81))}`,
    ]) {
      expect((await tableWith(qs)).status, qs).toBe(400);
    }
    const tooMany = Array.from({ length: 51 }, (_, i) => `callStatus=v${i}`).join("&");
    expect((await tableWith(tooMany)).status).toBe(400);
  });

  it("open-ended date bounds pass one side null", async () => {
    const res = await tableWith(`lastContactTo=2026-10-15&nextFollowUpFrom=2026-10-01T00:00:00.000Z`);
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({
      p_last_contact_from: null,
      p_last_contact_to: "2026-10-15",
      p_next_followup_from: "2026-10-01T00:00:00.000Z",
      p_next_followup_to: null,
    });
  });
});

describe("GET table with Workspace flow overrides", () => {
  it("attaches overrides separately while rows keep original answers", async () => {
    h.overrides = [
      {
        account_id: "acct-1",
        flow_id: "flow-1",
        flow_run_id: "run-1",
        field_key: "Name",
        value_text: "Edited Name",
      },
    ];
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      rows: Array<{ runId: string; answers: Record<string, unknown> }>;
      flowOverrides: Record<string, Record<string, string | null>>;
    };
    // Originals preserved in rows; overrides ride along additively.
    const run1 = json.rows.find((r) => r.runId === "run-1");
    expect(run1?.answers).toMatchObject({ Name: "Rahul" });
    expect(json.flowOverrides).toEqual({ "run-1": { Name: "Edited Name" } });
  });

  it("omits runs without overrides (refresh-safe, no phantom edits)", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      flowOverrides: Record<string, Record<string, string | null>>;
    };
    expect(json.flowOverrides).toEqual({});
  });
});

describe("GET table with media attachment enrichment", () => {
  it("attaches media per conversation so attachment cells can link", async () => {
    h.messages = [
      {
        conversation_id: "conv-1",
        content_text: "Lord Shiva 4K Wallpaper.jpg",
        media_url: "/api/whatsapp/media/m-1",
        content_type: "application/pdf",
      },
      {
        conversation_id: "conv-1",
        content_text: "Itinerary.pdf",
        media_url: "/api/whatsapp/media/m-2",
        content_type: "image/jpeg",
      },
      // No media_url (plain text) — must never appear.
      {
        conversation_id: "conv-1",
        content_text: "Thanks",
        media_url: null,
        content_type: "text",
      },
    ];
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mediaByConversation: Record<
        string,
        Array<{ contentText: string | null; mediaUrl: string | null }>
      >;
    };
    // run-1's conversation (conv-1) carries the media; run-2 has none.
    expect(json.mediaByConversation["conv-1"]).toEqual([
      {
        contentText: "Lord Shiva 4K Wallpaper.jpg",
        mediaUrl: "/api/whatsapp/media/m-1",
        contentType: "application/pdf",
      },
      {
        contentText: "Itinerary.pdf",
        mediaUrl: "/api/whatsapp/media/m-2",
        contentType: "image/jpeg",
      },
    ]);
    // Plain-text rows never leak into the media map.
    expect(json.mediaByConversation["conv-1"]).not.toContainEqual({
      contentText: "Thanks",
      mediaUrl: null,
      contentType: "text",
    });
    expect(json.mediaByConversation["conv-2"] ?? null).toBeNull();
  });

  it("returns an empty media map when no page row has a conversation", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mediaByConversation: Record<string, unknown>;
    };
    expect(json.mediaByConversation).toEqual({});
  });
});

describe("GET table with latest-recording enrichment", () => {
  it("attaches the latest recording per contact with the uploader name", async () => {
    h.recordings = [
      {
        id: "r-old",
        contact_id: "c-1",
        duration_seconds: 14,
        recorded_at: "2026-10-03T12:00:00.000Z",
        created_at: "2026-10-03T12:00:00.000Z",
        file_name: "old.ogg",
        uploaded_by: "u-9",
      },
      {
        id: "r-new",
        contact_id: "c-1",
        duration_seconds: 35,
        recorded_at: "2026-10-04T12:00:00.000Z",
        created_at: "2026-10-04T12:00:00.000Z",
        file_name: "new.ogg",
        uploaded_by: "u-9",
      },
    ];
    h.profiles = [{ user_id: "u-9", full_name: "Akash", email: "a@x.com" }];
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      latestRecordingByContact: Record<
        string,
        { id: string; duration_seconds: number; uploader_name: string }
      >;
    };
    // Latest wins; the uploader resolves from profiles.
    expect(json.latestRecordingByContact["c-1"]).toMatchObject({
      id: "r-new",
      duration_seconds: 35,
      uploader_name: "Akash",
    });
    // c-2 has no recording — no entry, never null-phantom.
    expect(json.latestRecordingByContact["c-2"] ?? null).toBeNull();
  });

  it("returns an empty map when nobody on the page has a recording", async () => {
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      latestRecordingByContact: Record<string, unknown>;
    };
    expect(json.latestRecordingByContact).toEqual({});
  });

  it("falls back to Unknown when the uploader profile is gone", async () => {
    h.recordings = [
      {
        id: "r-1",
        contact_id: "c-1",
        duration_seconds: 20,
        recorded_at: null,
        created_at: "2026-10-04T12:00:00.000Z",
        file_name: "x.ogg",
        uploaded_by: "u-gone",
      },
    ];
    h.profiles = [];
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/table"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      latestRecordingByContact: Record<string, { uploader_name: string }>;
    };
    expect(json.latestRecordingByContact["c-1"].uploader_name).toBe(
      "Unknown"
    );
  });
});

describe("GET table � Meta Instant Form identity mapping", () => {
  const metaRows = () => [
    {
      run_id: "run-test-lead",
      contact_id: null,
      contact_name: null,
      contact_phone: null,
      conversation_id: null,
      status: "completed",
      started_at: "2026-10-19T20:10:33.000Z",
      last_advanced_at: null,
      ended_at: "2026-10-19T20:10:33.000Z",
      reached_at: null,
      is_completed: true,
      vars: {
        full_name: "<test lead: dummy data for full_name>",
        phone_number: "<test lead: dummy data for phone_number>",
        email: "test@meta.com",
        meta_lead_source: "Other",
      },
    },
    {
      run_id: "run-real-lead",
      contact_id: "c-9",
      contact_name: "Rahul Sharma",
      contact_phone: "+919999999999",
      conversation_id: null,
      status: "completed",
      started_at: "2026-10-19T21:00:00.000Z",
      last_advanced_at: null,
      ended_at: "2026-10-19T21:00:00.000Z",
      reached_at: null,
      is_completed: true,
      vars: {
        full_name: "Rahul Kumar",
        phone_number: "+919888888888",
        email: "rahul@example.com",
        meta_lead_source: "Facebook",
      },
    },
  ];

  it("shows Meta's name/phone when no contact exists; the submission Full Name wins over the contact name", async () => {
    const previousFlow = h.flow;
    const previousRpc = h.rpc;
    const previousNodes = h.nodes;
    try {
      h.nodes = [
        {
          node_key: "meta_source_node",
          node_type: "collect_input",
          config: {
            var_key: "meta_lead_source",
            prompt_text: "Source",
            next_node_key: "q_full_name",
          },
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          node_key: "q_full_name",
          node_type: "collect_input",
          config: {
            var_key: "full_name",
            prompt_text: "Full name",
            next_node_key: "q_phone",
          },
          created_at: "2026-01-01T00:00:01.000Z",
        },
        {
          node_key: "q_phone",
          node_type: "collect_input",
          config: {
            var_key: "phone_number",
            prompt_text: "Phone number",
            next_node_key: "q_email",
          },
          created_at: "2026-01-01T00:00:02.000Z",
        },
        {
          node_key: "q_email",
          node_type: "collect_input",
          config: { var_key: "email", prompt_text: "Email" },
          created_at: "2026-01-01T00:00:03.000Z",
        },
      ];
      h.flow = {
        id: "flow-meta",
        account_id: "acct-1",
        name: "Meta Lead Ads � Travel Agency Customers",
        kind: "meta_lead_ads",
        completion_node_id: null,
        entry_node_id: "meta_source_node",
      };
      h.rpc = { total: 2, rows: metaRows() };
      const res = await GET(
        new Request("https://app.test/api/flows/flow-meta/table"),
        { params: Promise.resolve({ id: "flow-meta" }) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{
          runId: string;
          name: string | null;
          phone: string | null;
          answers: Record<string, string | null>;
        }>;
      };
      const testLead = json.rows.find((r) => r.runId === "run-test-lead");
      expect(testLead?.name).toBe("<test lead: dummy data for full_name>");
      expect(testLead?.phone).toBe("<test lead: dummy data for phone_number>");
      expect(testLead?.answers.email).toBe("test@meta.com");
      expect(testLead?.answers.meta_lead_source).toBe("Other");

      const realLead = json.rows.find((r) => r.runId === "run-real-lead");
      // The submission's own Full Name answer wins over the shared
      // contact's WhatsApp profile name; the contact phone still wins
      // for the Phone column (unchanged fallback).
      expect(realLead?.name).toBe("Rahul Kumar");
      expect(realLead?.phone).toBe("+919999999999");
      expect(realLead?.answers.meta_lead_source).toBe("Facebook");
      expect(realLead?.answers.full_name).toBe("Rahul Kumar");
    } finally {
      h.flow = previousFlow;
      h.rpc = previousRpc;
      h.nodes = previousNodes;
    }
  });

  it("never applies the Meta fallback to non-Meta flows", async () => {
    const previousRpc = h.rpc;
    try {
      h.rpc = { total: 1, rows: [metaRows()[0]] };
      const res = await GET(
        new Request("https://app.test/api/flows/flow-1/table"),
        { params: Promise.resolve({ id: "flow-1" }) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{ name: string | null; phone: string | null }>;
      };
      expect(json.rows[0].name).toBeNull();
      expect(json.rows[0].phone).toBeNull();
    } finally {
      h.rpc = previousRpc;
    }
  });
});

describe("GET table – Meta Full Name display-name projection", () => {
  const fullNameNodes = [
    {
      node_key: "meta_source_node",
      node_type: "collect_input",
      config: {
        var_key: "meta_lead_source",
        prompt_text: "Source",
        next_node_key: "meta_q_0_full_name",
      },
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      node_key: "meta_q_0_full_name",
      node_type: "collect_input",
      config: {
        var_key: "full_name",
        prompt_text: "Full name",
        next_node_key: "meta_q_1_phone_number",
      },
      created_at: "2026-01-01T00:00:01.000Z",
    },
    {
      node_key: "meta_q_1_phone_number",
      node_type: "collect_input",
      config: {
        var_key: "phone_number",
        prompt_text: "Phone number",
        next_node_key: "meta_q_2_city",
      },
      created_at: "2026-01-01T00:00:02.000Z",
    },
    {
      node_key: "meta_q_2_city",
      node_type: "collect_input",
      config: { var_key: "city", prompt_text: "Which city?" },
      created_at: "2026-01-01T00:00:03.000Z",
    },
  ];
  const fullNameForm = {
    id: "form-1",
    questions: [
      { key: "full_name", label: "Full name", type: "FULL_NAME" },
      { key: "phone_number", label: "Phone number", type: "PHONE_NUMBER" },
      { key: "city", label: "Which city?", type: "CUSTOM" },
    ],
  };

  async function getMetaTable(
    rows: Array<Record<string, unknown>>,
    metaForm: Record<string, unknown> | null = fullNameForm as unknown as Record<string, unknown>,
  ) {
    const previousFlow = h.flow;
    const previousRpc = h.rpc;
    const previousNodes = h.nodes;
    const previousMetaForm = h.metaForm;
    try {
      h.nodes = fullNameNodes;
      h.flow = {
        id: "flow-meta",
        account_id: "acct-1",
        name: "Meta Lead Ads · Full Name Projection",
        kind: "meta_lead_ads",
        completion_node_id: null,
        entry_node_id: "meta_source_node",
        meta_form_id: "form-1",
      };
      h.metaForm = metaForm;
      h.rpc = { total: rows.length, rows };
      const res = await GET(
        new Request("https://app.test/api/flows/flow-meta/table"),
        { params: Promise.resolve({ id: "flow-meta" }) },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        columns: Array<{ key: string; label: string; system: boolean }>;
        rows: Array<{
          runId: string;
          name: string | null;
          phone: string | null;
          answers: Record<string, string | null>;
          rawAnswers?: Record<string, string | null>;
        }>;
      };
    } finally {
      h.flow = previousFlow;
      h.rpc = previousRpc;
      h.nodes = previousNodes;
      h.metaForm = previousMetaForm;
    }
  }

  const mahiRow = () => ({
    run_id: "run-mahi",
    contact_id: "c-mahi",
    contact_name: "Mahi ❤️💕",
    contact_phone: "916239419297",
    conversation_id: null,
    status: "completed",
    started_at: "2026-10-19T20:10:33.000Z",
    last_advanced_at: null,
    ended_at: "2026-10-19T20:10:33.000Z",
    reached_at: null,
    is_completed: true,
    vars: {
      full_name: "Mahima Dixit Mukesh",
      phone_number: "916239419297",
      city: "Mumbai",
      meta_lead_source: "Facebook",
    },
  });

  it("shows the submission Full Name under system Name and no separate Full name column", async () => {
    const json = await getMetaTable([mahiRow()]);
    const row = json.rows[0];
    expect(row.name).toBe("Mahima Dixit Mukesh");
    expect(row.phone).toBe("916239419297");
    // The stored answer is preserved in both projections.
    expect(row.answers.full_name).toBe("Mahima Dixit Mukesh");
    expect(row.rawAnswers?.full_name).toBe("Mahima Dixit Mukesh");
    // Exactly one visible Name column: the system one.
    const nameColumns = json.columns.filter((c) => c.label === "Name");
    expect(nameColumns).toHaveLength(1);
    expect(nameColumns[0]).toMatchObject({ key: "name", system: true });
    // The Full name twin is excluded by stable key identity.
    expect(
      json.columns.filter((c) => !c.system && c.key === "full_name"),
    ).toHaveLength(0);
    // Every other column keeps its position and identity.
    expect(json.columns.map((c) => c.key)).toEqual([
      "submission_time",
      "name",
      "phone",
      "phone_number",
      "city",
      "meta_lead_source",
      "latest_recording",
      "status",
    ]);
  });

  it("resolves the Full Name per submission for rows sharing one contact", async () => {
    const second = {
      ...mahiRow(),
      run_id: "run-mahi-2",
      vars: {
        full_name: "Yogesh Bigboss",
        phone_number: "916239419297",
        city: "Delhi",
        meta_lead_source: "Facebook",
      },
    };
    const json = await getMetaTable([mahiRow(), second]);
    expect(
      json.rows.find((r) => r.runId === "run-mahi")?.name,
    ).toBe("Mahima Dixit Mukesh");
    expect(
      json.rows.find((r) => r.runId === "run-mahi-2")?.name,
    ).toBe("Yogesh Bigboss");
  });

  it("falls back to the contact name when the submission has no Full Name", async () => {
    const missing = {
      ...mahiRow(),
      run_id: "run-missing",
      vars: {
        phone_number: "916239419297",
        city: "Mumbai",
        meta_lead_source: "Facebook",
      },
    };
    const empty = {
      ...mahiRow(),
      run_id: "run-empty",
      vars: {
        full_name: "   ",
        phone_number: "916239419297",
        city: "Mumbai",
        meta_lead_source: "Facebook",
      },
    };
    const json = await getMetaTable([missing, empty]);
    expect(
      json.rows.find((r) => r.runId === "run-missing")?.name,
    ).toBe("Mahi ❤️💕");
    expect(
      json.rows.find((r) => r.runId === "run-empty")?.name,
    ).toBe("Mahi ❤️💕");
  });

  it("suppresses the twin even when question metadata was never synced", async () => {
    const json = await getMetaTable([mahiRow()], null);
    expect(json.rows[0].name).toBe("Mahima Dixit Mukesh");
    expect(
      json.columns.filter((c) => !c.system && c.key === "full_name"),
    ).toHaveLength(0);
    expect(json.columns.some((c) => c.system && c.key === "name")).toBe(true);
  });

  it("leaves Flow Tables untouched: custom Full name column stays, system Name stays contact-based", async () => {
    const previousFlow = h.flow;
    const previousRpc = h.rpc;
    const previousNodes = h.nodes;
    try {
      h.nodes = [
        {
          node_key: "start",
          node_type: "start",
          config: { next_node_key: "q_name" },
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          node_key: "q_name",
          node_type: "collect_input",
          config: {
            var_key: "full_name",
            prompt_text: "Full name",
            next_node_key: "q_city",
          },
          created_at: "2026-01-01T00:00:01.000Z",
        },
        {
          node_key: "q_city",
          node_type: "collect_input",
          config: { var_key: "city", prompt_text: "Which city?" },
          created_at: "2026-01-01T00:00:02.000Z",
        },
      ];
      // No `kind`: a regular Flow Table, not a Meta table.
      h.flow = {
        id: "flow-1",
        account_id: "acct-1",
        name: "Regular Flow",
        completion_node_id: null,
        entry_node_id: "start",
      };
      h.rpc = {
        total: 1,
        rows: [
          {
            run_id: "run-flow",
            contact_id: "c-1",
            contact_name: "Mahi ❤️💕",
            contact_phone: "916239419297",
            conversation_id: null,
            status: "completed",
            started_at: "2026-09-18T10:00:00.000Z",
            last_advanced_at: null,
            ended_at: null,
            reached_at: null,
            is_completed: true,
            vars: { full_name: "Mahima Dixit Mukesh", city: "Mumbai" },
          },
        ],
      };
      const res = await GET(
        new Request("https://app.test/api/flows/flow-1/table"),
        { params: Promise.resolve({ id: "flow-1" }) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        columns: Array<{ key: string; label: string; system: boolean }>;
        rows: Array<{
          name: string | null;
          answers: Record<string, string | null>;
        }>;
      };
      // Custom Full name column retained with its own answer …
      const twin = json.columns.find(
        (c) => !c.system && c.key === "full_name",
      );
      expect(twin?.label).toBe("Full name");
      expect(json.rows[0].answers.full_name).toBe("Mahima Dixit Mukesh");
      // … and the system Name column still shows the contact value.
      expect(json.rows[0].name).toBe("Mahi ❤️💕");
    } finally {
      h.flow = previousFlow;
      h.rpc = previousRpc;
      h.nodes = previousNodes;
    }
  });
});

describe("GET table – Meta option labels with raw-answer preservation", () => {
  const optionNodes = [
    {
      node_key: "meta_source_node",
      node_type: "collect_input",
      config: { var_key: "meta_lead_source", prompt_text: "Source" },
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      node_key: "meta_q_0_service",
      node_type: "collect_input",
      config: { var_key: "service", prompt_text: "Which service?" },
      created_at: "2026-01-01T00:00:01Z",
    },
  ];
  const metaFormWithOptions = {
    id: "form-1",
    questions: [
      {
        key: "service",
        label: "Which service?",
        type: "CUSTOM",
        options: [
          { key: "adobe_premiere_pro", value: "Adobe Premiere Pro" },
          { key: "after_effects", value: "After Effects" },
        ],
      },
    ],
  };
  const optionRows = () => [
    {
      run_id: "run-opt",
      contact_id: null,
      contact_name: null,
      contact_phone: null,
      conversation_id: null,
      status: "completed",
      started_at: "2026-10-19T20:10:33.000Z",
      last_advanced_at: null,
      ended_at: "2026-10-19T20:10:33.000Z",
      reached_at: null,
      is_completed: true,
      vars: {
        service: "adobe_premiere_pro",
        note: "Call me",
        meta_lead_source: "Facebook",
      },
    },
  ];

  async function getMetaRows() {
    const previousFlow = h.flow;
    const previousRpc = h.rpc;
    const previousNodes = h.nodes;
    const previousMetaForm = h.metaForm;
    try {
      h.nodes = optionNodes;
      h.flow = {
        id: "flow-meta",
        account_id: "acct-1",
        name: "Meta Lead Ads · Opt Form",
        kind: "meta_lead_ads",
        completion_node_id: null,
        entry_node_id: "meta_source_node",
        meta_form_id: "form-1",
      };
      h.metaForm = metaFormWithOptions as unknown as Record<string, unknown>;
      h.rpc = { total: 1, rows: optionRows() };
      const res = await GET(
        new Request("https://app.test/api/flows/flow-meta/table"),
        { params: Promise.resolve({ id: "flow-meta" }) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{
          runId: string;
          answers: Record<string, string | null>;
          rawAnswers?: Record<string, string | null>;
        }>;
      };
      return json.rows;
    } finally {
      h.flow = previousFlow;
      h.rpc = previousRpc;
      h.nodes = previousNodes;
      h.metaForm = previousMetaForm;
    }
  }

  it("renders human-readable labels while keeping the raw answers intact", async () => {
    const rows = await getMetaRows();
    const row = rows.find((r) => r.runId === "run-opt");
    // Display layer shows the human-readable label …
    expect(row?.answers.service).toBe("Adobe Premiere Pro");
    // … while the raw ingested value is preserved separately.
    expect(row?.rawAnswers?.service).toBe("adobe_premiere_pro");
    // Columns without options pass through verbatim in both shapes.
    expect(row?.answers.meta_lead_source).toBe("Facebook");
    expect(row?.rawAnswers?.meta_lead_source).toBe("Facebook");
  });

  it("falls back to the raw value when no option matches", async () => {
    const rows = await getMetaRows();
    // 'note' is not a form column at all: absent from answers entirely.
    expect(rows[0].answers.note).toBeUndefined();
    expect(rows[0].rawAnswers?.note).toBeUndefined();
  });

  it("prettifies unmatched underscore values for display, keeps raw intact", async () => {
    const previousFlow = h.flow;
    const previousRpc = h.rpc;
    const previousNodes = h.nodes;
    const previousMetaForm = h.metaForm;
    try {
      h.nodes = optionNodes;
      h.flow = {
        id: "flow-meta",
        account_id: "acct-1",
        name: "Meta Lead Ads · Opt Form",
        kind: "meta_lead_ads",
        completion_node_id: null,
        entry_node_id: "meta_source_node",
        meta_form_id: "form-1",
      };
      h.metaForm = metaFormWithOptions as unknown as Record<string, unknown>;
      h.rpc = {
        total: 1,
        rows: [
          {
            run_id: "run-pretty",
            contact_id: null,
            contact_name: null,
            contact_phone: null,
            conversation_id: null,
            status: "completed",
            started_at: "2026-10-19T20:10:33.000Z",
            last_advanced_at: null,
            ended_at: "2026-10-19T20:10:33.000Z",
            reached_at: null,
            is_completed: true,
            vars: {
              service: "davinci_resolve",
              meta_lead_source: "Facebook",
            },
          },
        ],
      };
      const res = await GET(
        new Request("https://app.test/api/flows/flow-meta/table"),
        { params: Promise.resolve({ id: "flow-meta" }) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{
          answers: Record<string, string | null>;
          rawAnswers?: Record<string, string | null>;
        }>;
      };
      // Display shows spaces; the stored raw keeps underscores.
      expect(json.rows[0].answers.service).toBe("davinci resolve");
      expect(json.rows[0].rawAnswers?.service).toBe("davinci_resolve");
    } finally {
      h.flow = previousFlow;
      h.rpc = previousRpc;
      h.nodes = previousNodes;
      h.metaForm = previousMetaForm;
    }
  });

  it("leaves underscore values verbatim on non-Meta tables", async () => {
    const previousRpc = h.rpc;
    try {
      h.rpc = {
        total: 1,
        rows: [
          {
            run_id: "run-plain",
            contact_id: "c-1",
            contact_name: "Rahul",
            contact_phone: "+91111",
            conversation_id: null,
            status: "completed",
            started_at: "2026-09-18T10:00:00.000Z",
            last_advanced_at: null,
            ended_at: "2026-09-18T10:05:00.000Z",
            reached_at: null,
            is_completed: true,
            vars: { Name: "Rahul", TravelDate: "2–3_years" },
          },
        ],
      };
      const res = await GET(new Request("https://app.test/api/flows/flow-1/table"), {
        params: Promise.resolve({ id: "flow-1" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{ answers: Record<string, string | null> }>;
      };
      // Flow Tables never pass through option labels: byte-identical.
      expect(json.rows[0].answers.TravelDate).toBe("2–3_years");
    } finally {
      h.rpc = previousRpc;
    }
  });

  it("does not attach raw answers on non-Meta tables", async () => {
    const res = await GET(new Request("https://app.test/api/flows/flow-1/table"), {
      params: Promise.resolve({ id: "flow-1" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rows: Array<Record<string, unknown>> };
    for (const row of json.rows) {
      expect("rawAnswers" in row).toBe(false);
    }
  });

  it("REGRESSION: choice questions with NO option metadata still prettify", async () => {
    // Production gap: forms enabled before options were persisted
    // store questions WITHOUT options. The table must still render
    // `davinci resolve` (persisted type CUSTOM marks the choice)
    // while rawAnswers keeps `davinci_resolve` byte-identical.
    const previousFlow = h.flow;
    const previousRpc = h.rpc;
    const previousNodes = h.nodes;
    const previousMetaForm = h.metaForm;
    try {
      h.nodes = [
        {
          node_key: "meta_source_node",
          node_type: "collect_input",
          config: {
            var_key: "meta_lead_source",
            prompt_text: "Source",
            next_node_key: "meta_q_0_software",
          },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          node_key: "meta_q_0_software",
          node_type: "collect_input",
          config: {
            var_key: "software",
            prompt_text: "Which software?",
            next_node_key: "meta_q_1_experience",
          },
          created_at: "2026-01-01T00:00:01Z",
        },
        {
          node_key: "meta_q_1_experience",
          node_type: "collect_input",
          config: {
            var_key: "experience",
            prompt_text: "Experience?",
            next_node_key: "meta_q_2_editor",
          },
          created_at: "2026-01-01T00:00:02Z",
        },
        {
          node_key: "meta_q_2_editor",
          node_type: "collect_input",
          config: {
            var_key: "editor",
            prompt_text: "Editor?",
            next_node_key: "meta_q_3_tool",
          },
          created_at: "2026-01-01T00:00:03Z",
        },
        {
          node_key: "meta_q_3_tool",
          node_type: "collect_input",
          config: {
            var_key: "tool",
            prompt_text: "Tool?",
            next_node_key: "meta_q_4_full_name",
          },
          created_at: "2026-01-01T00:00:04Z",
        },
        {
          node_key: "meta_q_4_full_name",
          node_type: "collect_input",
          config: { var_key: "full_name", prompt_text: "Full name" },
          created_at: "2026-01-01T00:00:05Z",
        },
      ];
      h.flow = {
        id: "flow-meta",
        account_id: "acct-1",
        name: "Meta Lead Ads · No Options Form",
        kind: "meta_lead_ads",
        completion_node_id: null,
        entry_node_id: "meta_source_node",
        meta_form_id: "form-1",
      };
      // Stored exactly like an older enabled form: types present,
      // options entirely absent — except `tool`, which proves an
      // exact label still wins when one exists.
      h.metaForm = {
        id: "form-1",
        questions: [
          { key: "software", label: "Which software?", type: "CUSTOM" },
          { key: "experience", label: "Experience?", type: "CUSTOM" },
          { key: "editor", label: "Editor?", type: "CUSTOM" },
          {
            key: "tool",
            label: "Tool?",
            type: "CUSTOM",
            options: [{ key: "after_effects", value: "After Effects" }],
          },
          { key: "full_name", label: "Full name", type: "FULL_NAME" },
        ],
      } as unknown as Record<string, unknown>;
      h.rpc = {
        total: 1,
        rows: [
          {
            run_id: "run-nometa",
            contact_id: null,
            contact_name: null,
            contact_phone: null,
            conversation_id: null,
            status: "completed",
            started_at: "2026-10-21T04:29:00.000Z",
            last_advanced_at: null,
            ended_at: "2026-10-21T04:29:00.000Z",
            reached_at: null,
            is_completed: true,
            vars: {
              software: "davinci_resolve",
              experience: "2–3_years",
              editor: "adobe_premiere_pro",
              tool: "after_effects",
              full_name: "rahul_kumar",
              meta_lead_source: "Facebook",
            },
          },
        ],
      };
      const res = await GET(
        new Request("https://app.test/api/flows/flow-meta/table"),
        { params: Promise.resolve({ id: "flow-meta" }) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        rows: Array<{
          answers: Record<string, string | null>;
          rawAnswers?: Record<string, string | null>;
        }>;
      };
      const row = json.rows[0];
      // Display: spaces for the option-less choice questions …
      expect(row.answers.software).toBe("davinci resolve");
      expect(row.answers.experience).toBe("2–3 years");
      expect(row.answers.editor).toBe("adobe premiere pro");
      // … the exact label when one exists …
      expect(row.answers.tool).toBe("After Effects");
      // … verbatim for the standard-typed name …
      expect(row.answers.full_name).toBe("rahul_kumar");
      // … and raw values untouched everywhere.
      expect(row.rawAnswers?.software).toBe("davinci_resolve");
      expect(row.rawAnswers?.experience).toBe("2–3_years");
      expect(row.rawAnswers?.editor).toBe("adobe_premiere_pro");
      expect(row.rawAnswers?.tool).toBe("after_effects");
      expect(row.rawAnswers?.full_name).toBe("rahul_kumar");
    } finally {
      h.flow = previousFlow;
      h.rpc = previousRpc;
      h.nodes = previousNodes;
      h.metaForm = previousMetaForm;
    }
  });
});

describe("GET table – Meta Source column position", () => {
  const sourceNodes = [
    {
      node_key: "meta_source_node",
      node_type: "collect_input",
      config: {
        var_key: "meta_lead_source",
        prompt_text: "Source",
        next_node_key: "meta_q_0_city",
      },
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      node_key: "meta_q_0_city",
      node_type: "collect_input",
      config: {
        var_key: "city",
        prompt_text: "Which city?",
        next_node_key: "meta_q_1_budget",
      },
      created_at: "2026-01-01T00:00:01.000Z",
    },
    {
      node_key: "meta_q_1_budget",
      node_type: "collect_input",
      config: {
        var_key: "budget",
        prompt_text: "What is your budget?",
        next_node_key: "meta_q_2_service",
      },
      created_at: "2026-01-01T00:00:02.000Z",
    },
    {
      node_key: "meta_q_2_service",
      node_type: "collect_input",
      config: { var_key: "service", prompt_text: "Which service?" },
      created_at: "2026-01-01T00:00:03.000Z",
    },
  ];
  const sourceRows = () => [
    {
      run_id: "run-fb",
      contact_id: null,
      contact_name: null,
      contact_phone: null,
      conversation_id: null,
      status: "completed",
      started_at: "2026-10-19T20:10:33.000Z",
      last_advanced_at: null,
      ended_at: "2026-10-19T20:10:33.000Z",
      reached_at: null,
      is_completed: true,
      vars: {
        city: "Mumbai",
        budget: "High",
        service: "Editing",
        meta_lead_source: "Facebook",
      },
    },
    {
      run_id: "run-ig",
      contact_id: null,
      contact_name: null,
      contact_phone: null,
      conversation_id: null,
      status: "completed",
      started_at: "2026-10-19T21:00:00.000Z",
      last_advanced_at: null,
      ended_at: "2026-10-19T21:00:00.000Z",
      reached_at: null,
      is_completed: true,
      vars: {
        city: "Delhi",
        budget: "Low",
        service: "Shooting",
        meta_lead_source: "Instagram",
      },
    },
  ];

  async function getMetaColumns() {
    const previousFlow = h.flow;
    const previousRpc = h.rpc;
    const previousNodes = h.nodes;
    try {
      h.nodes = sourceNodes;
      h.flow = {
        id: "flow-meta",
        account_id: "acct-1",
        name: "Meta Lead Ads · Source Order",
        kind: "meta_lead_ads",
        completion_node_id: null,
        entry_node_id: "meta_source_node",
      };
      h.rpc = { total: 2, rows: sourceRows() };
      const res = await GET(
        new Request("https://app.test/api/flows/flow-meta/table"),
        { params: Promise.resolve({ id: "flow-meta" }) },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        columns: Array<{ key: string; label: string; system: boolean }>;
        rows: Array<{ runId: string; answers: Record<string, string | null> }>;
      };
    } finally {
      h.flow = previousFlow;
      h.rpc = previousRpc;
      h.nodes = previousNodes;
    }
  }

  it("renders Source exactly once, after every dynamic question column", async () => {
    const json = await getMetaColumns();
    const keys = json.columns.map((c) => c.key);
    // Exactly once.
    expect(keys.filter((k) => k === "meta_lead_source")).toHaveLength(1);
    expect(
      json.columns.find((c) => c.key === "meta_lead_source")?.label,
    ).toBe("Source");
    // After all three question columns, just before Latest Recording.
    expect(keys.indexOf("city")).toBeLessThan(keys.indexOf("budget"));
    expect(keys.indexOf("budget")).toBeLessThan(keys.indexOf("service"));
    expect(keys.indexOf("service")).toBeLessThan(
      keys.indexOf("meta_lead_source"),
    );
    expect(keys.indexOf("meta_lead_source")).toBe(
      keys.indexOf("latest_recording") - 1,
    );
    // System/operational columns keep their positions.
    expect(keys.slice(0, 3)).toEqual([
      "submission_time",
      "name",
      "phone",
    ]);
    expect(keys[keys.length - 1]).toBe("status");
  });

  it("keeps Source values correct for Facebook and Instagram leads", async () => {
    const json = await getMetaColumns();
    const fb = json.rows.find((r) => r.runId === "run-fb");
    const ig = json.rows.find((r) => r.runId === "run-ig");
    expect(fb?.answers.meta_lead_source).toBe("Facebook");
    expect(ig?.answers.meta_lead_source).toBe("Instagram");
    // Question answers keep their own mappings — nothing shifted.
    expect(fb?.answers.city).toBe("Mumbai");
    expect(fb?.answers.budget).toBe("High");
    expect(fb?.answers.service).toBe("Editing");
  });

  it("leaves non-Meta column order untouched (no Source column)", async () => {
    const res = await GET(new Request("https://app.test/api/flows/flow-1/table"), {
      params: Promise.resolve({ id: "flow-1" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      columns: Array<{ key: string; label: string; system: boolean }>;
    };
    const keys = json.columns.map((c) => c.key);
    expect(keys).not.toContain("meta_lead_source");
    // Builder order preserved: systems first, Latest Recording
    // second-to-last, Status last — the Meta reorder never runs here.
    expect(keys.slice(0, 3)).toEqual(["submission_time", "name", "phone"]);
    expect(keys[keys.length - 2]).toBe("latest_recording");
    expect(keys[keys.length - 1]).toBe("status");
  });
});

describe("GET table – agent scoping on Meta Lead Ads Tables", () => {
  const metaFlow = () => {
    h.flow = {
      id: "flow-meta",
      account_id: "acct-1",
      name: "Meta Lead Ads · Hiring",
      kind: "meta_lead_ads",
      completion_node_id: null,
      entry_node_id: "meta_source_node",
      meta_form_id: "form-1",
    };
    h.user = { id: "u-agent" };
  };
  const asAgent = () => {
    h.profiles = [{ user_id: "u-agent", account_role: "agent" }];
  };
  const asRole = (role: string) => {
    h.profiles = [{ user_id: "u-1", account_role: role }];
  };

  it("forces p_assignee to the agent's own id, ignoring the query param", async () => {
    const previousFlow = h.flow;
    const previousUser = h.user;
    try {
      metaFlow();
      asAgent();
      const res = await GET(
        new Request(
          "https://app.test/api/flows/flow-meta/table?assignee=u-other",
        ),
        { params: Promise.resolve({ id: "flow-meta" }) },
      );
      expect(res.status).toBe(200);
      expect(h.rpcArgs).toMatchObject({ p_assignee: "u-agent" });
    } finally {
      h.flow = previousFlow;
      h.user = previousUser;
    }
  });

  it("defaults an agent with no assignee param to their own id", async () => {
    const previousFlow = h.flow;
    const previousUser = h.user;
    try {
      metaFlow();
      asAgent();
      const res = await GET(
        new Request("https://app.test/api/flows/flow-meta/table"),
        { params: Promise.resolve({ id: "flow-meta" }) },
      );
      expect(res.status).toBe(200);
      expect(h.rpcArgs).toMatchObject({ p_assignee: "u-agent" });
    } finally {
      h.flow = previousFlow;
      h.user = previousUser;
    }
  });

  it("leaves owners, admins, and viewers untouched on Meta tables", async () => {
    const previousFlow = h.flow;
    const previousUser = h.user;
    try {
      for (const role of ["owner", "admin", "viewer"]) {
        metaFlow();
        h.user = { id: "u-1" };
        asRole(role);
        const res = await GET(
          new Request(
            "https://app.test/api/flows/flow-meta/table?assignee=u-other",
          ),
          { params: Promise.resolve({ id: "flow-meta" }) },
        );
        expect(res.status).toBe(200);
        expect(h.rpcArgs).toMatchObject({ p_assignee: "u-other" });
      }
    } finally {
      h.flow = previousFlow;
      h.user = previousUser;
    }
  });

  it("does not touch Flow Tables for agents", async () => {
    const previousUser = h.user;
    try {
      h.user = { id: "u-agent" };
      asAgent();
      const res = await GET(
        new Request(
          "https://app.test/api/flows/flow-1/table?assignee=u-other",
        ),
        { params: Promise.resolve({ id: "flow-1" }) },
      );
      expect(res.status).toBe(200);
      expect(h.rpcArgs).toMatchObject({ p_assignee: "u-other" });
    } finally {
      h.user = previousUser;
    }
  });
});
