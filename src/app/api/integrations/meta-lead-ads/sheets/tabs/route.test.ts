// Worksheet-tab create/delete APIs — explicit single-tab actions,
// validation, duplicates, Google failures, tenant isolation.
// Google is mocked (hoisted tab list); table resolution runs for
// real against a fake Supabase (flows + meta_lead_forms).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  tabs: ["Leads", "Archive"] as string[],
  spreadsheetShouldFail: false,
  createShouldFail: false,
  deleteShouldFail: false,
  createFailure: null as { status: number; reason?: string; retryAfterMs?: number | null } | null,
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
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
  },
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
    getSheetsSpreadsheet: async (_token: string, _id: string) => {
      if (h.spreadsheetShouldFail) {
        throw new actual.SheetsApiError("Google Sheets read failed (403)", 403);
      }
      return {
        spreadsheetId: "spreadsheet-1",
        title: "T",
        tabs: [...h.tabs],
        url: "https://docs.google.com/spreadsheets/d/spreadsheet-1",
      };
    },
    createWorksheetTab: async (_token: string, _id: string, tab: string) => {
      if (h.createShouldFail) {
        throw new actual.SheetsApiError("Google Sheets tab create failed (500)", 500);
      }
      if (h.createFailure) {
        throw new actual.SheetsApiError(
          `Google Sheets tab create failed (${h.createFailure.status})${h.createFailure.reason ? ` [${h.createFailure.reason}]` : ""}`,
          h.createFailure.status,
          {
            reason: h.createFailure.reason ?? null,
            retryAfterMs: h.createFailure.retryAfterMs ?? null,
          }
        );
      }
      h.tabs.push(tab);
    },
    deleteWorksheetTab: async (_token: string, _id: string, tab: string) => {
      if (h.deleteShouldFail) {
        throw new actual.SheetsApiError("Google Sheets tab delete failed (500)", 500);
      }
      h.tabs = h.tabs.filter((t) => t !== tab);
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

const SPREADSHEET = "https://docs.google.com/spreadsheets/d/spreadsheet-1/edit";

function post(body: unknown) {
  return new Request("https://app.test/api/integrations/meta-lead-ads/sheets/tabs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(query: string) {
  return new Request(
    `https://app.test/api/integrations/meta-lead-ads/sheets/tabs?${query}`,
    { method: "DELETE" },
  );
}

beforeEach(() => {
  h.authed = true;
  h.role = "owner";
  h.accountId = "acct-1";
  h.tabs = ["Leads", "Archive"];
  h.spreadsheetShouldFail = false;
  h.createShouldFail = false;
  h.deleteShouldFail = false;
  h.createFailure = null;
});

describe("POST /sheets/tabs (create)", () => {
  it("creates the tab and returns the refreshed list", async () => {
    const res = await route.POST(
      post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "June" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; tab: string; tabs: string[] };
    expect(json).toEqual({ ok: true, tab: "June", tabs: ["Leads", "Archive", "June"] });
  });

  it("rejects duplicates exactly and case-insensitively with 409", async () => {
    const dup = await route.POST(
      post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "Leads" }),
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { tabs: string[] }).tabs).toEqual(["Leads", "Archive"]);

    const caseDup = await route.POST(
      post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "leads" }),
    );
    expect(caseDup.status).toBe(409);
    expect(h.tabs).toEqual(["Leads", "Archive"]);
  });

  it("rejects invalid names, missing tables, and bad spreadsheets", async () => {
    expect(
      (await route.POST(post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "  " }))).status,
    ).toBe(400);
    expect(
      (await route.POST(post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "a/b" }))).status,
    ).toBe(400);
    expect(
      (await route.POST(post({ spreadsheet_url: SPREADSHEET, tab: "June" }))).status,
    ).toBe(400);
    expect(
      (await route.POST(post({ flow_id: "flow-missing", spreadsheet_url: SPREADSHEET, tab: "June" }))).status,
    ).toBe(404);
    // Another account's table is invisible (tenant isolation).
    expect(
      (await route.POST(post({ flow_id: "flow-other", spreadsheet_url: SPREADSHEET, tab: "June" }))).status,
    ).toBe(404);
    expect(
      (await route.POST(post({ flow_id: "flow-1", spreadsheet_url: "not a sheet", tab: "June" }))).status,
    ).toBe(400);
  });

  it("requires the owner (admins included) and surfaces Google failures", async () => {
    for (const role of ["viewer", "agent", "admin"]) {
      h.role = role;
      expect(
        (await route.POST(post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "June" }))).status,
      ).toBe(403);
    }
    h.role = "owner";

    h.createShouldFail = true;
    const res = await route.POST(
      post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "June" }),
    );
    expect(res.status).toBe(502);
  });

  it("classifies tab-creation failures (quota vs permission vs outage)", async () => {
    h.createFailure = { status: 429, reason: "rateLimitExceeded", retryAfterMs: 20_000 };
    const throttled = await route.POST(
      post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "June" }),
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("20");
    expect(((await throttled.json()) as { error: string }).error).toMatch(/rate-limiting/);
    expect(h.tabs).toEqual(["Leads", "Archive"]);

    h.createFailure = { status: 403 };
    const denied = await route.POST(
      post({ flow_id: "flow-1", spreadsheet_url: SPREADSHEET, tab: "June" }),
    );
    expect(denied.status).toBe(502);
    expect(((await denied.json()) as { error: string }).error).toMatch(/Editor/);
  });
});

describe("DELETE /sheets/tabs (delete)", () => {
  const q = (extra: string) =>
    `spreadsheet_id=${encodeURIComponent(SPREADSHEET)}&flow_id=flow-1&${extra}`;

  it("deletes exactly the named tab and returns the refreshed list", async () => {
    const res = await route.DELETE(del(q("tab=Archive")));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; deleted: string; tabs: string[] };
    expect(json).toEqual({ ok: true, deleted: "Archive", tabs: ["Leads"] });
    expect(h.tabs).toEqual(["Leads"]);
  });

  it("404s a missing tab without deleting anything", async () => {
    const res = await route.DELETE(del(q("tab=Nope")));
    expect(res.status).toBe(404);
    expect(h.tabs).toEqual(["Leads", "Archive"]);
  });

  it("requires an explicit tab and the owner role", async () => {
    expect((await route.DELETE(del("tab="))).status).toBe(400);
    expect(
      (await route.DELETE(
        del(`spreadsheet_id=${encodeURIComponent(SPREADSHEET)}&tab=Leads`),
      )).status,
    ).toBe(400);
    for (const role of ["viewer", "agent", "admin"]) {
      h.role = role;
      expect((await route.DELETE(del(q("tab=Leads")))).status).toBe(403);
    }
    h.role = "owner";
  });

  it("rejects other accounts' tables and surfaces Google failures", async () => {
    const cross = await route.DELETE(
      del(
        `spreadsheet_id=${encodeURIComponent(SPREADSHEET)}&flow_id=flow-other&tab=${encodeURIComponent("Leads")}`,
      ),
    );
    expect(cross.status).toBe(404);
    expect(h.tabs).toEqual(["Leads", "Archive"]);

    h.deleteShouldFail = true;
    const res = await route.DELETE(del(q("tab=Leads")));
    expect(res.status).toBe(502);
    expect(h.tabs).toEqual(["Leads", "Archive"]);
  });
});
