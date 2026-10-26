// Manual table import API — owner-only, table-scoped, validated
// modes, per-table config required. Job creation + pump are
// mocked; table resolution runs for real against a fake Supabase.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  hasConfigRow: true,
  activeJobId: null as string | null,
  createArgs: null as { accountId: string; formId: string; range: unknown } | null,
  pumpJobId: null as string | null,
  job: {
    id: "job-1",
    status: "running",
    mode: "all",
    range_from: null,
    range_to: null,
    total: 81,
    skipped: 0,
    inserted_total: 60,
    updated_total: 21,
    truncated: false,
  },
  progress: {
    job: {
      id: "job-1",
      status: "running",
      mode: "all",
      range_from: null,
      range_to: null,
      total: 81,
      skipped: 0,
      inserted_total: 60,
      updated_total: 21,
      truncated: false,
      finished_at: null,
      last_error: null,
    },
    sent: 25,
    failed: 0,
    retrying: 5,
    pending: 51,
    processed: 25,
    done: false,
  },
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

class MockActiveImportJobError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super("An import is already running for this table.");
    this.name = "ActiveImportJobError";
    this.jobId = jobId;
  }
}

vi.mock("@/lib/meta-lead-sheets/import-jobs", () => ({
  ActiveImportJobError: MockActiveImportJobError,
  createImportJob: async (
    _db: unknown,
    args: { accountId: string; formId: string; range: unknown },
  ) => {
    h.createArgs = args;
    if (h.activeJobId) {
      throw new MockActiveImportJobError(h.activeJobId);
    }
    return h.job;
  },
  pumpImportJob: async (_db: unknown, jobId: string) => {
    h.pumpJobId = jobId;
    return { claimed: true, progress: h.progress };
  },
  serializeImportJob: (progress: {
    job: Record<string, unknown>;
    sent: number;
    failed: number;
    retrying: number;
    pending: number;
    processed: number;
    done: boolean;
  }) => ({
    id: "job-1",
    status: "running",
    total: progress.job.total,
    inserted: progress.job.inserted_total,
    updated: progress.job.updated_total,
    skipped: progress.job.skipped,
    truncated: progress.job.truncated,
    sent: progress.sent,
    failed: progress.failed,
    retrying: progress.retrying,
    pending: progress.pending,
    processed: progress.processed,
    done: progress.done,
  }),
}));

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
  h.activeJobId = null;
  h.createArgs = null;
  h.pumpJobId = null;
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
    expect(h.createArgs).toEqual({
      accountId: "acct-1",
      formId: "form-1",
      flowId: "flow-1",
      mode: "range",
      range: { from: "2026-03-01", to: "2026-03-31" },
      createdBy: "owner-1",
    });

    const allRes = await route.POST(post({ mode: "all" }), params);
    expect(allRes.status).toBe(200);
    expect(h.createArgs).toMatchObject({ accountId: "acct-1", formId: "form-1", mode: "all", range: null });
  });
});

describe("POST import — durable job", () => {
  it("returns the job after one bounded worker pass", async () => {
    const res = await route.POST(post({ mode: "all" }), params);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      job: {
        id: string;
        status: string;
        total: number;
        processed: number;
        sent: number;
        retrying: number;
        pending: number;
        inserted: number;
        updated: number;
        skipped: number;
        done: boolean;
      };
    };
    expect(json.ok).toBe(true);
    expect(json.job).toMatchObject({
      id: "job-1",
      total: 81,
      sent: 25,
      retrying: 5,
      pending: 51,
      processed: 25,
      inserted: 60,
      updated: 21,
      done: false,
    });
    // The inline worker pass ran for the created job.
    expect(h.pumpJobId).toBe("job-1");
  });

  it("returns 409 with the running job instead of a duplicate", async () => {
    h.activeJobId = "job-running";
    const res = await route.POST(post({ mode: "all" }), params);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; jobId?: string };
    expect(json.jobId).toBe("job-running");
    expect(json.error).toContain("already running");
    // No worker pass runs for the rejected duplicate.
    expect(h.pumpJobId).toBeNull();
  });
});
