import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavioral contract for /api/account/agent-permissions:
// only the owner can grant/revoke, targets must be same-account
// agents, non-owners get 403, validation is strict.

type Ctx = {
  accountId: string;
  userId: string;
  role: string;
  supabase: unknown;
};

let ctx: Ctx;
let profileRow: Record<string, unknown> | null;
let permRows: Record<string, unknown>[] | null;
let upsertPayload: unknown = null;
let shouldThrowAuth = false;

function tableChain(table: string) {
  let didUpsert = false;
  let upsertValues: unknown = null;
  const terminal = async () => {
    if (table === "profiles") return { data: profileRow, error: null };
    if (table === "agent_inbox_permissions") {
      if (didUpsert) {
        return {
          data: {
            user_id: "11111111-1111-4111-8111-111111111111",
            can_manage_assignments: (upsertValues as Record<string, unknown>)?.can_manage_assignments ?? false,
            can_view_all: (upsertValues as Record<string, unknown>)?.can_view_all ?? false,
            updated_at: "t",
          },
          error: null,
        };
      }
      const rows = permRows ?? [];
      // maybeSingle: first row or null (missing row => defaults path).
      return { data: rows.length > 0 ? rows[0] : null, error: null };
    }
    return { data: null, error: null };
  };
  const b: Record<string, (...args: unknown[]) => unknown> = {};
  const chain = () => b;
  for (const m of ["select", "eq", "order", "limit", "update", "delete", "insert"])
    b[m] = () => chain();
  b.upsert = (values: unknown) => {
    didUpsert = true;
    upsertValues = values;
    upsertPayload = values;
    return chain();
  };
  b.maybeSingle = terminal as (...args: unknown[]) => unknown;
  b.single = terminal as (...args: unknown[]) => unknown;
  b.then = ((resolve: (v: unknown) => unknown) => resolve(terminal())) as (...args: unknown[]) => unknown;
  return b;
}

const supabaseMock = {
  from: vi.fn((table: string) => tableChain(table)),
};

vi.mock("@/lib/auth/account", () => ({
  requireRole: vi.fn(async (min: string) => {
    if (shouldThrowAuth) {
      const err = new Error("Forbidden") as Error & { status?: number };
      err.status = min === "owner" ? 403 : 401;
      throw err;
    }
    return ctx;
  }),
  getCurrentAccount: vi.fn(async () => ctx),
  toErrorResponse: (err: unknown) => {
    const status = (err as { status?: number }).status ?? 500;
    return Response.json(
      { error: (err as Error).message || "error" },
      { status }
    );
  },
}));

import { GET as GET_ONE, PUT } from "./route";
import { GET as GET_ME } from "./me/route";

function req(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const OWNER = { accountId: "acc-1", userId: "44444444-4444-4444-8444-444444444444", role: "owner" };
const AGENT_ROW = { user_id: "11111111-1111-4111-8111-111111111111", account_id: "acc-1", account_role: "agent" };

describe("PUT /api/account/agent-permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldThrowAuth = false;
    upsertPayload = null;
    ctx = { ...OWNER, supabase: supabaseMock } as unknown as Ctx;
    profileRow = { ...AGENT_ROW };
    permRows = null;
  });

  it("owner grants manage_assignments to an agent (200 + upsert)", async () => {
    const res = await PUT(
      req("PUT", "http://localhost/api/account/agent-permissions", {
        user_id: "11111111-1111-4111-8111-111111111111",
        can_manage_assignments: true,
      })
    );
    expect(res.status).toBe(200);
    expect(upsertPayload).toMatchObject({
      account_id: "acc-1",
      user_id: "11111111-1111-4111-8111-111111111111",
      can_manage_assignments: true,
    });
  });

  it("non-owner cannot grant (403) and nothing is written", async () => {
    ctx = { accountId: "acc-1", userId: "22222222-2222-4222-8222-222222222222", role: "agent", supabase: supabaseMock } as unknown as Ctx;
    shouldThrowAuth = true;
    const res = await PUT(
      req("PUT", "http://localhost/api/account/agent-permissions", {
        user_id: "11111111-1111-4111-8111-111111111111",
        can_manage_assignments: true,
      })
    );
    expect(res.status).toBe(403);
    expect(upsertPayload).toBeNull();
  });

  it("rejects non-agent targets and cross-account members", async () => {
    profileRow = { user_id: "33333333-3333-4333-8333-333333333333", account_id: "acc-1", account_role: "admin" };
    const adminRes = await PUT(
      req("PUT", "http://localhost/api/account/agent-permissions", {
        user_id: "33333333-3333-4333-8333-333333333333",
        can_view_all: true,
      })
    );
    expect(adminRes.status).toBe(400);

    profileRow = null;
    const missing = await PUT(
      req("PUT", "http://localhost/api/account/agent-permissions", {
        user_id: "22222222-2222-4222-8222-222222222222",
        can_view_all: true,
      })
    );
    expect(missing.status).toBe(400);
  });

  it("validates input strictly", async () => {
    const badId = await PUT(
      req("PUT", "http://localhost/api/account/agent-permissions", {
        user_id: "not-a-uuid",
        can_manage_assignments: true,
      })
    );
    expect(badId.status).toBe(400);

    const badType = await PUT(
      req("PUT", "http://localhost/api/account/agent-permissions", {
        user_id: "11111111-1111-4111-8111-111111111111",
        can_manage_assignments: "yes",
      })
    );
    expect(badType.status).toBe(400);

    const empty = await PUT(
      req("PUT", "http://localhost/api/account/agent-permissions", { user_id: "11111111-1111-4111-8111-111111111111" })
    );
    expect(empty.status).toBe(400);
  });
});

describe("GET /api/account/agent-permissions?user_id=", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldThrowAuth = false;
    ctx = { ...OWNER, supabase: supabaseMock } as unknown as Ctx;
    permRows = [
      { user_id: "11111111-1111-4111-8111-111111111111", can_manage_assignments: true, can_view_all: false, updated_at: "t" },
    ];
  });

  it("owner reads an agent's flags; missing row returns defaults", async () => {
    const res = await GET_ONE(req("GET", "http://localhost/x?user_id=11111111-1111-4111-8111-111111111111"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { permission: { can_manage_assignments: boolean } };
    expect(json.permission.can_manage_assignments).toBe(true);
  });

  it("requires user_id and owner role", async () => {
    const noParam = await GET_ONE(req("GET", "http://localhost/x"));
    expect(noParam.status).toBe(400);

    shouldThrowAuth = true;
    ctx = { accountId: "acc-1", userId: "22222222-2222-4222-8222-222222222222", role: "agent", supabase: supabaseMock } as unknown as Ctx;
    const forbidden = await GET_ONE(req("GET", "http://localhost/x?user_id=11111111-1111-4111-8111-111111111111"));
    expect(forbidden.status).toBe(403);
  });
});

describe("GET /api/account/agent-permissions/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldThrowAuth = false;
  });

  it("returns the caller's own flags (agent with grants)", async () => {
    permRows = [
      { user_id: "55555555-5555-4555-8555-555555555555", can_manage_assignments: false, can_view_all: true },
    ];
    ctx = { accountId: "acc-1", userId: "55555555-5555-4555-8555-555555555555", role: "agent", supabase: supabaseMock } as unknown as Ctx;
    const res = await GET_ME();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ can_manage_assignments: false, can_view_all: true });
  });

  it("returns all-false defaults when no row exists", async () => {
    permRows = [];
    ctx = { accountId: "acc-1", userId: "55555555-5555-4555-8555-555555555555", role: "agent", supabase: supabaseMock } as unknown as Ctx;
    const res = await GET_ME();
    expect(await res.json()).toEqual({ can_manage_assignments: false, can_view_all: false });
  });

  it("viewers keep legacy read-all via /me (no manage rights)", async () => {
    permRows = [];
    ctx = { accountId: "acc-1", userId: "66666666-6666-4666-8666-666666666666", role: "viewer", supabase: supabaseMock } as unknown as Ctx;
    const res = await GET_ME();
    expect(await res.json()).toEqual({ can_manage_assignments: false, can_view_all: true });
  });

  it("owners get full caps without a table read", async () => {
    let queried = false;
    const tracking = {
      from: vi.fn(() => {
        queried = true;
        return tableChain("agent_inbox_permissions");
      }),
    };
    ctx = { accountId: "acc-1", userId: "44444444-4444-4444-8444-444444444444", role: "owner", supabase: tracking } as unknown as Ctx;
    const res = await GET_ME();
    expect(await res.json()).toEqual({ can_view_all: true, can_manage_assignments: true });
    expect(queried).toBe(false);
  });
});


