import { beforeEach, describe, expect, it, vi } from "vitest";

// Workspace followup-reminder POST — Meta-lead phone guard.
// Direct API coverage: the guard runs before any write, rejects
// customer numbers with a machine-readable code, supports dry-run
// pre-validation, and leaves unchanged-recipient updates alone.
const h = vi.hoisted(() => ({
  role: "owner" as string,
  accountId: "acct-1",
  userId: "user-1",
  storedCell: "2999-01-01T10:00:00.000Z" as string | null,
  profileNumber: "+91 98765 43210" as string | null,
  existingLink: null as Record<string, unknown> | null,
  metaLeadPhone: false,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  writes: [] as Array<{ kind: string; table: string; obj?: unknown }>,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: h.userId,
    role: h.role,
  }),
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

type Chain = {
  table: string;
  filters: Array<[string, unknown]>;
};

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  const chain = (table: string): Record<string, unknown> => {
    const state: Chain & { write?: unknown } = { table, filters: [] };
    const self: Record<string, unknown> = {
      select: () => self,
      order: () => self,
      limit: () => self,
      eq: (col: string, val: unknown) => {
        state.filters.push([col, val]);
        return self;
      },
      in: (col: string, vals: unknown) => {
        state.filters.push([col, vals]);
        return self;
      },
      maybeSingle: async () => ({ data: readTable(state), error: null }),
      single: async () => {
        const row = {
          id: "rem-1",
          account_id: h.accountId,
          status: "scheduled",
          ...(typeof state.write === "object" && state.write !== null
            ? (state.write as Record<string, unknown>)
            : {}),
        };
        return { data: row, error: null };
      },
      update: (obj: unknown) => {
        h.writes.push({ kind: "update", table: state.table, obj });
        return self;
      },
      insert: (obj: unknown) => {
        h.writes.push({ kind: "insert", table: state.table, obj });
        return self;
      },
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: readTableList(state), error: null }),
    };
    return self;
  };
  return {
    from: (table: string) => chain(table),
    rpc: async (fn: string, args: unknown) => {
      h.rpcCalls.push({ fn, args });
      return { data: h.metaLeadPhone, error: null };
    },
  };
}

function readTable(state: { table: string }): unknown {
  switch (state.table) {
    case "flows":
      return { id: "flow-1", account_id: h.accountId, kind: "meta_lead_ads" };
    case "flow_runs":
      return { id: "run-1", account_id: h.accountId, flow_id: "flow-1" };
    case "workspace_fields":
      return null; // list-read path handles fields
    case "workspace_values":
      return h.storedCell === null ? null : { value_text: h.storedCell };
    case "profiles":
      return h.profileNumber === null ? null : { whatsapp_number: h.profileNumber };
    case "whatsapp_followups":
      return h.existingLink;
    default:
      return null;
  }
}

function readTableList(state: { table: string }): unknown {
  if (state.table === "workspace_fields") {
    return [
      { id: "field-1", name: "Next Follow-up Date & Time", field_type: "datetime" },
    ];
  }
  return [];
}

const { POST } = await import("./route");

const ISO_FUTURE = "2999-01-01T10:00:00.000Z";

function postCall(body: unknown) {
  return POST(
    post(body),
    { params: Promise.resolve({ id: "flow-1" }) } as unknown as {
      params: Promise<{ id: string }>;
    },
  );
}

function post(body: unknown) {
  return new Request("https://app.test/api/flows/flow-1/followup-reminder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseBody(over: Record<string, unknown> = {}) {
  return {
    flow_run_id: "run-1",
    scheduled_for: ISO_FUTURE,
    message: "Ping me",
    recipient_phone: "+91 99999 88888",
    lead_name: "Lead",
    lead_phone: "+91 74151 22330",
    ...over,
  };
}

beforeEach(() => {
  h.role = "owner";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.storedCell = ISO_FUTURE;
  h.profileNumber = "+91 98765 43210";
  h.existingLink = null;
  h.metaLeadPhone = false;
  h.rpcCalls = [];
  h.writes = [];
});

describe("POST /api/flows/[id]/followup-reminder Meta-lead guard", () => {
  it("rejects an explicitly-set Meta lead number before any write", async () => {
    h.metaLeadPhone = true;
    const res = await postCall(baseBody({ recipient_phone: "+91 74151 22330" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe("meta_lead_phone");
    expect(json.error).toContain("Meta Lead Ads Workspace");
    // Guard ran; nothing was written.
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.writes).toEqual([]);
  });

  it("allows a genuine team number (single check, then creates)", async () => {
    h.metaLeadPhone = false;
    const res = await postCall(baseBody());
    expect(res.status).toBe(201);
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.writes.some((w) => w.kind === "insert")).toBe(true);
  });

  it("validate_only performs zero writes on both outcomes", async () => {
    h.metaLeadPhone = true;
    const blocked = await postCall({ ...baseBody(), validate_only: true });
    expect(blocked.status).toBe(400);
    expect(h.writes).toEqual([]);

    h.writes = [];
    h.metaLeadPhone = false;
    const ok = await postCall({ ...baseBody(), validate_only: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ valid: true });
    expect(h.writes).toEqual([]);
  });

  it("leaves updates that keep the stored recipient alone (no guard call)", async () => {
    h.existingLink = {
      id: "rem-9",
      status: "scheduled",
      created_by: "user-1",
      recipient_phone: "919999988888",
      recipient_custom: false,
    };
    h.metaLeadPhone = false;
    // No explicit recipient → keep stored; guard must not run.
    const { recipient_phone: _dropped, ...withoutRecipient } = baseBody({ message: "Edited" });
    void _dropped;
    const res = await postCall(withoutRecipient);
    expect(h.rpcCalls).toHaveLength(0);
    expect(res.status).toBe(200);
    expect(h.writes.some((w) => w.kind === "update")).toBe(true);
  });

  it("blocks updates that change the recipient to a Meta lead number", async () => {
    h.existingLink = {
      id: "rem-9",
      status: "scheduled",
      created_by: "user-1",
      recipient_phone: "919999988888",
      recipient_custom: false,
    };
    h.metaLeadPhone = true;
    const res = await postCall(baseBody({ recipient_phone: "+91 74151 22330" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("meta_lead_phone");
    expect(h.writes).toEqual([]);
  });

  it("checks the profile fallback on creates without an explicit recipient", async () => {
    h.metaLeadPhone = true;
    const res = await postCall({ ...baseBody(), recipient_phone: undefined });
    // Falls back to the creator's Settings number → still guarded.
    expect(h.rpcCalls).toHaveLength(1);
    expect(res.status).toBe(400);
    expect(h.writes).toEqual([]);
  });
});
