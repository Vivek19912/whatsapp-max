// ============================================================
// requireDeviceUser revocation gate (migration 151).
//
// A row is revoked iff revoked_session_id equals its
// session_id. The gate denies:
//   - any bearer carrying a revoked session, even WITHOUT the
//     device header (bypass-proof), and
//   - a legacy token (no session claim) whose device header
//     matches a currently-revoked row.
// Fail-closed: a missing table (pre-migration rollout) or any
// read error denies with 503 `unavailable` — never fail-open.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const SID_A = "11111111-2222-4333-8444-555555555555";
const SID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const h = vi.hoisted(() => ({
  userId: "user-agent-1" as string | null,
  profile: {
    account_id: "acct-A",
    account_role: "agent",
    full_name: "Agent",
  } as Record<string, unknown> | null,
  devices: [] as Array<Record<string, unknown>>,
  devicesError: null as { code?: string; message: string } | null,
}));

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jwtWithSession(sid: string): string {
  return `eyJhbGciOiJIUzI1NiJ9.${b64url({ sub: h.userId, session_id: sid })}.sig`;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => {
        if (!h.userId) {
          return { data: { user: null }, error: { message: "invalid" } };
        }
        return { data: { user: { id: h.userId } }, error: null };
      },
    },
  }),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "callvault_devices") {
        if (h.devicesError) throw h.devicesError;
        const listQuery: Record<string, unknown> = {};
        listQuery.select = () => listQuery;
        listQuery.eq = () => listQuery;
        listQuery.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: h.devices, error: null }).then(resolve);
        const updateQuery: Record<string, unknown> = {};
        updateQuery.eq = () => updateQuery;
        updateQuery.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve);
        return {
          select: () => listQuery,
          update: () => updateQuery,
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: h.profile, error: null }),
          }),
        }),
      };
    },
  }),
}));

const { requireDeviceUser } = await import("./device");

function req(token: string, deviceId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (deviceId) headers["x-callvault-device-id"] = deviceId;
  return new Request("https://app.test/api/v1/recordings", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  h.userId = "user-agent-1";
  h.profile = { account_id: "acct-A", account_role: "agent", full_name: "Agent" };
  h.devices = [];
  h.devicesError = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-fixture";
  vi.restoreAllMocks();
});

describe("requireDeviceUser CallVault revocation gate", () => {
  it("denies a revoked session_id even WITHOUT the device header (bypass-proof)", async () => {
    h.devices = [
      { device_id: "phone-1", session_id: SID_A, revoked_session_id: SID_A },
    ];
    const err = await requireDeviceUser(req(jwtWithSession(SID_A))).catch(
      (e) => e,
    );
    expect(err.status).toBe(401);
  });

  it("allows a different (non-revoked) session on the same user", async () => {
    h.devices = [
      { device_id: "phone-1", session_id: SID_A, revoked_session_id: SID_A },
    ];
    const ctx = await requireDeviceUser(req(jwtWithSession(SID_B), "phone-1"));
    expect(ctx.userId).toBe("user-agent-1");
    expect(ctx.sessionId).toBe(SID_B);
    expect(ctx.deviceId).toBe("phone-1");
  });

  it("denies a legacy token (no session claim) whose device header matches a revoked row", async () => {
    h.devices = [
      { device_id: "phone-1", session_id: SID_A, revoked_session_id: SID_A },
    ];
    const err = await requireDeviceUser(req("opaque-legacy-token", "phone-1")).catch(
      (e) => e,
    );
    expect(err.status).toBe(401);
  });

  it("503s (fail-closed) when the table is missing — never fail-open", async () => {
    h.devicesError = { code: "42P01", message: 'relation "callvault_devices" does not exist' };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = await requireDeviceUser(req(jwtWithSession(SID_A), "phone-1")).catch(
      (e) => e,
    );
    expect(err.status).toBe(503);
    expect(err.code).toBe("unavailable");
    expect(warn).toHaveBeenCalled();
  });

  it("503s (fail-closed) on any registry read error — revoked sessions stay denied", async () => {
    h.devicesError = { message: "connection reset" };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = await requireDeviceUser(req(jwtWithSession(SID_A), "phone-1")).catch(
      (e) => e,
    );
    expect(err.status).toBe(503);
    expect(err.code).toBe("unavailable");
  });

  it("attaches deviceId + sessionId to the context", async () => {
    const ctx = await requireDeviceUser(req(jwtWithSession(SID_A), "phone-1"));
    expect(ctx.deviceId).toBe("phone-1");
    expect(ctx.sessionId).toBe(SID_A);
  });
});
