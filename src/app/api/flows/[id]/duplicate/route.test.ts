import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Tests for POST /api/flows/[id]/duplicate.
//
// The route reads the source flow + nodes through the service-role client,
// writes a new draft flow + fresh node rows, and never touches the original
// after the read. These tests assert the copy is independent, inactive, and
// correctly tenant-scoped.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    user: { id: "user-1" } as { id: string } | null,
    // RLS ownership check result on the caller's client.
    owned: null as { id: string } | null,
    // Service-role reads.
    original: null as Record<string, unknown> | null,
    nodes: [] as Record<string, unknown>[],
    nameRows: [] as Record<string, unknown>[],
    // Service-role writes.
    flowInserts: [] as Record<string, unknown>[],
    nodeInserts: [] as Record<string, unknown>[],
    fieldInserts: [] as Record<string, unknown>[][],
    flowDeletes: [] as string[],
    nodeInsertError: null as { message: string } | null,
  },
}));

const ORIGINAL = {
  id: "flow-orig-1",
  account_id: "acct-1",
  user_id: "user-1",
  name: "Welcome Flow",
  description: "Greets customers",
  status: "active",
  trigger_type: "keyword",
  trigger_config: { keywords: ["hi"] },
  entry_node_id: "start",
  fallback_policy: { on_unknown_reply: "reprompt", max_reprompts: 2 },
  execution_count: 7,
  last_executed_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const ORIGINAL_NODES = [
  {
    id: "node-orig-1",
    flow_id: "flow-orig-1",
    node_key: "start",
    node_type: "start",
    config: { next_node_key: "menu" },
    position_x: 100,
    position_y: 50,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "node-orig-2",
    flow_id: "flow-orig-1",
    node_key: "menu",
    node_type: "send_buttons",
    config: {
      text: "Hi!",
      buttons: [{ reply_id: "a", title: "A", next_node_key: "end" }],
    },
    position_x: 200,
    position_y: 80,
    created_at: "2026-01-01T00:00:00Z",
  },
];

function makeBuilder(table: string, admin: boolean) {
  const { state } = h;

  let didInsert = false;
  let didDelete = false;
  let selectCols = "*";
  const eqFilters: Array<[string, unknown]> = [];

  const b: Record<string, unknown> = {};

  b.select = vi.fn((cols?: string) => {
    if (cols !== undefined) selectCols = cols;
    return b;
  });
  b.eq = vi.fn((col: string, val: unknown) => {
    eqFilters.push([col, val]);
    return b;
  });
  b.order = vi.fn(() => b);
  b.insert = vi.fn((payload: unknown) => {
    didInsert = true;
    if (table === "flows") state.flowInserts.push(payload as Record<string, unknown>);
    if (table === "flow_nodes") {
      for (const row of payload as Record<string, unknown>[]) {
        state.nodeInserts.push(row);
      }
    }
    if (table === "workspace_fields") {
      state.fieldInserts.push(payload as Record<string, unknown>[]);
    }
    return b;
  });
  b.delete = vi.fn(() => {
    didDelete = true;
    return b;
  });

  const single = () => {
    if (table === "flows") {
      if (didInsert) {
        // Echo back the row the route actually inserted (plus the new id),
        // so name-uniqueness assertions see the real computed name.
        const payload = state.flowInserts[state.flowInserts.length - 1] ?? {};
        return Promise.resolve({
          data: {
            ...payload,
            id: "flow-copy-1",
            created_at: "2026-01-02T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          },
          error: null,
        });
      }
      // Admin read path (select *). The caller-client path is a separate
      // mock and never reaches here.
      if (admin && selectCols === "*") {
        return Promise.resolve({ data: state.original, error: null });
      }
      // Caller-client ownership check.
      return Promise.resolve({ data: state.owned, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };

  const array = () => {
    if (table === "flow_nodes") {
      if (didInsert) {
        return Promise.resolve({ data: null, error: state.nodeInsertError });
      }
      return Promise.resolve({ data: state.nodes, error: null });
    }
    if (table === "flows") {
      if (didDelete) {
        const id = eqFilters.find(([c]) => c === "id")?.[1] as string;
        if (id) state.flowDeletes.push(id);
        return Promise.resolve({ data: null, error: null });
      }
      if (selectCols === "name") {
        return Promise.resolve({ data: state.nameRows, error: null });
      }
    }
    return Promise.resolve({ data: null, error: null });
  };

  b.single = vi.fn(single);
  b.maybeSingle = vi.fn(single);
  b.then = (resolve: (v: unknown) => unknown) => resolve(array());
  return b;
}

let callerMock: { auth: { getUser: ReturnType<typeof vi.fn> }; from: ReturnType<typeof vi.fn> };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => callerMock),
  createBufferedServerClient: vi.fn(async () => ({
    client: callerMock,
    commit: vi.fn(),
    discard: vi.fn(),
  })),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: vi.fn((table: string) => makeBuilder(table, true)),
  }),
}));

import { POST } from "./route";

function postDuplicate(id = "flow-orig-1") {
  return POST(
    new Request("http://localhost/api/flows/flow-orig-1/duplicate", {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("POST /api/flows/[id]/duplicate", () => {
  beforeEach(() => {
    const s = h.state;
    s.user = { id: "user-1" };
    s.owned = { id: "flow-orig-1" };
    s.original = ORIGINAL;
    s.nodes = [...ORIGINAL_NODES];
    s.nameRows = [];
    s.flowInserts = [];
    s.nodeInserts = [];
    s.fieldInserts = [];
    s.flowDeletes = [];
    s.nodeInsertError = null;

    callerMock = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: h.state.user },
          error: null,
        })),
      },
      from: vi.fn((table: string) => makeBuilder(table, false)),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("copies a flow into a new draft with a distinct id and a Copy name", async () => {
    const res = await postDuplicate();
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.flow.id).not.toBe(ORIGINAL.id);
    expect(json.flow.id).toBe("flow-copy-1");
    expect(json.flow.name).toBe("Welcome Flow - Copy");
    expect(json.flow.status).toBe("draft");

    const inserted = h.state.flowInserts[0];
    expect(inserted.status).toBe("draft");
    expect(inserted.account_id).toBe("acct-1");
    expect(inserted.user_id).toBe("user-1");
    expect(inserted.entry_node_id).toBe("start");
    expect(inserted.trigger_config).toEqual({ keywords: ["hi"] });
    expect(inserted.execution_count).toBe(0);
    expect(inserted.last_executed_at).toBeNull();
  });

  it("copies every node with preserved keys/config/positions under the new flow", async () => {
    await postDuplicate();

    expect(h.state.nodeInserts).toHaveLength(2);
    const first = h.state.nodeInserts[0];
    expect(first.flow_id).toBe("flow-copy-1");
    expect(first.node_key).toBe("start");
    expect(first.node_type).toBe("start");
    expect(first.config).toEqual({ next_node_key: "menu" });
    expect(first.position_x).toBe(100);
    expect(first.position_y).toBe(50);
    // Child rows must not reuse the original node ids.
    expect(first.id).toBeUndefined();
  });

  it("keeps edge references (next_node_key) intact within the copy", async () => {
    await postDuplicate();

    const menu = h.state.nodeInserts.find((n) => n.node_key === "menu");
    expect(menu).toBeTruthy();
    const buttons = (menu!.config as Record<string, unknown>).buttons as Array<{
      next_node_key: string;
    }>;
    expect(buttons[0].next_node_key).toBe("end");
  });

  it("bumps the copy name when the base copy already exists", async () => {
    h.state.nameRows = [{ name: "Welcome Flow - Copy" }];
    const res = await postDuplicate();
    const json = await res.json();
    expect(json.flow.name).toBe("Welcome Flow - Copy 2");
  });

  it("returns 401 when unauthenticated", async () => {
    h.state.user = null;
    const res = await postDuplicate();
    expect(res.status).toBe(401);
  });

  it("returns 404 for a flow outside the caller's account", async () => {
    h.state.owned = null;
    const res = await postDuplicate();
    expect(res.status).toBe(404);
    expect(h.state.flowInserts).toHaveLength(0);
  });

  it("rolls back the flow when node insertion fails", async () => {
    h.state.nodeInsertError = { message: "insert failed" };
    const res = await postDuplicate();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe("insert failed");
    expect(h.state.flowDeletes).toContain("flow-copy-1");
  });

  it("provisions the 14 default business columns on the copy", async () => {
    const res = await postDuplicate();
    expect(res.status).toBe(201);
    expect(h.state.fieldInserts).toHaveLength(1);
    const rows = h.state.fieldInserts[0];
    expect(rows).toHaveLength(14);
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
      "Lead Quality",
    ]);
    for (const row of rows) {
      expect(row.account_id).toBe("acct-1");
      expect(row.flow_id).toBe("flow-copy-1");
    }
  });
});
