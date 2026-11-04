// ============================================================
// POST /api/auth/callvault-devices/ack — revoked sessions ack
// over identity auth (never the revocation gate); only the
// bearer carrying the revoked session may ack it.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER_SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const h = vi.hoisted(() => ({
  row: null as { device_id: string; revoked_session_id: string | null } | null,
  rowError: null as { message: string } | null,
  updates: [] as Array<{ patch: Record<string, unknown>; device_id: string }>,
  identityError: false,
  tokenSession: "11111111-2222-4333-8444-555555555555" as string | null,
}));

function serviceStub() {
  return {
    from: (table: string) => {
      if (table !== "callvault_devices") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: h.rowError ? null : h.row,
                  error: h.rowError,
                }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            eq: () => ({
              eq: (_column: string, value: unknown) => {
                h.updates.push({ patch, device_id: String(value) });
                return Promise.resolve({ data: null, error: null });
              },
            }),
          }),
        }),
      };
    },
  };
}

vi.mock("@/lib/auth/callvault-session", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/auth/callvault-session")>();
  return { ...orig, sessionIdFromJwt: () => h.tokenSession };
});

vi.mock("@/lib/auth/device", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/auth/device")>();
  const { unauthorized } = await import("@/lib/api/v1/respond");
  return {
    ...orig,
    requireDeviceIdentity: async () => {
      if (h.identityError) throw unauthorized("Invalid or expired session");
      return {
        userClient: {},
        service: serviceStub(),
        userId: "user-agent-1",
        accountId: "acct-A",
        role: "agent",
        fullName: "Agent",
        email: null,
        token: "header.payload.sig",
      };
    },
  };
});

const { POST } = await import("./route");

function req(body: unknown) {
  return new Request("https://app.test/api/auth/callvault-devices/ack", {
    method: "POST",
    headers: {
      Authorization: "Bearer header.payload.sig",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.row = null;
  h.rowError = null;
  h.updates = [];
  h.identityError = false;
  h.tokenSession = SID;
});

describe("POST /api/auth/callvault-devices/ack", () => {
  it("acks when the token session equals the row's revoked session", async () => {
    h.row = { device_id: "phone-1", revoked_session_id: SID };
    const res = await POST(req({ device_id: "phone-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acked: true });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.device_id).toBe("phone-1");
    expect(h.updates[0]!.patch.logout_ack_at).toBeTruthy();
  });

  it("404s for no row (no existence oracle beyond the 404)", async () => {
    h.row = null;
    const res = await POST(req({ device_id: "ghost-phone" }));
    expect(res.status).toBe(404);
    expect(h.updates).toHaveLength(0);
  });

  it("403s when the token session is not the revoked one", async () => {
    h.row = { device_id: "phone-1", revoked_session_id: OTHER_SID };
    const res = await POST(req({ device_id: "phone-1" }));
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it("403s when the row is not revoked at all", async () => {
    h.row = { device_id: "phone-1", revoked_session_id: null };
    const res = await POST(req({ device_id: "phone-1" }));
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it("403s for legacy tokens with no session claim (never ack)", async () => {
    h.row = { device_id: "phone-1", revoked_session_id: SID };
    h.tokenSession = null;
    const res = await POST(req({ device_id: "phone-1" }));
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it("400s on a missing device_id and 401s without identity", async () => {
    h.row = { device_id: "phone-1", revoked_session_id: SID };
    expect((await POST(req({}))).status).toBe(400);
    h.identityError = true;
    expect((await POST(req({ device_id: "phone-1" }))).status).toBe(401);
    expect(h.updates).toHaveLength(0);
  });

  it("503s when the registry read fails", async () => {
    h.rowError = { message: "connection reset" };
    const res = await POST(req({ device_id: "phone-1" }));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("unavailable");
  });
});
