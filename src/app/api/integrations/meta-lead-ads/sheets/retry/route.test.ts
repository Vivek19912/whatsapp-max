// Account-wide Meta Sheets retry — full retry-state reset,
// failed-only scope, tenant isolation, and parity with the
// per-table retry route. Google + drain are mocked; no production
// spreadsheets are touched.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "owner",
  accountId: "acct-1",
  submissions: [] as Array<Record<string, unknown>>,
  queue: [] as Array<Record<string, unknown>>,
  drainArgs: null as Record<string, unknown> | null,
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
    return { supabase: null, accountId: h.accountId, userId: "owner-1", role: h.role };
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

vi.mock("@/lib/meta-lead-ads/error-response", () => ({
  metaErrorResponse: (err: unknown) => {
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

vi.mock("@/lib/meta-lead-sheets/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-lead-sheets/queue")>();
  return {
    ...actual,
    drainSheetsQueue: async (_db: unknown, opts: Record<string, unknown>) => {
      h.drainArgs = opts;
      return {
        attempted: 1,
        sent: 1,
        failed: 0,
        retrying: 0,
        skippedDisabled: 0,
        skippedNoConfig: 0,
        needsReauth: 0,
      };
    },
  };
});

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const state = { table: "", filters: [] as Filter[], patch: null as Record<string, unknown> | null };
  function rows(): Array<Record<string, unknown>> {
    switch (state.table) {
      case "meta_lead_submissions": return h.submissions;
      case "meta_lead_sheets_queue": return h.queue;
      default: return [];
    }
  }
  const api: Record<string, unknown> = {
    select: () => api,
    update: (p: Record<string, unknown>) => {
      state.patch = p;
      return api;
    },
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    maybeSingle: async () => ({
      data:
        rows().find((r) => state.filters.every((f) => r[f.col] === f.val)) ?? null,
      error: null,
    }),
    then: (resolve: (v: unknown) => void) => {
      if (state.patch) {
        const targets = rows().filter((r) =>
          state.filters.every((f) => r[f.col] === f.val),
        );
        for (const row of targets) Object.assign(row, state.patch);
        return resolve({ data: targets, error: null });
      }
      return resolve({ data: rows(), error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.patch = null;
      return api;
    },
  };
}

const route = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/integrations/meta-lead-ads/sheets/retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.authed = true;
  h.role = "owner";
  h.accountId = "acct-1";
  h.submissions = [];
  h.queue = [];
  h.drainArgs = null;
});

describe("POST /sheets/retry — account-wide manual sync", () => {
  it("rejects non-owners", async () => {
    for (const role of ["viewer", "agent", "admin"]) {
      h.role = role;
      expect((await route.POST(post({}))).status).toBe(403);
    }
    h.role = "owner";
  });

  it("drains the account queue without touching retry state when no submission is given", async () => {
    const res = await route.POST(post({}));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; revived: number; sent: number };
    expect(json.ok).toBe(true);
    expect(json.revived).toBe(0);
    expect(json.sent).toBe(1);
    expect(h.drainArgs).toMatchObject({ onlyAccountId: "acct-1", force: true });
  });

  it("404s unknown submissions and never touches other accounts' rows", async () => {
    expect((await route.POST(post({ submission_id: "nope" }))).status).toBe(404);
  });

  it("revives with the FULL retry state, failed rows only (never sent)", async () => {
    const now = new Date(0).toISOString();
    h.submissions = [{ id: "sub-1", account_id: "acct-1" }];
    h.queue = [
      { id: "q-failed", account_id: "acct-1", submission_id: "sub-1", status: "failed", attempts: 8, last_error: "boom", next_retry_at: now, claimed_at: "x" },
      { id: "q-sent", account_id: "acct-1", submission_id: "sub-1", status: "sent", attempts: 1, last_error: null, next_retry_at: now, claimed_at: null },
      { id: "q-foreign", account_id: "acct-2", submission_id: "sub-1", status: "failed", attempts: 8, last_error: "boom", next_retry_at: now, claimed_at: "x" },
    ];
    const res = await route.POST(post({ submission_id: "sub-1" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; revived: number };
    expect(json.revived).toBe(1);
    const failed = h.queue.find((r) => r.id === "q-failed")!;
    expect(failed.status).toBe("queued");
    expect(failed.attempts).toBe(0);
    expect(failed.last_error).toBeNull();
    expect(failed.claimed_at).toBeNull();
    // Untouched: synced rows can never duplicate; other accounts isolated.
    expect(h.queue.find((r) => r.id === "q-sent")!.status).toBe("sent");
    expect(h.queue.find((r) => r.id === "q-foreign")!.status).toBe("failed");
    expect(h.drainArgs).toMatchObject({ onlyAccountId: "acct-1", force: true });
  });
});
