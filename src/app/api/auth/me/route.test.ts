import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  deviceOk: true as boolean,
  account: { id: "acct-A", name: "Acme" } as Record<string, unknown> | null,
  setting: null as { whatsapp_recording_source: string } | null,
}));

vi.mock("@/lib/auth/device", () => ({
  requireDeviceUser: async () => {
    if (!h.deviceOk) {
      const { unauthorized } = await import("@/lib/api/v1/respond");
      throw unauthorized("Invalid or expired session");
    }
    return {
      authType: "user",
      supabase: {},
      service: {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data:
                    table === "user_recording_settings" ? h.setting : h.account,
                  error: null,
                }),
              }),
              maybeSingle: async () => ({
                data:
                  table === "user_recording_settings" ? h.setting : h.account,
                error: null,
              }),
            }),
          }),
        }),
      },
      userId: "user-sagar",
      accountId: "acct-A",
      role: "agent",
      fullName: "Sagar",
      email: "sagar@example.com",
    };
  },
}));

const { GET } = await import("./route");

describe("GET /api/auth/me", () => {
  it("returns the authenticated user, account, and role", async () => {
    const res = await GET(
      new Request("https://app.test/api/auth/me", {
        headers: { Authorization: "Bearer header.payload.sig" },
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      user: { id: string; email: string; fullName: string };
      account: { id: string; name: string };
      role: string;
    };
    expect(json.user).toEqual({ id: "user-sagar", email: "sagar@example.com", fullName: "Sagar" });
    expect(json.account).toEqual({ id: "acct-A", name: "Acme" });
    expect(json.role).toBe("agent");
  });

  it("defaults both recording sources to none when unset", async () => {
    h.setting = null;
    const res = await GET(
      new Request("https://app.test/api/auth/me", {
        headers: { Authorization: "Bearer header.payload.sig" },
      })
    );
    const json = (await res.json()) as {
      whatsappRecordingSource: string;
      phoneRecordingSource: string;
    };
    expect(json.whatsappRecordingSource).toBe("none");
    expect(json.phoneRecordingSource).toBe("none");
  });

  it("returns the stored recording sources", async () => {
    h.setting = { whatsapp_recording_source: "whatsapp_business" };
    const res = await GET(
      new Request("https://app.test/api/auth/me", {
        headers: { Authorization: "Bearer header.payload.sig" },
      })
    );
    const json = (await res.json()) as {
      whatsappRecordingSource: string;
      phoneRecordingSource: string;
      phoneRecordingNumber: string | null;
    };
    expect(json.whatsappRecordingSource).toBe("whatsapp_business");
    expect(json.phoneRecordingSource).toBe("none");
    expect(json.phoneRecordingNumber).toBeNull();
    h.setting = null;
  });

  it("returns the stored phone recording number", async () => {
    h.setting = {
      whatsapp_recording_source: "none",
      phone_recording_number: "918953065369",
    } as unknown as { whatsapp_recording_source: string };
    const res = await GET(
      new Request("https://app.test/api/auth/me", {
        headers: { Authorization: "Bearer header.payload.sig" },
      })
    );
    const json = (await res.json()) as { phoneRecordingNumber: string | null };
    expect(json.phoneRecordingNumber).toBe("918953065369");
    h.setting = null;
  });

  it("reports the explicit owner opt-in and configured flag", async () => {
    h.setting = {
      whatsapp_recording_source: "none",
      phone_recording_number: "918953065369",
      phone_recording_enabled: true,
    } as unknown as { whatsapp_recording_source: string };
    const enabled = await GET(
      new Request("https://app.test/api/auth/me", {
        headers: { Authorization: "Bearer header.payload.sig" },
      })
    );
    const enabledJson = (await enabled.json()) as {
      phoneRecordingEnabled: boolean;
      phoneRecordingConfigured: boolean;
    };
    expect(enabledJson.phoneRecordingEnabled).toBe(true);
    expect(enabledJson.phoneRecordingConfigured).toBe(true);
    // Absent row (and legacy rows predating the flag) fail closed.
    h.setting = null;
    const absent = await GET(
      new Request("https://app.test/api/auth/me", {
        headers: { Authorization: "Bearer header.payload.sig" },
      })
    );
    const absentJson = (await absent.json()) as {
      phoneRecordingEnabled: boolean;
      phoneRecordingConfigured: boolean;
    };
    expect(absentJson.phoneRecordingEnabled).toBe(false);
    expect(absentJson.phoneRecordingConfigured).toBe(false);
  });

  it("rejects invalid sessions with 401", async () => {
    h.deviceOk = false;
    const res = await GET(new Request("https://app.test/api/auth/me"));
    expect(res.status).toBe(401);
    h.deviceOk = true;
  });
});
