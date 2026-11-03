import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner" as string | null,
  accountId: "acct-1",
  // Auth admin behavior.
  createResult: "ok" as "ok" | "duplicate" | "error",
  createdWith: null as Record<string, unknown> | null,
  deletedUsers: [] as string[],
  // DB state.
  freshProfile: null as { account_id: string } | null,
  remainingInOrphan: [] as unknown[],
  profileWrites: [] as Array<{ op: string; row?: unknown }>,
  deletedAccounts: [] as string[],
  failProfileMove: false,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: {},
    accountId: h.accountId,
    userId: "owner-1",
    role: h.role,
    account: { id: h.accountId, name: "Acme" },
  }),
  requireRole: async (min: string) => {
    if (!h.role) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return {
      supabase: {},
      accountId: h.accountId,
      userId: "owner-1",
      role: h.role,
      account: { id: h.accountId, name: "Acme" },
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

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        createUser: async (args: Record<string, unknown>) => {
          h.createdWith = { ...args };
          if (h.createResult === "duplicate") {
            return {
              data: { user: null },
              error: { message: "User already registered", code: 422 },
            };
          }
          if (h.createResult === "error") {
            return { data: { user: null }, error: { message: "boom" } };
          }
          return { data: { user: { id: "new-user-1" } }, error: null };
        },
        deleteUser: async (id: string) => {
          h.deletedUsers.push(id);
          return { data: {}, error: null };
        },
      },
    },
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: h.freshProfile, error: null }),
              limit: async () => ({ data: h.remainingInOrphan, error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              if (h.failProfileMove) return { data: null, error: { message: "db down" } };
              h.profileWrites.push({ op: "update", row: patch });
              return { data: null, error: null };
            },
          }),
          insert: (row: Record<string, unknown>) => {
            h.profileWrites.push({ op: "insert", row });
            return { data: null, error: null };
          },
        };
      }
      if (table === "accounts") {
        return {
          delete: () => ({
            eq: async (col: string, val: unknown) => {
              if (col === "id") h.deletedAccounts.push(val as string);
              return { data: null, error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { POST } = await import("./route");

function post(body: Record<string, unknown>) {
  // Every legacy case sends a valid name unless it explicitly
  // opts out (name: undefined serializes to absent).
  return POST(
    new Request("https://app.test/api/account/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Vikas Sahni", ...body }),
    }),
  );
}

beforeEach(() => {
  h.role = "owner";
  h.accountId = "acct-1";
  h.createResult = "ok";
  h.createdWith = null;
  h.deletedUsers = [];
  h.freshProfile = { account_id: "orphan-acct" };
  h.remainingInOrphan = [];
  h.profileWrites = [];
  h.deletedAccounts = [];
  h.failProfileMove = false;
});

describe("POST /api/account/members (owner creates user)", () => {
  it("1. owner creates a confirmed user and moves membership", async () => {
    const res = await post({
      name: "Vikas Sahni",
      email: "  Vikas@Example.COM ",
      password: "secret123",
      role: "agent",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      member: { user_id: string; email: string; role: string; full_name: string };
    };
    expect(json.member.user_id).toBe("new-user-1");
    expect(json.member.email).toBe("vikas@example.com");
    expect(json.member.role).toBe("agent");
    expect(json.member.full_name).toBe("Vikas Sahni");
    // Immediately confirmed — no verification step.
    expect(h.createdWith).toMatchObject({
      email: "vikas@example.com",
      email_confirm: true,
    });
    // Profile moved into the owner's account with the role...
    expect(h.profileWrites).toContainEqual({
      op: "update",
      row: { account_id: "acct-1", account_role: "agent", full_name: "Vikas Sahni" },
    });
    // ...and the orphan personal account removed.
    expect(h.deletedAccounts).toEqual(["orphan-acct"]);
    // Never leaks the password back.
    expect(JSON.stringify(json)).not.toContain("secret123");
  });

  it("name is required (missing, empty, and whitespace-only rejected)", async () => {
    for (const name of [undefined, "", "   "]) {
      const res = await post({ name, email: "a@x.com", password: "secret123", role: "agent" });
      expect(res.status).toBe(400);
    }
    expect(h.createdWith).toBeNull();
  });

  it("name over 80 characters is rejected, never truncated", async () => {
    const res = await post({
      name: "V".repeat(81),
      email: "a@x.com",
      password: "secret123",
      role: "agent",
    });
    expect(res.status).toBe(400);
    expect(h.createdWith).toBeNull();
  });

  it("name is trimmed and lands on the profile", async () => {
    const res = await post({
      name: "  Vikas Sahni  ",
      email: "a@x.com",
      password: "secret123",
      role: "agent",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      member: { full_name: string };
    };
    expect(json.member.full_name).toBe("Vikas Sahni");
    expect(h.createdWith).toMatchObject({
      user_metadata: { full_name: "Vikas Sahni" },
    });
    expect(h.profileWrites).toContainEqual({
      op: "update",
      row: { account_id: "acct-1", account_role: "agent", full_name: "Vikas Sahni" },
    });
  });

  it("fallback profile insert also carries the name", async () => {
    h.freshProfile = null;
    const res = await post({
      name: "Vikas Sahni",
      email: "a@x.com",
      password: "secret123",
      role: "agent",
    });
    expect(res.status).toBe(201);
    expect(h.profileWrites).toContainEqual({
      op: "insert",
      row: {
        user_id: "new-user-1",
        full_name: "Vikas Sahni",
        email: "a@x.com",
        account_id: "acct-1",
        account_role: "agent",
      },
    });
  });

  it("2. non-owner (admin) is forbidden", async () => {
    h.role = "admin";
    const res = await post({ email: "a@x.com", password: "secret123", role: "agent" });
    expect(res.status).toBe(403);
    expect(h.createdWith).toBeNull();
  });

  it("3. invalid email is rejected", async () => {
    for (const email of ["", "not-an-email", "a@b", "@x.com"]) {
      const res = await post({ email, password: "secret123", role: "agent" });
      expect(res.status).toBe(400);
    }
    expect(h.createdWith).toBeNull();
  });

  it("4. missing/short password is rejected", async () => {
    for (const password of [undefined, "", "12345"]) {
      const res = await post({ email: "a@x.com", password, role: "agent" });
      expect(res.status).toBe(400);
    }
    expect(h.createdWith).toBeNull();
  });

  it("5/14. non-agent and invalid roles are rejected (always-agent creation)", async () => {
    for (const role of ["owner", "admin", "viewer", "superadmin", ""]) {
      const res = await post({ email: "a@x.com", password: "secret123", role });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("New users are always created as agents.");
    }
    expect(h.createdWith).toBeNull();
    expect(h.profileWrites).toEqual([]);
  });

  it("crafted admin/viewer requests create nothing", async () => {
    for (const role of ["admin", "viewer"]) {
      h.createdWith = null;
      const res = await post({ email: "a@x.com", password: "secret123", role });
      expect(res.status).toBe(400);
    }
    expect(h.createdWith).toBeNull();
    expect(h.profileWrites).toEqual([]);
    expect(h.deletedUsers).toEqual([]);
  });

  it("omitted role still creates an agent", async () => {
    const res = await POST(
      new Request("https://app.test/api/account/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Vikas Sahni", email: "a@x.com", password: "secret123" }),
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { member: { role: string } };
    expect(json.member.role).toBe("agent");
  });

  it("6/7/8/15. duplicate email fails cleanly with existing user untouched", async () => {
    h.createResult = "duplicate";
    const res = await post({ email: "taken@example.com", password: "secret123", role: "agent" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("A user with this email already exists.");
    // A second attempt at the same email fails identically (race-safe).
    const res2 = await post({ email: "taken@example.com", password: "secret123", role: "agent" });
    expect(res2.status).toBe(409);
    // Existing user untouched: no profile writes, no deletions, no role/account moves.
    expect(h.profileWrites).toEqual([]);
    expect(h.deletedUsers).toEqual([]);
    expect(h.deletedAccounts).toEqual([]);
  });

  it("11/12. membership and role land in the caller's account, always as agent", async () => {
    await post({ email: "a@x.com", password: "secret123", role: "agent" });
    expect(h.profileWrites).toContainEqual({
      op: "update",
      row: { account_id: "acct-1", account_role: "agent", full_name: "Vikas Sahni" },
    });
  });

  it("13. client-supplied account_id is ignored", async () => {
    const res = await post({
      email: "a@x.com",
      password: "secret123",
      role: "agent",
      account_id: "acct-evil",
      owner_id: "someone-else",
    });
    expect(res.status).toBe(201);
    // Membership still lands in the session account.
    expect(h.profileWrites).toContainEqual({
      op: "update",
      row: { account_id: "acct-1", account_role: "agent", full_name: "Vikas Sahni" },
    });
  });

  it("16. profile failure rolls back only the new Auth user", async () => {
    h.failProfileMove = true;
    const res = await post({ email: "a@x.com", password: "secret123", role: "agent" });
    expect(res.status).toBe(500);
    expect(h.deletedUsers).toEqual(["new-user-1"]);
  });

  it("inserts a profile directly when the trigger row is missing", async () => {
    h.freshProfile = null;
    const res = await post({ email: "a@x.com", password: "secret123", role: "agent" });
    expect(res.status).toBe(201);
    expect(h.profileWrites).toContainEqual({
      op: "insert",
      row: {
        user_id: "new-user-1",
        full_name: "Vikas Sahni",
        email: "a@x.com",
        account_id: "acct-1",
        account_role: "agent",
      },
    });
    expect(h.deletedAccounts).toEqual([]);
  });

  it("keeps the orphan account when it still has members", async () => {
    h.remainingInOrphan = [{ user_id: "someone-else" }];
    const res = await post({ email: "a@x.com", password: "secret123", role: "agent" });
    expect(res.status).toBe(201);
    expect(h.deletedAccounts).toEqual([]);
  });
});
