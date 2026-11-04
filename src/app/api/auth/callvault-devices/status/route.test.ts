// ============================================================
// GET /api/auth/callvault-devices/status — own-row revocation
// readout; чужой (foreign) devices 404.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const SID = "11111111-2222-4333-8444-555555555555";

const h = vi.hoisted(() => ({
  row: null as { session_id: string | null; revoked_session_id: string | null } | null,
  lastEq: [] as Array<{ column: string; value: unknown }>,
}));

vi.mock("@/lib/auth/device", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/auth/device")>();
  return {
    ...orig,
    requireDeviceUser: async () => ({
      authType: "user",
      supabase: {},
      service: {
        from: (table: string) => {
          if (table !== "callvault_devices") throw new Error(`unexpected table ${table}`);
          const q: Record<string, unknown> = {};
          q.select = () => q;
          q.eq = (column: string, value: unknown) => {
            h.lastEq.push({ column, value });
            return q;
          };
          q.maybeSingle = async () => ({ data: h.row, error: null });
          return q;
        },
      },
      userId: "user-agent-1",
      accountId: "acct-A",
      role: "agent",
      fullName: "Agent",
      email: null,
      deviceId: "phone-1",
      sessionId: SID,
    }),
  };
});

const { GET } = await import("./route");

function req(deviceId?: string) {
  const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  return new Request(`https://app.test/api/auth/callvault-devices/status${qs}`, {
    headers: { Authorization: "Bearer header.payload.sig" },
  });
}

beforeEach(() => {
  h.row = null;
  h.lastEq = [];
});

describe("GET /api/auth/callvault-devices/status", () => {
  it("returns revoked:false for an active row", async () => {
    h.row = { session_id: SID, revoked_session_id: null };
    const res = await GET(req("phone-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
    // Scoped to the token identity (account + user + device).
    expect(h.lastEq).toContainEqual({ column: "account_id", value: "acct-A" });
    expect(h.lastEq).toContainEqual({ column: "user_id", value: "user-agent-1" });
    expect(h.lastEq).toContainEqual({ column: "device_id", value: "phone-1" });
  });

  it("returns revoked:true for a logged-out row", async () => {
    h.row = { session_id: SID, revoked_session_id: SID };
    const res = await GET(req("phone-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
  });

  it("404s for someone else's device (no row for this identity)", async () => {
    h.row = null;
    const res = await GET(req("someone-elses-phone"));
    expect(res.status).toBe(404);
  });
});
