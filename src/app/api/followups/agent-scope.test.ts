import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: agents see ONLY their own reminders (created_by =
// authenticated user id); owner/admin keep workspace-wide access.

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-A",
  rows: [] as Array<Record<string, unknown>>,
  eqFilters: [] as Array<[string, unknown]>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return {
      supabase: fakeSupabase(),
      accountId: h.accountId,
      userId: h.userId,
      role: h.role,
    };
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

function fakeSupabase() {
  h.eqFilters = [];
  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
    limit: () => api,
    eq: (col: string, val: unknown) => {
      h.eqFilters.push([col, val]);
      return api;
    },
    in: () => api,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const rows = h.rows.filter((r) =>
        h.eqFilters.every(([c, v]) => r[c] === v),
      );
      resolve({ data: rows, error: null });
    },
  };
  return { from: () => api };
}

const { GET } = await import("./route");

function seed() {
  h.rows = [
    { id: "a1", account_id: "acct-1", status: "scheduled", created_by: "user-A" },
    { id: "a2", account_id: "acct-1", status: "scheduled", created_by: "user-A" },
    { id: "b1", account_id: "acct-1", status: "scheduled", created_by: "user-B" },
    { id: "x1", account_id: "acct-other", status: "scheduled", created_by: "user-A" },
  ];
}

beforeEach(() => {
  h.authed = true;
  h.accountId = "acct-1";
  h.role = "agent";
  h.userId = "user-A";
  seed();
});

describe("GET /api/followups agent isolation", () => {
  it("Agent A sees only Agent A's reminders", async () => {
    h.userId = "user-A";
    h.role = "agent";
    const res = await GET(new Request("https://app.test/api/followups?status=scheduled"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { followups: Array<{ id: string }> };
    expect(json.followups.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
  });

  it("Agent B sees only Agent B's reminders", async () => {
    h.userId = "user-B";
    h.role = "agent";
    const res = await GET(new Request("https://app.test/api/followups?status=scheduled"));
    const json = (await res.json()) as { followups: Array<{ id: string }> };
    expect(json.followups.map((r) => r.id)).toEqual(["b1"]);
  });

  it("applies the ownership condition inside the query from the server session", async () => {
    h.userId = "user-A";
    h.role = "agent";
    await GET(new Request("https://app.test/api/followups?status=scheduled"));
    expect(h.eqFilters).toContainEqual(["account_id", "acct-1"]);
    expect(h.eqFilters).toContainEqual(["created_by", "user-A"]);
  });

  it("owner retains workspace-wide visibility", async () => {
    h.userId = "owner-1";
    h.role = "owner";
    const res = await GET(new Request("https://app.test/api/followups?status=scheduled"));
    const json = (await res.json()) as { followups: Array<{ id: string }> };
    expect(json.followups.map((r) => r.id).sort()).toEqual(["a1", "a2", "b1"]);
    expect(h.eqFilters).not.toContainEqual(["created_by", "owner-1"]);
  });

  it("admin retains workspace-wide visibility", async () => {
    h.userId = "admin-1";
    h.role = "admin";
    const res = await GET(new Request("https://app.test/api/followups?status=scheduled"));
    const json = (await res.json()) as { followups: Array<{ id: string }> };
    expect(json.followups.map((r) => r.id).sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("ignores any client-supplied user id (no ownership bypass)", async () => {
    h.userId = "user-A";
    h.role = "agent";
    const res = await GET(
      new Request("https://app.test/api/followups?status=scheduled&created_by=user-B&user_id=user-B"),
    );
    const json = (await res.json()) as { followups: Array<{ id: string }> };
    expect(json.followups.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
  });
});
