import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Tests for default Workspace business columns on flow creation
// (POST /api/flows — plain and template-clone paths).
//
// The route provisions the 13 defaults best-effort via the
// service-role client after the flow insert; creation itself never
// fails because of provisioning.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  accountId: "acct-1" as string | null,
  flowInsertError: null as { message: string } | null,
  fieldRows: [] as Array<Record<string, unknown>>,
  fieldInserts: [] as Array<Record<string, unknown>[]>,
}));

function userBuilder(table: string) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.single = async () => {
    if (table === "profiles") {
      if (!h.accountId) return { data: null, error: { message: "none" } };
      return { data: { account_id: h.accountId }, error: null };
    }
    return { data: null, error: null };
  };
  return b;
}

function adminBuilder(table: string) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.single = async () => {
    if (table === "flows") {
      if (h.flowInsertError) return { data: null, error: h.flowInsertError };
      return {
        data: { id: "flow-new-1", account_id: h.accountId },
        error: null,
      };
    }
    return { data: null, error: null };
  };
  b.then = (resolve: (v: unknown) => unknown) => {
    if (table === "workspace_fields") {
      return resolve({ data: h.fieldRows, error: null });
    }
    return resolve({ data: null, error: null });
  };
  return {
    ...b,
    insert: (payload: unknown) => {
      if (table === "workspace_fields") {
        h.fieldInserts.push(payload as Record<string, unknown>[]);
        return Promise.resolve({ data: payload, error: null });
      }
      return b;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: vi.fn((table: string) => userBuilder(table)),
  })),
  createBufferedServerClient: vi.fn(async () => ({
    client: {
      auth: { getUser: async () => ({ data: { user: h.user } }) },
      from: vi.fn((table: string) => userBuilder(table)),
    },
    commit: vi.fn(),
    discard: vi.fn(),
  })),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: vi.fn((table: string) => adminBuilder(table)),
  }),
}));

const { POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/flows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.user = { id: "user-1" };
  h.accountId = "acct-1";
  h.flowInsertError = null;
  h.fieldRows = [];
  h.fieldInserts = [];
});

describe("POST /api/flows provisions Workspace defaults", () => {
  it("creates all 14 default columns on plain flow creation", async () => {
    const res = await POST(post({ name: "Pilgrim Flow" }));
    expect(res.status).toBe(201);
    expect(h.fieldInserts).toHaveLength(1);
    const rows = h.fieldInserts[0];
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
    expect(rows.map((r) => r.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    for (const row of rows) {
      expect(row.account_id).toBe("acct-1");
      expect(row.flow_id).toBe("flow-new-1");
    }
  });

  it("creates all 14 default columns on template-clone creation", async () => {
    const res = await POST(post({ template_slug: "lead_capture" }));
    expect(res.status).toBe(201);
    expect(h.fieldInserts).toHaveLength(1);
    expect(h.fieldInserts[0]).toHaveLength(14);
    for (const row of h.fieldInserts[0]) {
      expect(row.account_id).toBe("acct-1");
      expect(row.flow_id).toBe("flow-new-1");
    }
  });

  it("does not duplicate pre-existing equivalents", async () => {
    h.fieldRows = [{ name: "call status", position: 0 }];
    const res = await POST(post({ name: "Another Flow" }));
    expect(res.status).toBe(201);
    expect(h.fieldInserts).toHaveLength(1);
    expect(h.fieldInserts[0]).toHaveLength(13);
  });
});
