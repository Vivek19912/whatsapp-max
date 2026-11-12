import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-A",
  createdBy: "user-minter",
  contacts: [] as Array<{ id: string; phone_normalized: string }>,
  lastInsert: null as Record<string, unknown> | null,
  insertError: null as { code?: string; message?: string } | null,
  existingRow: null as Record<string, unknown> | null,
  deviceUser: null as null | {
    userId: string;
    accountId: string;
    role: string;
  },
}));

function chainableSelect() {
  const builder: Record<string, (...args: never[]) => unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.limit = async () => ({ data: h.contacts, error: null });
  builder.maybeSingle = async () => {
    if (h.existingRow) return { data: h.existingRow, error: null };
    return {
      data: h.contacts.length > 0 ? { id: h.contacts[0].id } : null,
      error: null,
    };
  };
  return builder;
}

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === "call_events") {
        return {
          insert: (obj: Record<string, unknown>) => {
            h.lastInsert = obj;
            return {
              select: () => ({
                single: async () => {
                  if (h.insertError) return { data: null, error: h.insertError };
                  return {
                    data: {
                      id: "e-1",
                      created_at: "2026-10-06T10:00:00.000Z",
                      ...obj,
                    },
                    error: null,
                  };
                },
              }),
            };
          },
          select: () => chainableSelect(),
        };
      }
      return chainableSelect();
    },
  };
}

vi.mock("@/lib/auth/api-context", () => ({
  requireApiKey: async () => ({
    authType: "api_key",
    supabase: fakeSupabase(),
    accountId: h.accountId,
    keyId: "key-1",
    scopes: ["recordings:write"],
    createdBy: h.createdBy,
  }),
}));

vi.mock("@/lib/auth/device", async (importOriginal) => {
  await importOriginal<typeof import("@/lib/auth/device")>();
  const { unauthorized } = await import("@/lib/api/v1/respond");
  return {
    bearerToken: (request: Request) => {
      const header = request.headers.get("authorization");
      if (!header) return null;
      const value = header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : header.trim();
      return value.length > 0 ? value : null;
    },
    requireDeviceUser: async () => {
      if (!h.deviceUser) throw unauthorized("Invalid or expired session");
      return {
        authType: "user",
        supabase: fakeSupabase(),
        service: fakeSupabase(),
        userId: h.deviceUser.userId,
        accountId: h.deviceUser.accountId,
        role: h.deviceUser.role,
        fullName: null,
      };
    },
  };
});

const { POST, parseDurationSeconds } = await import("./route");

const DEVICE_TOKEN = "device-session-token";
const EVENT = {
  client_event_id: "evt-1",
  call_type: "phone",
  direction: "in",
  outcome: "missed",
  phone_number: "+919876543210",
  duration_seconds: 0,
  occurred_at: "2026-10-06T10:00:00.000Z",
};

function postEvent(body: Record<string, unknown> = EVENT, token: string | null = DEVICE_TOKEN) {
  return new Request("https://app.test/api/v1/call-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.accountId = "acct-A";
  h.createdBy = "user-minter";
  h.contacts = [];
  h.lastInsert = null;
  h.insertError = null;
  h.existingRow = null;
  h.deviceUser = { userId: "user-1", accountId: "acct-A", role: "agent" };
});

describe("POST /api/v1/call-events", () => {
  it("inserts a missed event with server-derived account and user", async () => {
    const res = await POST(postEvent());
    expect(res.status).toBe(201);
    expect(h.lastInsert).toMatchObject({
      account_id: "acct-A",
      user_id: "user-1",
      client_event_id: "evt-1",
      call_type: "phone",
      direction: "in",
      outcome: "missed",
    });
    const json = (await res.json()) as { data: { contact_id: null; matched: boolean } };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("links the contact on a unique phone match, never guessing", async () => {
    h.contacts = [{ id: "c-1", phone_normalized: "919876543210" }];
    const res = await POST(postEvent());
    const json = (await res.json()) as { data: { contact_id: string; matched: boolean } };
    expect(res.status).toBe(201);
    expect(json.data.matched).toBe(true);
    expect(json.data.contact_id).toBe("c-1");
  });

  it("leaves contact_id NULL on ambiguous matches", async () => {
    h.contacts = [
      { id: "c-1", phone_normalized: "919876543210" },
      { id: "c-2", phone_normalized: "919876543210" },
    ];
    const res = await POST(postEvent());
    const json = (await res.json()) as { data: { matched: boolean } };
    expect(res.status).toBe(201);
    expect(json.data.matched).toBe(false);
    expect(h.lastInsert?.contact_id).toBeNull();
  });

  it("returns the existing row (200, deduped) on client_event_id retry", async () => {
    h.insertError = { code: "23505", message: "duplicate" };
    h.existingRow = {
      id: "e-9",
      account_id: "acct-A",
      client_event_id: "evt-1",
      contact_id: null,
    };
    const res = await POST(postEvent());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { deduped: boolean; id: string } };
    expect(json.data.deduped).toBe(true);
    expect(json.data.id).toBe("e-9");
  });

  it("accepts JSON numbers and legacy numeric strings for duration_seconds", async () => {
    for (const [input, expected] of [
      [0, 0],
      [63, 63],
      ["0", 0],
      ["63", 63],
      ["  7  ", 7],
      [null, null],
      [undefined, null],
    ] as Array<[unknown, number | null]>) {
      h.lastInsert = null;
      const body = { ...EVENT, client_event_id: `evt-${String(expected)}-${String(input)}` };
      if (input === undefined) {
        delete (body as Record<string, unknown>).duration_seconds;
      } else {
        (body as Record<string, unknown>).duration_seconds = input;
      }
      const res = await POST(postEvent(body));
      expect(res.status).toBe(201);
      const inserted = h.lastInsert as Record<string, unknown> | null;
      expect(inserted?.duration_seconds).toBe(expected);
      expect(typeof inserted?.duration_seconds).not.toBe("string");
    }
    // Omitted duration stays NULL rather than failing.
    h.lastInsert = null;
    const omitted = { ...EVENT, client_event_id: "evt-omitted" };
    delete (omitted as Record<string, unknown>).duration_seconds;
    expect((await POST(postEvent(omitted))).status).toBe(201);
    expect((h.lastInsert as Record<string, unknown> | null)?.duration_seconds).toBeNull();
  });

  it("rejects non-integer, negative, blank, and unsafe durations", async () => {
    for (const [input, name] of [
      [-1, "negative number"],
      ["-1", "negative string"],
      [1.5, "decimal number"],
      ["1.5", "decimal string"],
      ["", "empty string"],
      ["   ", "whitespace string"],
      ["abc", "non-numeric string"],
      ["0x10", "hex string"],
      ["1e3", "exponent string"],
      [true, "boolean"],
      // NaN/Infinity cannot survive JSON transport (they serialize
      // to null), so they are covered at the parser level below.
      [Number.MAX_SAFE_INTEGER + 1, "unsafe integer"],
      ["9007199254740993", "unsafe integer string"],
    ] as Array<[unknown, string]>) {
      h.lastInsert = null;
      const res = await POST(postEvent({ ...EVENT, duration_seconds: input }));
      expect(res.status, name).toBe(400);
      expect(h.lastInsert, name).toBeNull();
    }
  });

  it("parses durations strictly at the unit level (incl. non-JSON values)", () => {
    expect(parseDurationSeconds(null)).toBeNull();
    expect(parseDurationSeconds(undefined)).toBeNull();
    expect(parseDurationSeconds(0)).toBe(0);
    expect(parseDurationSeconds(63)).toBe(63);
    expect(parseDurationSeconds("0")).toBe(0);
    expect(parseDurationSeconds("63")).toBe(63);
    for (const bad of [
      -1, "-1", 1.5, "1.5", "", "   ", "abc", "0x10", "1e3",
      true, false, Number.NaN, Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
      "9007199254740993", {}, [],
    ]) {
      expect(parseDurationSeconds(bad), String(bad)).toBeUndefined();
    }
  });

  it("rejects missing/invalid outcome, type, and timestamps", async () => {
    for (const body of [
      { ...EVENT, outcome: "connected" },
      { ...EVENT, outcome: undefined },
      { ...EVENT, call_type: "whatsapp" },
      { ...EVENT, direction: "missed" },
      { ...EVENT, client_event_id: "" },
      { ...EVENT, occurred_at: "not-a-date" },
      { ...EVENT, duration_seconds: -1 },
      { ...EVENT, phone_number: "x".repeat(65) },
    ]) {
      const res = await POST(postEvent(body));
      expect(res.status).toBe(400);
    }
    expect(h.lastInsert).toBeNull();
  });

  it("ignores client-supplied identity: account and user come from the session", async () => {
    const res = await POST(
      postEvent({
        ...EVENT,
        account_id: "acct-EVIL",
        user_id: "user-evil",
        role: "owner",
      })
    );
    expect(res.status).toBe(201);
    expect(h.lastInsert?.account_id).toBe("acct-A");
    expect(h.lastInsert?.user_id).toBe("user-1");
  });

  it("401s an unknown session token", async () => {
    h.deviceUser = null;
    const res = await POST(postEvent(EVENT, DEVICE_TOKEN));
    expect(res.status).toBe(401);
    expect(h.lastInsert).toBeNull();
  });
});
