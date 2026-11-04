// ============================================================
// POST /api/auth/callvault-devices/register — upsert guarded by
// JWT session equality; banned sessions stay banned.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER_SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const h = vi.hoisted(() => ({
  // JWT session carried by the mocked device context.
  // (Literal: hoisted factories cannot reference outer consts.)
  jwtSession: "11111111-2222-4333-8444-555555555555" as string | null,
  // Existing device row (null = first registration).
  existing: null as { session_id: string | null; revoked_session_id: string | null } | null,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/device", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/auth/device")>();
  const { unauthorized } = await import("@/lib/api/v1/respond");
  return {
    ...orig,
    requireDeviceUser: async () => {
      if (!h.jwtSession) throw unauthorized("Invalid or expired session");
      return {
        authType: "user",
        supabase: {},
        service: {},
        userId: "user-agent-1",
        accountId: "acct-A",
        role: "agent",
        fullName: "Agent",
        email: null,
        deviceId: "phone-1",
        sessionId: h.jwtSession,
      };
    },
  };
});

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== "callvault_devices") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: h.existing, error: null }),
            }),
          }),
        }),
        upsert: async (patch: Record<string, unknown>) => {
          h.upserts.push(patch);
          return { data: null, error: null };
        },
      };
    },
  }),
}));

const { POST } = await import("./route");

function req(body: unknown) {
  return new Request("https://app.test/api/auth/callvault-devices/register", {
    method: "POST",
    headers: { Authorization: "Bearer header.payload.sig" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.jwtSession = SID;
  h.existing = null;
  h.upserts = [];
});

describe("POST /api/auth/callvault-devices/register", () => {
  it("upserts the caller's own (account, device) with server-derived identity", async () => {
    const res = await POST(
      req({ device_id: "phone-1", session_id: SID, device_name: "Pixel", app_version: "1.2.3" }),
    );
    expect(res.status).toBe(200);
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({
      account_id: "acct-A",
      user_id: "user-agent-1",
      device_id: "phone-1",
      session_id: SID,
      device_name: "Pixel",
      app_version: "1.2.3",
    });
    // Never accepts identity from the client.
    expect(h.upserts[0]).not.toHaveProperty("account_id_from_client");
    const json = (await res.json()) as Record<string, string>;
    expect(json.device_id).toBe("phone-1");
  });

  it("403s when session_id does not equal the JWT session", async () => {
    const res = await POST(req({ device_id: "phone-1", session_id: OTHER_SID }));
    expect(res.status).toBe(403);
    expect(h.upserts).toHaveLength(0);
  });

  it("403s device_revoked when the banned session re-registers", async () => {
    h.existing = { session_id: SID, revoked_session_id: SID };
    const res = await POST(req({ device_id: "phone-1", session_id: SID }));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("device_revoked");
    expect(h.upserts).toHaveLength(0);
  });

  it("a fresh session heals a revoked row (revocation cleared)", async () => {
    h.existing = { session_id: OTHER_SID, revoked_session_id: OTHER_SID };
    h.jwtSession = SID;
    const res = await POST(req({ device_id: "phone-1", session_id: SID }));
    expect(res.status).toBe(200);
    expect(h.upserts[0]).toMatchObject({
      session_id: SID,
      revoked_session_id: null,
      revoked_at: null,
      revoked_by: null,
    });
  });

  it("400s on missing device_id and malformed session_id", async () => {
    expect((await POST(req({ session_id: SID }))).status).toBe(400);
    expect((await POST(req({ device_id: "phone-1", session_id: "nope" }))).status).toBe(
      400,
    );
  });
});
