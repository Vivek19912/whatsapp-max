// Manual table import API — owner-only, table-scoped, validated
// modes, per-table config required. Classification + drain are
// mocked; table resolution runs for real against a fake Supabase.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  hasConfigRow: true,
  importSummary: { total: 3, imported: 2, updated: 1, skipped: 0, failed: 0, truncated: false },
  importArgs: null as { accountId: string; formId: string; range: unknown } | null,
  drainArgs: null as Record<string, unknown> | null,
  flows: [
    {
      id: "flow-1",
      name: "Table 1",
      kind: "meta_lead_ads",
      meta_form_id: "formdb-1",
      account_id: "acct-1",
    },
    {
      id: "flow-other",
      name: "Other",
      kind: "meta_lead_ads",
      meta_form_id: "formdb-other",
      account_id: "acct-2",
    },
  ] as Array<Record<string, unknown>>,
  forms: [
    {
      id: "formdb-1",
      form_id: "form-1",
      form_name: "Form 1",
      enabled: true,
      account_id: "acct-1",
    },
  ] as Array<Record<string, unknown>>,
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

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => fakeSupabase(),
}));

vi.mock("@/lib/meta-lead-sheets/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-lead-sheets/queue")>();
  return {
    ...actual,
    importTableLeads: async (
      _db: unknown,
      accountId: string,
      formId: string,
      range: unknown,
    ) => {
      h.importArgs = { accountId, formId, range };
      return h.importSummary;
    },
    drainSheetsQueue: async (_db: unknown, opts: Record<string, unknown>) => {
      h.drainArgs = opts;
      return { sent: 2, failed: 1 };
    },
  };
});

vi.mock("@/lib/meta-lead-sheets/trigger", () => ({
  scheduleSheetsDrainSoon: () => undefined,
}));

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const state = { table: "", filters: [] as Filter[] };
  function rows(): Array<Record<string, unknown>> {
    switch (state.table) {
      case "flows": return h.flows;
      case "meta_lead_forms": return h.forms;
      case "meta_lead_sheets_configs":
        return h.hasConfigRow
          ? [{ account_id: h.accountId, form_id: "form-1", spreadsheet_id: "sheet-1" }]
          : [];
      default: return [];
    }
  }
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    maybeSingle: async () => ({
      data:
        rows().find((r) =>
          state.filters.every((f) => r[f.col] === f.val),
        ) ?? null,
      error: null,
    }),
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      return api;
    },
  };
}

const route = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ flowId: "flow-1" }) };

beforeEach(() => {
  h.authed = true;
  h.role = "owner";
  h.hasConfigRow = true;
  h.importArgs = null;
  h.drainArgs = null;
});

describe("POST import — authorization and isolation", () => {
  it("rejects non-owners (admins included)", async () => {
    for (const role of ["viewer", "agent", "admin"]) {
      h.role = role;
      expect((await route.POST(post({ mode: "all" }), params)).status).toBe(403);
    }
    h.role = "owner";
  });

  it("404s unknown and cross-account tables", async () => {
    expect(
      (await route.POST(post({ mode: "all" }), { params: Promise.resolve({ flowId: "nope" }) })).status,
    ).toBe(404);
    expect(
      (await route.POST(post({ mode: "all" }), { params: Promise.resolve({ flowId: "flow-other" }) })).status,
    ).toBe(404);
  });

  it("requires a saved sheet configuration", async () => {
    h.hasConfigRow = false;
    const res = await route.POST(post({ mode: "all" }), params);
    expect(res.status).toBe(409);
  });
});

describe("POST import — validation", () => {
  it("rejects unknown modes and bad ranges", async () => {
    expect((await route.POST(post({}), params)).status).toBe(400);
    expect((await route.POST(post({ mode: "everything" }), params)).status).toBe(400);
    expect((await route.POST(post({ mode: "range" }), params)).status).toBe(400);
    expect(
      (await route.POST(post({ mode: "range", from: "2026-13-01", to: "2026-03-31" }), params)).status,
    ).toBe(400);
    expect(
      (await route.POST(post({ mode: "range", from: "2026-03-31", to: "2026-03-01" }), params)).status,
    ).toBe(400);
  });

  it("passes the table scope and range through", async () => {
    const rangeRes = await route.POST(
      post({ mode: "range", from: "2026-03-01", to: "2026-03-31" }),
      params,
    );
    expect(rangeRes.status).toBe(200);
    expect(h.importArgs).toEqual({
      accountId: "acct-1",
      formId: "form-1",
      range: { from: "2026-03-01", to: "2026-03-31" },
    });

    const allRes = await route.POST(post({ mode: "all" }), params);
    expect(allRes.status).toBe(200);
    expect(h.importArgs).toMatchObject({ accountId: "acct-1", formId: "form-1", range: null });
  });
});

describe("POST import — summary", () => {
  it("merges classification with drain counts", async () => {
    const res = await route.POST(post({ mode: "all" }), params);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      import: { total: number; imported: number; updated: number; skipped: number; failed: number };
      drain: { sent: number; failed: number };
    };
    expect(json.ok).toBe(true);
    expect(json.import).toMatchObject({ total: 3, imported: 2, updated: 1 });
    expect(json.drain).toEqual({ sent: 2, failed: 1 });
    // The inline drain stays scoped to this table's form.
    expect(h.drainArgs).toMatchObject({ onlyAccountId: "acct-1", onlyFormId: "form-1", force: true });
  });
});
