// Table retry API — owner-only, table-scoped revival + drain.
// revive_failed resets this table's failed rows (fresh budget, due
// now) without touching sent rows; submission_id narrows to one
// verified submission. Drain stays scoped to the table's form.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  drainArgs: null as Record<string, unknown> | null,
  reviveArgs: null as { accountId: string; formId: string } | null,
  revived: 0,
  submissions: [
    { id: "sub-1", account_id: "acct-1", form_id: "form-1" },
  ] as Array<Record<string, unknown>>,
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
    drainSheetsQueue: async (_db: unknown, opts: Record<string, unknown>) => {
      h.drainArgs = opts;
      return { sent: 2, failed: 0, retrying: 1 };
    },
    reviveTableFailedRows: async (db: unknown, accountId: string, formId: string) => {
      void db;
      h.reviveArgs = { accountId, formId };
      return { revived: h.revived };
    },
  };
});

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const state = { table: "", filters: [] as Filter[] };
  function rows(): Array<Record<string, unknown>> {
    switch (state.table) {
      case "flows": return h.flows;
      case "meta_lead_forms": return h.forms;
      case "meta_lead_submissions": return h.submissions;
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
  h.drainArgs = null;
  h.reviveArgs = null;
  h.revived = 0;
});

describe("POST retry — authorization and isolation", () => {
  it("rejects non-owners (admins included)", async () => {
    for (const role of ["viewer", "agent", "admin"]) {
      h.role = role;
      expect((await route.POST(post({}), params)).status).toBe(403);
    }
    h.role = "owner";
  });

  it("404s unknown and cross-account tables", async () => {
    expect(
      (await route.POST(post({}), { params: Promise.resolve({ flowId: "nope" }) })).status,
    ).toBe(404);
    expect(
      (await route.POST(post({}), { params: Promise.resolve({ flowId: "flow-other" }) })).status,
    ).toBe(404);
  });
});

describe("POST retry — revive + drain", () => {
  it("revives one table's failed rows before draining", async () => {
    h.revived = 61;
    const res = await route.POST(post({ revive_failed: true }), params);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      revived: number;
      sent: number;
      retrying: number;
    };
    expect(json.ok).toBe(true);
    expect(json.revived).toBe(61);
    // Scoped to this account + form, never a sibling table.
    expect(h.reviveArgs).toEqual({ accountId: "acct-1", formId: "form-1" });
    expect(h.drainArgs).toMatchObject({
      onlyAccountId: "acct-1",
      onlyFormId: "form-1",
      force: true,
    });
    expect(json.sent).toBe(2);
    expect(json.retrying).toBe(1);
  });

  it("drains without reviving when revive_failed is absent", async () => {
    const res = await route.POST(post({}), params);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; revived: number };
    expect(json.ok).toBe(true);
    expect(json.revived).toBe(0);
    expect(h.reviveArgs).toBeNull();
    expect(h.drainArgs).toMatchObject({ onlyFormId: "form-1" });
  });

  it("404s unknown submissions and 404s other tables' submissions", async () => {
    expect(
      (await route.POST(post({ submission_id: "nope" }), params)).status,
    ).toBe(404);
    h.submissions.push({ id: "sub-x", account_id: "acct-1", form_id: "other" });
    expect(
      (await route.POST(post({ submission_id: "sub-x" }), params)).status,
    ).toBe(404);
    h.submissions.pop();
  });
});
