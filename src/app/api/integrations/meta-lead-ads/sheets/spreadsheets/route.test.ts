// Create-spreadsheet API — default naming, explicit scoping,
// auth, Google failures. Google creation is mocked; table
// resolution runs for real against a fake Supabase.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  createShouldFail: false,
  createdWith: null as { title: string; tab: string } | null,
  flows: [
    {
      id: "flow-1",
      name: "Video Table",
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
      form_name: "Video Form",
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
    return {
      supabase: fakeSupabase(),
      accountId: h.accountId,
      userId: h.userId,
      role: h.role,
    };
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

vi.mock("@/lib/meta-lead-sheets/oauth", () => ({
  getSheetsAccessToken: async () => "token-1",
  SheetsAuthError: class SheetsAuthError extends Error {},
}));

vi.mock("@/lib/meta-lead-sheets/sheets-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-lead-sheets/sheets-client")>();
  return {
    ...actual,
    createSheetsSpreadsheet: async (_token: string, title: string, tab: string) => {
      if (h.createShouldFail) {
        throw new actual.SheetsApiError("Google Sheets create failed (500)", 500);
      }
      h.createdWith = { title, tab };
      return {
        spreadsheetId: "new-spreadsheet-id",
        title,
        tabs: [tab],
        url: "https://docs.google.com/spreadsheets/d/new-spreadsheet-id",
      };
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
  return new Request(
    "https://app.test/api/integrations/meta-lead-ads/sheets/spreadsheets",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  h.authed = true;
  h.role = "owner";
  h.accountId = "acct-1";
  h.createShouldFail = false;
  h.createdWith = null;
});

describe("POST /sheets/spreadsheets", () => {
  it("creates a spreadsheet named for the table with a Sheet1 tab", async () => {
    const res = await route.POST(post({ flow_id: "flow-1" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      spreadsheet_id: string;
      url: string;
      title: string;
      tabs: string[];
    };
    expect(json).toMatchObject({
      ok: true,
      spreadsheet_id: "new-spreadsheet-id",
      url: "https://docs.google.com/spreadsheets/d/new-spreadsheet-id",
      title: "Meta Leads - Video Form",
      tabs: ["Sheet1"],
    });
    expect(h.createdWith).toEqual({ title: "Meta Leads - Video Form", tab: "Sheet1" });
  });

  it("accepts a custom title and requires a table", async () => {
    const res = await route.POST(post({ flow_id: "flow-1", title: "  Custom  " }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("Custom");

    expect((await route.POST(post({}))).status).toBe(400);
    expect((await route.POST(post({ flow_id: "flow-missing" }))).status).toBe(404);
    // Another account's table is invisible (tenant isolation).
    expect((await route.POST(post({ flow_id: "flow-other" }))).status).toBe(404);
  });

  it("requires the owner (admins included) and surfaces Google failures clearly", async () => {
    for (const role of ["viewer", "agent", "admin"]) {
      h.role = role;
      expect((await route.POST(post({ flow_id: "flow-1" }))).status).toBe(403);
    }
    h.role = "owner";

    h.createShouldFail = true;
    const res = await route.POST(post({ flow_id: "flow-1" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/permissions|Could not create/);
  });
});
