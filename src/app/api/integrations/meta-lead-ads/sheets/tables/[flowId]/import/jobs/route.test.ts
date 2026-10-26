// Import job routes — members read status, owners resume/cancel,
// everything scoped to the resolved table.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  job: null as Record<string, unknown> | null,
  revived: 0,
  pumpCalledWith: null as string | null,
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

const JOB = {
  id: "job-1",
  status: "running",
  mode: "all",
  total: 81,
  processed: 32,
  sent: 32,
  failed: 0,
  retrying: 0,
  pending: 49,
  inserted: 60,
  updated: 21,
  skipped: 0,
  truncated: false,
  done: false,
  finished_at: null,
  last_error: null,
};

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
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
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

vi.mock("@/lib/meta-lead-sheets/import-jobs", () => ({
  getTableImportJob: async () => h.job,
  getImportJobProgress: async (_db: unknown, job: Record<string, unknown>) => ({ job, sent: 1, failed: 0, retrying: 0, pending: 0, processed: 1, done: true }),
  serializeImportJob: (progress: {
    job: Record<string, unknown>;
    sent: number;
    failed: number;
    retrying: number;
    pending: number;
    processed: number;
    done: boolean;
  }) => ({ ...progress.job }),
  pumpImportJob: async (_db: unknown, jobId: string) => {
    h.pumpCalledWith = jobId;
    return {
      claimed: true,
      progress: { job: h.job, sent: 2, failed: 0, retrying: 0, pending: 0, processed: 2, done: true },
    };
  },
  reviveImportJobFailures: async () => ({ revived: h.revived }),
  cancelImportJob: async () => ({ ...JOB, id: "job-1", status: "cancelled" }),
}));

type Filter = { col: string; val: unknown };

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
      state.filters.push({ col, val });
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

const statusRoute = await import("./[jobId]/route");
const resumeRoute = await import("./[jobId]/resume/route");
const cancelRoute = await import("./[jobId]/cancel/route");

function post(body: unknown) {
  return new Request("https://app.test/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function get() {
  return new Request("https://app.test/api/x", { method: "GET" });
}

const params = (jobId = "job-1") => ({
  params: Promise.resolve({ flowId: "flow-1", jobId }),
});

beforeEach(() => {
  h.authed = true;
  h.role = "owner";
  h.job = { ...JOB };
  h.revived = 0;
  h.pumpCalledWith = null;
});

describe("GET job status", () => {
  it("members can read, strangers get 404", async () => {
    for (const role of ["viewer", "agent"]) {
      h.role = role;
      const res = await statusRoute.GET(get(), params());
      expect(res.status).toBe(200);
    }
    h.role = "owner";
    expect(
      (await statusRoute.GET(get(), { params: Promise.resolve({ flowId: "nope", jobId: "job-1" }) })).status,
    ).toBe(404);
    h.job = null;
    expect((await statusRoute.GET(get(), params())).status).toBe(404);
    h.job = { ...JOB };
  });

  it("returns the serialized job", async () => {
    const res = await statusRoute.GET(get(), params());
    const json = (await res.json()) as { ok: boolean; job: typeof JOB };
    expect(json.ok).toBe(true);
    expect(json.job).toMatchObject({ id: "job-1", total: 81, sent: 32 });
  });
});

describe("POST resume / cancel", () => {
  it("rejects non-owners", async () => {
    for (const role of ["viewer", "agent", "admin"]) {
      h.role = role;
      expect((await resumeRoute.POST(post({}), params())).status).toBe(403);
      expect((await cancelRoute.POST(post({}), params())).status).toBe(403);
    }
    h.role = "owner";
  });

  it("resume pumps the table's job and reports revivals", async () => {
    h.revived = 5;
    const res = await resumeRoute.POST(post({ revive_failures: true }), params());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; revived: number; job: typeof JOB };
    expect(json.ok).toBe(true);
    expect(json.revived).toBe(5);
    expect(h.pumpCalledWith).toBe("job-1");
  });

  it("404s unknown and cross-account tables and jobs", async () => {
    expect(
      (await resumeRoute.POST(post({}), { params: Promise.resolve({ flowId: "flow-other", jobId: "job-1" }) })).status,
    ).toBe(404);
    h.job = null;
    expect((await cancelRoute.POST(post({}), params())).status).toBe(404);
  });

  it("cancel closes the job", async () => {
    const res = await cancelRoute.POST(post({}), params());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; job: { status: string } };
    expect(json.job.status).toBe("cancelled");
  });
});
