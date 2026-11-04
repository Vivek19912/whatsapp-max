// ============================================================
// POST /api/callvault/devices/revoke + revoke-all — owner-only
// session-scoped logout with audit; other devices untouched.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SID_1 = "11111111-2222-4333-8444-555555555555";
const SID_2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  accountId: "acct-A",
  member: { user_id: "agent-1" } as { user_id: string } | null,
  devices: [] as Array<{ device_id: string; session_id: string | null }>,
  updates: [] as Array<{ patch: Record<string, unknown>; device_id: string }>,
  audits: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.role) throw statusError(401, "Unauthorized");
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

function devicesTable() {
  // List query: .select().eq().eq() awaits to all rows.
  // Single-row query: .select().eq().eq().eq(device_id) → maybeSingle().
  const afterSecondEq: Record<string, unknown> = {};
  afterSecondEq.eq = (_column: string, value: unknown) => ({
    maybeSingle: async () => {
      const row = h.devices.find((d) => d.device_id === value) ?? null;
      return { data: row, error: null };
    },
  });
  afterSecondEq.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: h.devices, error: null }).then(resolve);
  return {
    select: () => ({
      eq: () => ({
        eq: () => afterSecondEq,
      }),
    }),
    update: (patch: Record<string, unknown>) => ({
      eq: () => ({
        eq: () => ({
          eq: (column: string, value: unknown) => {
            if (column === "device_id") {
              h.updates.push({ patch, device_id: String(value) });
            }
            return Promise.resolve({ data: null, error: null });
          },
        }),
      }),
    }),
  };
}

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: h.member, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "callvault_devices") return devicesTable();
      if (table === "callvault_device_audit") {
        return {
          insert: async (row: Record<string, unknown>) => {
            h.audits.push(row);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { POST: revokeOne } = await import("./revoke/route");
const { POST: revokeAll } = await import("./revoke-all/route");

function req(path: string, body: unknown) {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.role = "owner";
  h.accountId = "acct-A";
  h.member = { user_id: "agent-1" };
  h.devices = [
    { device_id: "phone-1", session_id: SID_1 },
    { device_id: "phone-2", session_id: SID_2 },
  ];
  h.updates = [];
  h.audits = [];
  delete process.env.DIAL_WS_INTERNAL_SECRET;
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete process.env.DIAL_WS_INTERNAL_SECRET;
  vi.unstubAllGlobals();
});

describe("POST /api/callvault/devices/revoke", () => {
  it("revokes one device (current session banned), audits, other device untouched", async () => {
    const res = await revokeOne(
      req("/api/callvault/devices/revoke", { user_id: "agent-1", device_id: "phone-1" }),
    );
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      device_id: "phone-1",
      patch: { revoked_session_id: SID_1, revoked_by: "owner-1" },
    });
    expect(h.updates[0].patch.revoked_at).toBeTruthy();
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      account_id: "acct-A",
      owner_user_id: "owner-1",
      target_user_id: "agent-1",
      device_id: "phone-1",
      revoked_session_id: SID_1,
      action: "revoke_device",
    });
  });

  it("403s for non-owners and 404s for unknown rows / cross-account targets", async () => {
    h.role = "agent";
    expect(
      (
        await revokeOne(
          req("/api/callvault/devices/revoke", { user_id: "agent-1", device_id: "phone-1" }),
        )
      ).status,
    ).toBe(403);
    h.role = "owner";
    expect(
      (
        await revokeOne(
          req("/api/callvault/devices/revoke", { user_id: "agent-1", device_id: "nope" }),
        )
      ).status,
    ).toBe(404);
    h.member = null;
    expect(
      (
        await revokeOne(
          req("/api/callvault/devices/revoke", { user_id: "user-other", device_id: "phone-1" }),
        )
      ).status,
    ).toBe(404);
    expect(h.audits).toHaveLength(0);
  });
});

describe("POST /api/callvault/devices/revoke-all", () => {
  it("revokes every row of the agent with a single null-device audit row", async () => {
    const res = await revokeAll(
      req("/api/callvault/devices/revoke-all", { user_id: "agent-1" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { revoked: number };
    expect(json.revoked).toBe(2);
    expect(h.updates.map((u) => u.device_id).sort()).toEqual(["phone-1", "phone-2"]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      target_user_id: "agent-1",
      device_id: null,
      action: "revoke_all",
    });
  });

  it("403s for non-owners", async () => {
    h.role = "viewer";
    const res = await revokeAll(
      req("/api/callvault/devices/revoke-all", { user_id: "agent-1" }),
    );
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });
});

describe("revoke logout push (best-effort, never fails the revocation)", () => {
  it("notifies the sidecar after a single revoke and still 200s when the sidecar is down", async () => {
    process.env.DIAL_WS_INTERNAL_SECRET = "test-secret";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response('{"delivered":true}', { status: 200 });
      }),
    );
    const res = await revokeOne(
      req("/api/callvault/devices/revoke", { user_id: "agent-1", device_id: "phone-1" }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3001/internal/logout-device");
    expect(JSON.parse(String((calls[0]!.init as RequestInit).body))).toEqual({
      account_id: "acct-A",
      user_id: "agent-1",
      device_id: "phone-1",
      session_id: SID_1,
    });

    // Sidecar unreachable: the revocation still succeeds.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unreachable");
      }),
    );
    const res2 = await revokeOne(
      req("/api/callvault/devices/revoke", { user_id: "agent-1", device_id: "phone-2" }),
    );
    expect(res2.status).toBe(200);
  });

  it("notifies once per device on revoke-all, failures swallowed", async () => {
    process.env.DIAL_WS_INTERNAL_SECRET = "test-secret";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response('{"delivered":true}', { status: 200 });
      }),
    );
    const res = await revokeAll(
      req("/api/callvault/devices/revoke-all", { user_id: "agent-1" }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const bodies = calls.map((c) => JSON.parse(String((c.init as RequestInit).body)));
    expect(bodies).toContainEqual({
      account_id: "acct-A",
      user_id: "agent-1",
      device_id: "phone-1",
      session_id: SID_1,
    });
    expect(bodies).toContainEqual({
      account_id: "acct-A",
      user_id: "agent-1",
      device_id: "phone-2",
      session_id: SID_2,
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const res2 = await revokeAll(
      req("/api/callvault/devices/revoke-all", { user_id: "agent-1" }),
    );
    expect(res2.status).toBe(200);
  });
});
