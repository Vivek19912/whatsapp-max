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
    updated_at: string;
  }>,
  writes: [] as Array<Record<string, unknown>>,
}));

// Minimal postgrest chain: profiles lookups (maybeSingle) and the
// settings upsert (... → select → single). RLS is bypassed by the
// mocked client, exactly like the service-role path in prod —
// authorization is asserted via status codes, not the mock.
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
                    h.settings.find(
                      (s) => s.account_id === h.accountId,
                    ) ?? null,
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
                    whatsapp_recording_source: row.whatsapp_recording_source ?? null,
                    phone_recording_source: row.phone_recording_source ?? null,
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

const { GET, PUT } = await import("./route");

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

describe("recording-settings [userId]", () => {
  it("owner can set none", async () => {
    const res = await put("agent-1", { whatsapp_recording_source: "none" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: { user_id: string; whatsapp_recording_source: string };
    };
    expect(json.setting).toMatchObject({
      user_id: "agent-1",
      whatsapp_recording_source: "none",
    });
    expect(h.writes[0]).toMatchObject({
      account_id: "acct-1",
      user_id: "agent-1",
      whatsapp_recording_source: "none",
      updated_by: "owner-1",
    });
  });

  it("owner can set whatsapp", async () => {
    const res = await put("agent-1", { whatsapp_recording_source: "whatsapp" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: { whatsapp_recording_source: string };
    };
    expect(json.setting.whatsapp_recording_source).toBe("whatsapp");
  });

  it("owner can set whatsapp_business", async () => {
    const res = await put("agent-1", {
      whatsapp_recording_source: "whatsapp_business",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: { whatsapp_recording_source: string };
    };
    expect(json.setting.whatsapp_recording_source).toBe("whatsapp_business");
  });

  it("owner can set phone = none", async () => {
    const res = await put("agent-1", { phone_recording_source: "none" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: { phone_recording_source: string };
    };
    expect(json.setting.phone_recording_source).toBe("none");
    expect(h.writes[0]).toMatchObject({
      account_id: "acct-1",
      user_id: "agent-1",
      phone_recording_source: "none",
      updated_by: "owner-1",
    });
  });

  it("owner can set phone = sim1", async () => {
    const res = await put("agent-1", { phone_recording_source: "sim1" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: { phone_recording_source: string };
    };
    expect(json.setting.phone_recording_source).toBe("sim1");
  });

  it("owner can set phone = sim2", async () => {
    const res = await put("agent-1", { phone_recording_source: "sim2" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: { phone_recording_source: string };
    };
    expect(json.setting.phone_recording_source).toBe("sim2");
  });

  it("owner can set both policies in one call", async () => {
    const res = await put("agent-1", {
      phone_recording_source: "sim2",
      whatsapp_recording_source: "whatsapp_business",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: { phone_recording_source: string; whatsapp_recording_source: string };
    };
    expect(json.setting.phone_recording_source).toBe("sim2");
    expect(json.setting.whatsapp_recording_source).toBe("whatsapp_business");
  });

  it("setting one policy preserves the other", async () => {
    h.settings = [
      {
        user_id: "agent-1",
        account_id: "acct-1",
        whatsapp_recording_source: "whatsapp",
        phone_recording_source: "sim1",
        updated_at: "2026-10-06T00:00:00.000Z",
      },
    ];
    const res = await put("agent-1", { phone_recording_source: "sim2" });
    expect(res.status).toBe(200);
    // Only the phone column is written; whatsapp rides along untouched.
    expect(h.writes[0]).not.toHaveProperty("whatsapp_recording_source");
    expect(h.writes[0]).toMatchObject({ phone_recording_source: "sim2" });
  });

  it("rejects arbitrary values", async () => {
    for (const bad of ["both", "WHATSAPP", "", null, 42, ["whatsapp"]]) {
      const res = await put("agent-1", { whatsapp_recording_source: bad });
      expect(res.status).toBe(400);
    }
    for (const bad of ["sim3", "SIM1", "slot1", "", null, 1, ["sim1"]]) {
      const res = await put("agent-1", { phone_recording_source: bad });
      expect(res.status).toBe(400);
    }
    const res = await put("agent-1", {});
    expect(res.status).toBe(400);
    expect(h.writes).toEqual([]);
  });

  it("non-owner cannot modify another member", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    const res = await put("owner-1", { whatsapp_recording_source: "whatsapp" });
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("viewer cannot modify another member", async () => {
    h.role = "viewer";
    h.userId = "agent-1";
    const res = await put("owner-1", { phone_recording_source: "sim1" });
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("agent can modify their own setting", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    const res = await put("agent-1", { whatsapp_recording_source: "whatsapp" });
    expect(res.status).toBe(200);
  });

  it("rejects cross-account targets as missing", async () => {
    h.profiles = [{ user_id: "owner-1", account_id: "acct-1" }];
    const res = await put("agent-1", { whatsapp_recording_source: "whatsapp" });
    expect(res.status).toBe(404);
    expect(h.writes).toEqual([]);
  });

  it("user receives their own setting; absent row means none/none", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    const res = await get("agent-1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: {
        user_id: string;
        whatsapp_recording_source: string;
        phone_recording_source: string;
        phone_recording_number: string | null;
        phone_recording_enabled: boolean;
        updated_at: null;
      };
    };
    expect(json.setting).toEqual({
      user_id: "agent-1",
      whatsapp_recording_source: "none",
      phone_recording_source: "none",
      phone_recording_number: null,
      // Absent row (and legacy rows) fail closed: no explicit owner opt-in.
      phone_recording_enabled: false,
      updated_at: null,
    });
  });

  it("returns a stored setting when one exists", async () => {
    h.settings = [
      {
        user_id: "agent-1",
        account_id: "acct-1",
        whatsapp_recording_source: "whatsapp_business",
        phone_recording_source: "sim2",
        updated_at: "2026-10-06T00:00:00.000Z",
      },
    ];
    const res = await get("agent-1");
    const json = (await res.json()) as {
      setting: { whatsapp_recording_source: string; phone_recording_source: string };
    };
    expect(json.setting.whatsapp_recording_source).toBe("whatsapp_business");
    expect(json.setting.phone_recording_source).toBe("sim2");
  });

  it("non-owner cannot read another member", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    const res = await get("owner-1");
    expect(res.status).toBe(403);
  });
});
