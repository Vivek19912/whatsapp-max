import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner" as string | null,
  accountId: "acct-1",
  userId: "owner-1",
  profiles: [] as Array<{ user_id: string; account_id: string }>,
  settings: [] as Array<{
    user_id: string;
    account_id: string;
    whatsapp_recording_source: string;
    phone_recording_source: string;
    phone_recording_number: string | null;
    updated_at: string;
  }>,
  writes: [] as Array<Record<string, unknown>>,
}));

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              eq: (_col2: string, val2: unknown) => ({
                maybeSingle: async () => ({
                  data:
                    h.profiles.find(
                      (p) => p.user_id === val && p.account_id === val2,
                    ) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "user_recording_settings") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data:
                    h.settings.find((s) => s.account_id === h.accountId) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
          upsert: (row: Record<string, unknown>) => {
            h.writes.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: {
                    user_id: row.user_id,
                    whatsapp_recording_source:
                      row.whatsapp_recording_source ?? "none",
                    phone_recording_source: row.phone_recording_source ?? "none",
                    phone_recording_number:
                      (row.phone_recording_number as string | null | undefined) ??
                      null,
                    phone_recording_enabled:
                      (row.phone_recording_enabled as boolean | undefined) ??
                      false,
                    updated_at: "2026-10-07T00:00:00.000Z",
                  },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: h.userId,
    role: h.role,
    account: { id: h.accountId, name: "Acme" },
  }),
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

const { GET, PUT, normalizeRecordingPhoneNumber } = await import("./route");

function url(userId: string) {
  return `https://app.test/api/account/recording-settings/${userId}`;
}

function put(userId: string, body: unknown) {
  return PUT(
    new Request(url(userId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) },
  );
}

function get(userId: string) {
  return GET(new Request(url(userId)), {
    params: Promise.resolve({ userId }),
  });
}

beforeEach(() => {
  h.role = "owner";
  h.accountId = "acct-1";
  h.userId = "owner-1";
  h.profiles = [
    { user_id: "owner-1", account_id: "acct-1" },
    { user_id: "agent-1", account_id: "acct-1" },
  ];
  h.settings = [];
  h.writes = [];
});

describe("recording-settings phone number", () => {
  it("1. owner sets no phone number (null) → stored null", async () => {
    const res = await put("agent-1", { phone_recording_number: null });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.setting.phone_recording_number).toBeNull();
  });

  it("2/4. owner sets valid number → normalized digits stored", async () => {
    const res = await put("agent-1", { phone_recording_number: "+91 89530 65369" });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.setting.phone_recording_number).toBe("918953065369");
    expect(h.writes[0].phone_recording_number).toBe("918953065369");
  });

  it("3. invalid number rejected with 400", async () => {
    for (const bad of ["abc", "123", "+"] ) {
      const res = await put("agent-1", { phone_recording_number: bad });
      expect(res.status).toBe(400);
    }
    expect(h.writes).toHaveLength(0);
  });

  it("empty string clears to null", async () => {
    const res = await put("agent-1", { phone_recording_number: "" });
    expect(res.status).toBe(200);
    expect((await res.json()).setting.phone_recording_number).toBeNull();
  });

  it("8. GET exposes phone_recording_number", async () => {
    h.settings = [
      {
        user_id: "agent-1",
        account_id: "acct-1",
        whatsapp_recording_source: "whatsapp",
        phone_recording_source: "none",
        phone_recording_number: "917460939319",
        updated_at: "2026-10-07T00:00:00.000Z",
      },
    ];
    const res = await get("agent-1");
    const payload = await res.json();
    expect(payload.setting.phone_recording_number).toBe("917460939319");
  });

  it("legacy sim1/sim2 still accepted (older CallVault clients)", async () => {
    const res = await put("agent-1", { phone_recording_source: "sim1" });
    expect(res.status).toBe(200);
    expect((await res.json()).setting.phone_recording_source).toBe("sim1");
  });

  it("pure helper: normalization matrix", () => {
    expect(normalizeRecordingPhoneNumber("+91 89530 65369")).toBe("918953065369");
    expect(normalizeRecordingPhoneNumber("+1 (202) 555-0173")).toBe("12025550173");
    expect(normalizeRecordingPhoneNumber(null)).toBeNull();
    expect(normalizeRecordingPhoneNumber("")).toBeNull();
    expect(normalizeRecordingPhoneNumber("abc")).toBeNull();
    expect(normalizeRecordingPhoneNumber("123")).toBeNull();
  });

  it("saving a number derives phone_recording_enabled=true; clearing derives false", async () => {
    const set = await put("agent-1", { phone_recording_number: "+91 74609 39319" });
    expect(set.status).toBe(200);
    expect((await set.json()).setting.phone_recording_enabled).toBe(true);
    expect(h.writes[0].phone_recording_enabled).toBe(true);
    const clear = await put("agent-1", { phone_recording_number: null });
    expect(clear.status).toBe(200);
    expect((await clear.json()).setting.phone_recording_enabled).toBe(false);
  });
});
