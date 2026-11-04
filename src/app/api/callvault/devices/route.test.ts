// ============================================================
// GET /api/callvault/devices — owner-only list; agents/admins/
// viewers 403; cross-account targets 404.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  accountId: "acct-A",
  member: { user_id: "agent-1" } as { user_id: string } | null,
  devices: [] as Array<Record<string, unknown>>,
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
      if (table === "callvault_devices") {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.order = async () => ({ data: h.devices, error: null });
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { GET } = await import("./route");

function req(userId?: string) {
  const qs = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
  return new Request(`https://app.test/api/callvault/devices${qs}`);
}

beforeEach(() => {
  h.role = "owner";
  h.accountId = "acct-A";
  h.member = { user_id: "agent-1" };
  h.devices = [];
});

describe("GET /api/callvault/devices", () => {
  it("lists devices with active/pending/logged_out status + session_expires_at = created_at + 60d", async () => {
    // Relative dates: presence computes against server now, so
    // fixtures must stay fresh regardless of when the suite runs.
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    h.devices = [
      {
        device_id: "phone-1",
        device_name: "Pixel",
        device_model: "Pixel 8",
        app_version: "1.2.3",
        session_id: "11111111-2222-4333-8444-555555555555",
        revoked_session_id: null,
        revoked_at: null,
        logout_ack_at: null,
        last_seen_at: iso(now - 10_000),
        created_at: iso(now - 24 * 60 * 60 * 1000),
      },
      {
        device_id: "phone-2",
        device_name: null,
        device_model: null,
        app_version: null,
        session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        revoked_session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        revoked_at: iso(now - 60_000),
        logout_ack_at: null,
        last_seen_at: null,
        created_at: iso(now - 24 * 60 * 60 * 1000),
      },
      {
        device_id: "phone-3",
        device_name: null,
        device_model: null,
        app_version: null,
        session_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        revoked_session_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        revoked_at: iso(now - 60_000),
        logout_ack_at: iso(now - 30_000),
        last_seen_at: iso(now - 30_000),
        created_at: iso(now - 24 * 60 * 60 * 1000),
      },
    ];
    const res = await GET(req("agent-1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(json.devices).toHaveLength(3);
    expect(json.devices[0]).toMatchObject({
      device_id: "phone-1",
      status: "active",
    });
    // No presence tracking: the response carries no presence,
    // disconnected_since, or history fields.
    expect(json.devices[0]).not.toHaveProperty("presence");
    expect(json.devices[0]).not.toHaveProperty("disconnected_since");
    expect(json).not.toHaveProperty("history");
    // 1-day-old session: expires_at = created_at + 60d.
    expect(json.devices[0].session_expires_at).toBe(
      new Date(Date.parse(json.devices[0].created_at as string) + 60 * 24 * 60 * 60 * 1000).toISOString(),
    );
    // Revoked but unacked reads pending; acked reads logged_out.
    expect(json.devices[1]).toMatchObject({
      device_id: "phone-2",
      status: "pending",
      logout_ack_at: null,
    });
    expect(json.devices[2]).toMatchObject({
      device_id: "phone-3",
      status: "logged_out",
    });
    expect(json.devices[0]).toHaveProperty("last_seen_at");
  });

  it("keeps stale devices active (no presence tracking, no events table reads)", async () => {
    // A device unseen for hours is still just active: presence
    // monitoring was removed, and the route must never touch
    // callvault_device_events (the mock throws on that table).
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    h.devices = [
      {
        device_id: "phone-1",
        device_name: "Pixel",
        device_model: null,
        app_version: null,
        session_id: "11111111-2222-4333-8444-555555555555",
        revoked_session_id: null,
        revoked_at: null,
        logout_ack_at: null,
        last_seen_at: iso(now - 10 * 60 * 1000),
        created_at: iso(now - 24 * 60 * 60 * 1000),
      },
      {
        device_id: "phone-old",
        device_name: null,
        device_model: null,
        app_version: null,
        session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        revoked_session_id: null,
        revoked_at: null,
        logout_ack_at: null,
        last_seen_at: iso(now - 10 * 60 * 1000),
        created_at: iso(now - 61 * 24 * 60 * 60 * 1000),
      },
    ];
    const res = await GET(req("agent-1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(json.devices[0]).toMatchObject({
      device_id: "phone-1",
      status: "active",
    });
    // Even a 61-day-old session: no presence field, no expiry
    // badge state — expiry display is just the date string.
    expect(json.devices[1]).toMatchObject({
      device_id: "phone-old",
      status: "active",
    });
    expect(json.devices[1]).not.toHaveProperty("presence");
  });

  it("reads a stale ack on a healed row as active (ack requires revocation)", async () => {
    h.devices = [
      {
        device_id: "phone-1",
        device_name: null,
        device_model: null,
        app_version: null,
        session_id: "11111111-2222-4333-8444-555555555555",
        revoked_session_id: null,
        revoked_at: null,
        logout_ack_at: "2026-11-02T01:00:00.000Z",
        last_seen_at: null,
        created_at: "2026-10-01T00:00:00.000Z",
      },
    ];
    const res = await GET(req("agent-1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { devices: Array<Record<string, unknown>> };
    expect(json.devices[0]).toMatchObject({ device_id: "phone-1", status: "active" });
  });

  it("403s for agent, admin, and viewer callers", async () => {    for (const role of ["agent", "admin", "viewer"]) {
      h.role = role;
      const res = await GET(req("agent-1"));
      expect(res.status).toBe(403);
    }
  });

  it("404s for a cross-account target (no existence leak)", async () => {
    h.member = null;
    const res = await GET(req("user-other-account"));
    expect(res.status).toBe(404);
  });
});
