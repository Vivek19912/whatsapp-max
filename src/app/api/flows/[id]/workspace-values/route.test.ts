import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "agent" as string | null,
  accountId: "acct-1",
  userId: "user-1",
  flowKind: null as string | null,
  allFields: [] as Array<Record<string, unknown>>,
  field: {
    id: "field-1",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Status",
    field_type: "single_select",
    position: 0,
    options: ["New", "Contacted"],
    default_value: "New",
  } as Record<string, unknown> | null,
  run: { id: "run-1", account_id: "acct-1", flow_id: "flow-1" } as Record<
    string,
    string
  > | null,
  upserts: [] as Array<Record<string, unknown>>,
  deletes: 0,
  roster: [] as string[],
  profileEqFilters: [] as Array<[string, unknown]>,
  triggers: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
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
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId ?? "user-1", role: h.role };
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

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({}),
}));

vi.mock("@/lib/meta-capi/triggers", () => ({
  onWorkspaceValueChanged: async (
    _db: unknown,
    args: Record<string, unknown>,
  ) => {
    h.triggers.push(args);
  },
  recordWorkspaceStatusChanged: async (
    _db: unknown,
    args: Record<string, unknown> & {
      previousValue?: string | null;
      newValue?: string | null;
    },
  ) => {
    // Mirror the production guard: unchanged or cleared saves never fire.
    if (!args.newValue || args.newValue === (args.previousValue ?? null)) {
      return false;
    }
    const { newValue, ...rest } = args;
    h.triggers.push({ ...rest, value: newValue });
    return true;
  },
}));

function fakeSupabase() {
  const chain: Record<string, unknown> = {};
  const state = {
    table: "",
    row: null as Record<string, unknown> | null,
    filters: [] as Array<[string, unknown]>,
  };
  chain.from = (table: string) => {
    state.table = table;
    state.filters = [];
    return chain;
  };
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    // Assigned-To roster lookup is a single account-scoped profiles
    // read (same source as GET /api/account/members). Resolve it
    // directly so tests prove account isolation via the filter.
    if (state.table === "profiles") {
      h.profileEqFilters.push([col, val]);
      return Promise.resolve({
        data: h.roster.map((user_id) => ({ user_id })),
        error: null,
      });
    }
    state.filters.push([col, val]);
    return chain;
  };
  chain.maybeSingle = async () => {
    if (state.table === "workspace_fields") {
      return { data: h.field, error: null };
    }
    if (state.table === "flows") {
      return {
        data: h.flowKind ? { id: "flow-1", kind: h.flowKind } : null,
        error: null,
      };
    }
    return { data: h.run, error: null };
  };
  chain.then = (resolve: (v: unknown) => void) => {
    // Terminal await (ownership field lookup): apply tracked
    // equality filters so agent scoping resolves faithfully.
    if (state.table === "workspace_fields") {
      const list = h.allFields.filter((r) =>
        state.filters.every(([c, v]) => r[c] === v),
      );
      return resolve({ data: list, error: null });
    }
    return resolve({ data: [], error: null });
  };
  chain.single = async () => ({
    data: { value_text: (state.row?.value_text as string) ?? null },
    error: null,
  });
  chain.upsert = (row: Record<string, unknown>) => {
    state.row = row;
    h.upserts.push(row);
    return chain;
  };
  chain.delete = () => {
    h.deletes += 1;
    return chain;
  };
  return chain;
}

const { PUT } = await import("./route");

function put(body: unknown) {
  return new Request("https://app.test/x", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "flow-1" }) };

beforeEach(() => {
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.flowKind = null;
  h.allFields = [];
  h.upserts = [];
  h.deletes = 0;
  h.roster = [];
  h.profileEqFilters = [];
  h.triggers = [];
  h.field = {
    id: "field-1",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Status",
    field_type: "single_select",
    position: 0,
    options: ["New", "Contacted"],
    default_value: "New",
  };
  h.run = { id: "run-1", account_id: "acct-1", flow_id: "flow-1" };
});

describe("PUT workspace values", () => {
  it("agents can set a valid cell value", async () => {
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Contacted" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { value: string };
    expect(json.value).toBe("Contacted");
    expect(h.upserts[0]).toMatchObject({
      account_id: "acct-1",
      field_id: "field-1",
      flow_run_id: "run-1",
      value_text: "Contacted",
    });
  });

  it("viewers cannot write values", async () => {
    h.role = "viewer";
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Contacted" }),
      params,
    );
    expect(res.status).toBe(403);
    expect(h.upserts).toHaveLength(0);
  });

  it("rejects values outside the options", async () => {
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Lost" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(h.upserts).toHaveLength(0);
  });

  it("clearing a cell deletes its value row", async () => {
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(h.deletes).toBe(1);
    expect(h.upserts).toHaveLength(0);
  });

  it("fires the Conversions API trigger only when the value actually changes", async () => {
    // No stored value yet → a new value is a genuine change → trigger once.
    const first = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Contacted" }),
      params,
    );
    expect(first.status).toBe(200);
    expect(h.triggers).toEqual([
      {
        accountId: "acct-1",
        flowRunId: "run-1",
        contactId: undefined,
        fieldName: "Status",
        value: "Contacted",
        previousValue: null,
      },
    ]);

    // Re-saving the SAME value must not re-fire.
    h.triggers = [];
    h.run = {
      id: "run-1",
      account_id: "acct-1",
      flow_id: "flow-1",
      value_text: "Contacted",
    };
    await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Contacted" }),
      params,
    );
    expect(h.triggers).toHaveLength(0);

    // A different value does fire again.
    await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "New" }),
      params,
    );
    expect(h.triggers).toHaveLength(1);
  });

  it("404s cross-account fields and cross-flow runs", async () => {
    // A field from another account is invisible (RLS + query scope).
    const savedField = h.field;
    h.field = null;
    const missing = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "New" }),
      params,
    );
    expect(missing.status).toBe(404);
    h.field = savedField;

    h.run = { id: "run-1", account_id: "acct-1", flow_id: "flow-OTHER" };
    const wrongFlow = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "New" }),
      params,
    );
    expect(wrongFlow.status).toBe(404);
    h.run = { id: "run-1", account_id: "acct-1", flow_id: "flow-1" };
  });
});

describe("PUT workspace Assigned To (dynamic team members)", () => {
  const MEMBER_A = "11111111-1111-4111-8111-111111111111";
  const MEMBER_B = "22222222-2222-4222-8222-222222222222";
  const FOREIGN = "99999999-9999-4999-8999-999999999999";

  function assigneeField() {
    h.field = {
      id: "field-assigned",
      account_id: "acct-1",
      flow_id: "flow-1",
      name: "Assigned To",
      field_type: "single_select",
      position: 0,
      options: ["Unassigned"],
      default_value: null,
    };
  }

  it("6. stores the stable member user_id for a current member", async () => {
    assigneeField();
    h.roster = [MEMBER_A, MEMBER_B];
    const res = await PUT(
      put({ field_id: "field-assigned", flow_run_id: "run-1", value: MEMBER_A }),
      params,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { value: string };
    expect(json.value).toBe(MEMBER_A);
    expect(h.upserts[0]).toMatchObject({ value_text: MEMBER_A });
  });

  it("5. scopes the roster lookup to the current account only", async () => {
    assigneeField();
    h.roster = [MEMBER_A];
    await PUT(
      put({ field_id: "field-assigned", flow_run_id: "run-1", value: MEMBER_A }),
      params,
    );
    expect(h.profileEqFilters).toContainEqual(["account_id", "acct-1"]);
  });

  it("5. rejects another account's member id", async () => {
    assigneeField();
    h.roster = [MEMBER_A, MEMBER_B];
    const res = await PUT(
      put({ field_id: "field-assigned", flow_run_id: "run-1", value: FOREIGN }),
      params,
    );
    expect(res.status).toBe(400);
    expect(h.upserts).toHaveLength(0);
  });

  it("3/4. a newly added member validates; a removed one does not", async () => {
    assigneeField();
    h.roster = [MEMBER_A, MEMBER_B];
    const added = await PUT(
      put({ field_id: "field-assigned", flow_run_id: "run-1", value: MEMBER_B }),
      params,
    );
    expect(added.status).toBe(200);

    h.upserts = [];
    h.roster = [MEMBER_A];
    const removed = await PUT(
      put({ field_id: "field-assigned", flow_run_id: "run-1", value: MEMBER_B }),
      params,
    );
    expect(removed.status).toBe(400);
    expect(h.upserts).toHaveLength(0);
  });

  it("rejects legacy display names for new assignments (ids only)", async () => {
    assigneeField();
    h.roster = [MEMBER_A];
    const res = await PUT(
      put({ field_id: "field-assigned", flow_run_id: "run-1", value: "Asha Rao" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(h.upserts).toHaveLength(0);
  });

  it("8. Clear deletes the value row", async () => {
    assigneeField();
    h.roster = [MEMBER_A];
    for (const v of [null, "", "__clear__"]) {
      h.deletes = 0;
      h.upserts = [];
      const res = await PUT(
        put({ field_id: "field-assigned", flow_run_id: "run-1", value: v }),
        params,
      );
      expect(res.status).toBe(200);
      expect(h.deletes).toBe(1);
      expect(h.upserts).toHaveLength(0);
    }
  });

  it("9. Unassigned stores the structural option", async () => {
    assigneeField();
    h.roster = [MEMBER_A];
    const res = await PUT(
      put({ field_id: "field-assigned", flow_run_id: "run-1", value: "Unassigned" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { value: string };
    expect(json.value).toBe("Unassigned");
  });

  it("non-assignee single_select columns still use static options", async () => {
    // Regression guard: the dynamic path must not leak into other fields.
    h.roster = [MEMBER_A];
    const res = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: MEMBER_A }),
      params,
    );
    expect(res.status).toBe(400);
    expect(h.profileEqFilters).toHaveLength(0);
  });
});

describe("agent ownership on Meta Lead Ads Tables", () => {
  const AGENT = "u-agent";
  const OTHER = "u-teammate";

  const NOTE_FIELD = {
    id: "f-note",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Note",
    field_type: "text",
    position: 0,
    options: null,
    default_value: null,
  };
  const ASSIGN_FIELD = {
    id: "f-assign",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Assigned To",
    field_type: "single_select",
    position: 0,
    options: null,
    default_value: null,
  };

  function seedMetaOwned() {
    h.role = "agent";
    h.userId = AGENT;
    h.flowKind = "meta_lead_ads";
    // Ownership lookup scans every workspace column for the
    // Assigned To field; the edited cell resolves separately.
    h.allFields = [ASSIGN_FIELD];
    h.field = { ...NOTE_FIELD };
    h.run = { id: "run-1", account_id: "acct-1", flow_id: "flow-1" };
  }

  it("lets an agent edit a plain field on their own Meta lead", async () => {
    seedMetaOwned();
    // Stored Assigned To value for run-1 (read through the same
    // mock row the run check uses).
    h.run = {
      id: "run-1",
      account_id: "acct-1",
      flow_id: "flow-1",
      value_text: AGENT,
    };
    const res = await PUT(
      put({ field_id: "f-note", flow_run_id: "run-1", value: "Call back" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(h.upserts).toHaveLength(1);
  });

  it("404s an agent writing another agent's Meta lead", async () => {
    seedMetaOwned();
    h.run = {
      id: "run-1",
      account_id: "acct-1",
      flow_id: "flow-1",
      value_text: OTHER,
    };
    const res = await PUT(
      put({ field_id: "f-note", flow_run_id: "run-1", value: "x" }),
      params,
    );
    expect(res.status).toBe(404);
    expect(h.upserts).toHaveLength(0);
  });

  it("404s an agent on unassigned Meta leads", async () => {
    seedMetaOwned();
    const res = await PUT(
      put({ field_id: "f-note", flow_run_id: "run-1", value: "x" }),
      params,
    );
    expect(res.status).toBe(404);
    expect(h.upserts).toHaveLength(0);
  });

  it("403s an agent editing Assigned To, even on their own lead", async () => {
    seedMetaOwned();
    h.field = { ...ASSIGN_FIELD };
    h.run = {
      id: "run-1",
      account_id: "acct-1",
      flow_id: "flow-1",
      value_text: AGENT,
    };
    h.roster = [AGENT, OTHER];
    const res = await PUT(
      put({ field_id: "f-assign", flow_run_id: "run-1", value: OTHER }),
      params,
    );
    expect(res.status).toBe(403);
    expect(h.upserts).toHaveLength(0);
  });

  it("leaves admins and Flow Tables untouched", async () => {
    seedMetaOwned();
    h.role = "admin";
    h.userId = "u-admin";
    h.run = {
      id: "run-1",
      account_id: "acct-1",
      flow_id: "flow-1",
      value_text: OTHER,
    };
    const adminRes = await PUT(
      put({ field_id: "f-note", flow_run_id: "run-1", value: "x" }),
      params,
    );
    expect(adminRes.status).toBe(200);
    h.role = "agent";
    h.userId = AGENT;
    h.flowKind = null;
    const flowRes = await PUT(
      put({ field_id: "field-1", flow_run_id: "run-1", value: "Contacted" }),
      params,
    );
    expect(flowRes.status).toBe(200);
  });
});
