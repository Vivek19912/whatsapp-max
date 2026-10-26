// Table Sheets config GET — selectedColumns + hasCustomColumns.
// Distinguishes an explicitly saved column selection (loaded
// verbatim, even ID-first) from new/legacy configurations (dialog
// applies its ID-last default). Google + queue status are mocked;
// table resolution runs for real against a fake Supabase.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "u-1",
  backfillCalls: 0,
  drainCalls: 0,
  tabsCreated: 0,
  upserted: null as Record<string, unknown> | null,
  rawColumnConfig: undefined as unknown,
  hasConfigRow: true,
  statusColumns: null as Array<{ key: string; label: string }> | null,
  flows: [
    {
      id: "flow-1",
      name: "Table 1",
      kind: "meta_lead_ads",
      meta_form_id: "formdb-1",
      account_id: "acct-1",
    },
  ] as Array<Record<string, unknown>>,
  forms: [
    {
      id: "formdb-1",
      form_id: "form-1",
      form_name: "Form 1",
      enabled: true,
      questions: [],
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

vi.mock("@/lib/meta-lead-sheets/oauth", () => ({
  getSheetsAccessToken: async () => "token-1",
  SheetsAuthError: class SheetsAuthError extends Error {},
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => fakeSupabase(),
}));

vi.mock("@/lib/meta-lead-sheets/sheets-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-lead-sheets/sheets-client")>();
  return {
    ...actual,
    getSheetsSpreadsheet: async (_token: string, id: string) => ({
      spreadsheetId: id,
      title: "T",
      tabs: ["Leads"],
      url: `https://docs.google.com/spreadsheets/d/${id}`,
    }),
    createWorksheetTab: async () => {
      h.tabsCreated += 1;
    },
    ensureSheetsHeader: async () => ({ updated: true }),
  };
});

vi.mock("@/lib/meta-lead-sheets/trigger", () => ({
  scheduleSheetsDrainSoon: () => undefined,
}));

vi.mock("@/lib/meta-lead-sheets/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-lead-sheets/queue")>();
  return {
    ...actual,
    invalidateTableRowMappings: async () => ({ invalidated: 0 }),
    enqueueFormsDelta: async () => ({ enqueued: 0, alreadyQueued: 0, total: 0 }),
    backfillFormSheets: async () => {
      h.backfillCalls += 1;
      return { enqueued: 2, alreadyQueued: 0, total: 2 };
    },
    drainSheetsQueue: async () => {
      h.drainCalls += 1;
      return { sent: 2, failed: 0 };
    },
    remapLayoutChunk: async () => ({ done: true, remapped: 0, skipped: 0 }),
    applyIdColumnVisibility: async () => undefined,
    getTableSheetsStatus: async () => ({
      connected: true,
      email: "g@example.com",
      needsReauth: false,
      spreadsheetId: h.hasConfigRow ? "sheet-1" : null,
      spreadsheetUrl: null,
      spreadsheetTitle: null,
      sheetTab: null,
      autoSync: true,
      lastSuccessAt: null,
      lastError: null,
      pending: 0,
      failed: 0,
      columns: h.statusColumns,
      remapPending: false,
      cleanupPreview: { managedRows: 0 },
    }),
  };
});

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    upsertObj: null as Record<string, unknown> | null,
    updateObj: null as Record<string, unknown> | null,
    insertRows: null as Array<Record<string, unknown>> | null,
    deleteMode: false,
  };
  function rows(): Array<Record<string, unknown>> {
    switch (state.table) {
      case "flows": return h.flows;
      case "meta_lead_forms": return h.forms;
      case "meta_lead_sheets_configs":
        return h.hasConfigRow
          ? [{
              account_id: h.accountId,
              form_id: "form-1",
              spreadsheet_id: "1111111111111111111111",
              sheet_tab: "Leads",
              column_config: h.rawColumnConfig,
            }]
          : [];
      case "meta_lead_submissions": return [];
      case "meta_lead_sheets_queue": return [];
      default: return [];
    }
  }
  const matched = () =>
    rows().filter((r) =>
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
    order: () => api,
    limit: () => api,
    insert: (input: Record<string, unknown> | Array<Record<string, unknown>>) => {
      state.insertRows = Array.isArray(input) ? input : [input];
      return api;
    },
    update: (obj: Record<string, unknown>) => {
      state.updateObj = obj;
      return api;
    },
    delete: () => {
      state.deleteMode = true;
      return api;
    },
    upsert: (obj: Record<string, unknown>) => {
      state.upsertObj = obj;
      return api;
    },
    maybeSingle: async () => {
      if (state.updateObj) {
        for (const r of matched()) Object.assign(r, state.updateObj);
        return { data: matched()[0] ?? null, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
    },
    single: async () => {
      if (state.upsertObj) {
        h.upserted = { ...state.upsertObj };
        return { data: state.upsertObj, error: null };
      }
      if (state.insertRows) {
        return { data: state.insertRows[0] ?? null, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.upsertObj) {
        h.upserted = { ...state.upsertObj };
        return resolve({ data: [state.upsertObj], error: null });
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return resolve({ data: list, error: null });
      }
      if (state.deleteMode) {
        return resolve({ data: [], error: null });
      }
      return resolve({ data: matched(), error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.upsertObj = null;
      state.updateObj = null;
      state.insertRows = null;
      state.deleteMode = false;
      return api;
    },
  };
}

const route = await import("./route");

function get() {
  return new Request("https://app.test/api/x", { method: "GET" });
}

const params = { params: Promise.resolve({ flowId: "flow-1" }) };

beforeEach(() => {
  h.authed = true;
  h.role = "owner";
  h.hasConfigRow = true;
  h.rawColumnConfig = undefined;
  h.statusColumns = null;
  h.backfillCalls = 0;
  h.drainCalls = 0;
  h.tabsCreated = 0;
  h.upserted = null;
});

describe("GET config — selection semantics", () => {
  it("reports no custom selection for a never-configured table", async () => {
    h.hasConfigRow = false;
    const res = await route.GET(get(), params);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      selectedColumns: unknown;
      hasCustomColumns: unknown;
    };
    expect(json.selectedColumns).toBeNull();
    expect(json.hasCustomColumns).toBe(false);
  });

  it("reports no custom selection for a legacy row without column_config", async () => {
    h.rawColumnConfig = null;
    h.statusColumns = [
      { key: "meta_lead_id", label: "Meta Lead ID" },
      { key: "name", label: "Name" },
    ];
    const res = await route.GET(get(), params);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      selectedColumns: unknown;
      hasCustomColumns: unknown;
    };
    // The resolved ID-first default is still returned (sync keeps
    // using it), but the dialog must NOT treat it as a saved
    // selection — it applies the ID-last default instead.
    expect(json.hasCustomColumns).toBe(false);
  });

  it("reports an explicit selection verbatim, even ID-first", async () => {
    const explicit = [
      { key: "meta_lead_id", label: "Meta Lead ID" },
      { key: "name", label: "Name" },
      { key: "answer:budget", label: "Budget" },
    ];
    h.rawColumnConfig = explicit;
    h.statusColumns = explicit;
    const res = await route.GET(get(), params);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      selectedColumns: unknown;
      hasCustomColumns: unknown;
    };
    expect(json.hasCustomColumns).toBe(true);
    expect(json.selectedColumns).toEqual(explicit);
  });

  it("404s unknown tables", async () => {
    const res = await route.GET(get(), {
      params: Promise.resolve({ flowId: "flow-missing" }),
    });
    expect(res.status).toBe(404);
  });
});

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1111111111111111111111";
const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "meta_lead_id", label: "Meta Lead ID" },
];

function put(body: unknown) {
  return new Request("https://app.test/api/x", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT config — first-save import, no re-import, explicit tabs", () => {
  it("rejects non-owners (admins included)", async () => {
    for (const role of ["viewer", "agent", "admin"]) {
      h.role = role;
      const res = await route.PUT(
        put({ spreadsheet_url: SHEET_URL, sheet_tab: "Leads", columns: COLUMNS }),
        params,
      );
      expect(res.status).toBe(403);
    }
    h.role = "owner";
  });

  it("auto-imports existing leads on the first configuration", async () => {
    h.hasConfigRow = false;
    const res = await route.PUT(
      put({
        spreadsheet_url: SHEET_URL,
        sheet_tab: "Leads",
        create_tab: false,
        auto_sync: true,
        columns: COLUMNS,
      }),
      params,
    );
    expect(res.status).toBe(200);
    // The new spreadsheet is persisted for this table…
    expect(h.upserted).toMatchObject({
      account_id: "acct-1",
      form_id: "form-1",
      spreadsheet_id: "1111111111111111111111",
      sheet_tab: "Leads",
      auto_sync: true,
    });
    expect(h.upserted?.column_config).toEqual(COLUMNS);
    // …and the one-time historical import ran (idempotent
    // backfill + immediate drain), without creating any tab.
    expect(h.backfillCalls).toBe(1);
    expect(h.drainCalls).toBe(1);
    expect(h.tabsCreated).toBe(0);
    const json = (await res.json()) as { backfill?: { enqueued: number } | null };
    expect(json.backfill?.enqueued).toBe(2);
  });

  it("never re-imports on subsequent saves", async () => {
    h.rawColumnConfig = COLUMNS;
    const res = await route.PUT(
      put({
        spreadsheet_url: SHEET_URL,
        sheet_tab: "Leads",
        create_tab: false,
        auto_sync: true,
        columns: COLUMNS,
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(h.backfillCalls).toBe(0);
    expect(h.drainCalls).toBe(0);
    const json = (await res.json()) as { backfill?: unknown };
    expect(json.backfill ?? null).toBeNull();
  });

  it("rejects a missing tab when creation is not requested", async () => {
    h.hasConfigRow = false;
    const res = await route.PUT(
      put({
        spreadsheet_url: SHEET_URL,
        sheet_tab: "Nope",
        create_tab: false,
        columns: COLUMNS,
      }),
      params,
    );
    expect(res.status).toBe(400);
    expect(h.tabsCreated).toBe(0);
  });
});
