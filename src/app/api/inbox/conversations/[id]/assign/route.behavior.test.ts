import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavioral contract for POST /api/inbox/conversations/[id]/assign
// with granular permissions:
// - owner/admin: any thread.
// - agent with Manage Assignments: any thread (read NOT granted).
// - plain agent: never (404, no oracle) — not even own threads.
// - view-all-only agent: never (404, no oracle).
// - viewer: never.

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";

let role = "agent";
let userId = UUID_A;
let convRow: Record<string, unknown> | null = null;
let permsRow: Record<string, unknown> | null = null;

function tableChain(table: string) {
  const terminal = async () => {
    if (table === "agent_inbox_permissions") return { data: permsRow, error: null };
    if (table === "conversations") return { data: convRow, error: null };
    if (table === "workspace_values" || table === "flow_runs" || table === "workspace_fields") {
      return { data: null, error: null };
    }
    if (table === "profiles") return { data: [{ user_id: "agent-1" }], error: null };
    return { data: null, error: null };
  };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "in", "update", "delete", "insert", "upsert"])
    chain[m] = () => chain;
  chain.maybeSingle = terminal;
  chain.single = terminal;
  chain.then = (resolve: (v: unknown) => void) => resolve(terminal());
  return chain;
}

const adminDb = { from: vi.fn((t: string) => tableChain(t)) };

vi.mock("@/lib/auth/account", () => ({
  requireRole: vi.fn(async (min: string) => {
    const rank: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };
    if ((rank[role] ?? -1) < (rank[min] ?? 99)) {
      const err = new Error("Forbidden") as Error & { status?: number };
      err.status = role == null ? 401 : 403;
      throw err;
    }
    return { supabase: adminDb, accountId: "acc-1", userId, role, account: { id: "acc-1" } };
  }),
  toErrorResponse: (err: unknown) => {
    const status = (err as { status?: number }).status ?? 500;
    return Response.json({ error: (err as Error).message ?? "error" }, { status });
  },
  getCurrentAccount: vi.fn(async () => ({
    supabase: adminDb,
    accountId: "acc-1",
    userId,
    role,
  })),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => adminDb,
}));

vi.mock("@/lib/inbox/assignment-sync", () => ({
  mirrorConversationAssignmentToWorkspace: vi.fn(async () => true),
}));

import { POST } from "./route";

function assign(id: string, user_id: string | null) {
  return POST(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id }),
    }),
    { params: Promise.resolve({ id }) } as never
  );
}

describe("assign route with granular permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role = "agent";
    userId = UUID_A;
    convRow = null;
    permsRow = null;
  });

  it("manage agent can assign another agent's thread", async () => {
    convRow = { id: CONV, account_id: "acc-1", assigned_agent_id: UUID_B };
    permsRow = { can_manage_assignments: true, can_view_all: false };
    const res = await assign(CONV, UUID_A);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ assigned_agent_id: UUID_A });
  });

  it("manage agent can clear (unassign) any thread", async () => {
    convRow = { id: CONV, account_id: "acc-1", assigned_agent_id: UUID_B };
    permsRow = { can_manage_assignments: true, can_view_all: false };
    const res = await assign(CONV, null);
    expect(res.status).toBe(200);
  });

  it("plain agent gets 404 on another agent's thread (no oracle)", async () => {
    convRow = { id: CONV, account_id: "acc-1", assigned_agent_id: UUID_B };
    permsRow = null;
    const res = await assign(CONV, UUID_A);
    expect(res.status).toBe(404);
  });

  it("plain agent gets 404 on unassigned threads", async () => {
    convRow = { id: CONV, account_id: "acct-1", assigned_agent_id: null };
    permsRow = null;
    const res = await assign(CONV, UUID_A);
    expect(res.status).toBe(404);
  });

  it("plain agent gets 404 even on their own thread (no self-assign)", async () => {
    convRow = { id: CONV, account_id: "acc-1", assigned_agent_id: UUID_A };
    permsRow = null;
    const res = await assign(CONV, UUID_B);
    expect(res.status).toBe(404);
  });

  it("view-all-only agent cannot reassign without Manage Assignments", async () => {
    convRow = { id: CONV, account_id: "acc-1", assigned_agent_id: UUID_B };
    permsRow = { can_manage_assignments: false, can_view_all: true };
    const res = await assign(CONV, UUID_A);
    expect(res.status).toBe(404);
  });

  it("view-all-only agent cannot reassign even their own thread", async () => {
    convRow = { id: CONV, account_id: "acc-1", assigned_agent_id: UUID_A };
    permsRow = { can_manage_assignments: false, can_view_all: true };
    const res = await assign(CONV, null);
    expect(res.status).toBe(404);
  });

  it("viewers can never assign, even with a stale grant row", async () => {
    role = "viewer";
    convRow = { id: CONV, account_id: "acc-1", assigned_agent_id: null };
    permsRow = { can_manage_assignments: true, can_view_all: true };
    const res = await assign(CONV, null);
    expect([403, 404]).toContain(res.status);
  });

  it("owner can assign without any grant row", async () => {
    role = "owner";
    convRow = { id: CONV, account_id: "acc-1", assigned_agent_id: UUID_B };
    permsRow = null;
    const res = await assign(CONV, UUID_A);
    expect(res.status).toBe(200);
  });

  it("rejects cross-account threads with 404", async () => {
    role = "owner";
    // convRow lookup is account-scoped: a foreign thread yields null.
    convRow = null;
    const res = await assign(CONV, UUID_A);
    expect(res.status).toBe(404);
  });
});
