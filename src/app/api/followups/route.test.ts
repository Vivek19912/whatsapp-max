import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-1",
  contact: { id: "c-1", account_id: "acct-1", phone: "+91111", name: "Rahul" } as Record<string, unknown> | null,
  conversation: null as Record<string, unknown> | null,
  agentProfile: { whatsapp_number: "+91 98765 43210" } as Record<string, unknown> | null,
  profileError: false,
  rows: [] as Array<Record<string, unknown>>,
  tablesRead: [] as string[],
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
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

function fakeSupabase() {
  const state = { table: "", filters: [] as Array<[string, unknown]>, write: null as Record<string, unknown> | null };
  const matched = () =>
    h.rows.filter((r) => state.filters.every(([c, v]) => r[c] === v));
  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
    limit: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push([col, val]);
      return api;
    },
    maybeSingle: async () => {
      if (state.table === "contacts") return { data: h.contact, error: null };
      if (state.table === "conversations") return { data: h.conversation, error: null };
      if (state.table === "profiles") {
        if (h.profileError) return { data: null, error: { message: "column missing" } };
        return { data: h.agentProfile, error: null };
      }
      return { data: null, error: null };
    },
    single: async () => {
      const row = {
        id: "fu-1",
        account_id: h.accountId,
        status: "scheduled",
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-23T00:00:00Z",
        ...(state.write ?? {}),
      };
      if (state.table === "whatsapp_followups" && state.write) h.rows.push(row);
      return { data: row, error: null };
    },
    insert: (obj: Record<string, unknown>) => {
      state.write = obj;
      return api;
    },
    then: (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null }),
  };
  return { from: (table: string) => { state.table = table; h.tablesRead.push(table); return api; } };
}

const { GET, POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/followups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.contact = { id: "c-1", account_id: "acct-1", phone: "+91111", name: "Rahul" };
  h.conversation = null;
  h.agentProfile = { whatsapp_number: "+91 98765 43210" };
  h.profileError = false;
  h.rows = [];
  h.tablesRead = [];
});

describe("GET /api/followups", () => {
  it("lists account-scoped rows for members", async () => {
    h.role = "owner";
    h.rows = [
      { id: "a", account_id: "acct-1", status: "scheduled" },
      { id: "b", account_id: "acct-2", status: "scheduled" },
    ];
    const res = await GET(new Request("https://app.test/api/followups?status=scheduled"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { followups: Array<{ id: string }> };
    expect(json.followups.map((r) => r.id)).toEqual(["a"]);
  });

  it("scopes agents to their own reminders only", async () => {
    h.role = "agent";
    h.userId = "user-1";
    h.rows = [
      { id: "mine", account_id: "acct-1", status: "scheduled", created_by: "user-1" },
      { id: "theirs", account_id: "acct-1", status: "scheduled", created_by: "user-2" },
    ];
    const res = await GET(new Request("https://app.test/api/followups?status=scheduled"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { followups: Array<{ id: string }> };
    expect(json.followups.map((r) => r.id)).toEqual(["mine"]);
  });

  it("400s on an invalid status filter", async () => {
    const res = await GET(new Request("https://app.test/api/followups?status=bogus"));
    expect(res.status).toBe(400);
  });

  it("401s when unauthenticated", async () => {
    h.authed = false;
    const res = await GET(new Request("https://app.test/api/followups"));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/followups", () => {
  const valid = {
    contact_id: "c-1",
    scheduled_for: "2999-01-01T10:00:00.000Z",
    message_text: "Call Rahul about Singapore package",
  };

  it("snapshots the creator's number as recipient, never the customer's", async () => {
    const res = await POST(post(valid));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { followup: Record<string, unknown> };
    expect(json.followup).toMatchObject({
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      // Agent's normalized number — NOT the customer's +91111.
      recipient_phone: "919876543210",
    });
    const inserted = h.rows[0];
    // No customer field on creation: contact_id is always NULL,
    // even when the body carries one.
    expect(inserted.contact_id).toBeNull();
    // No customer thread is created or attached for delivery.
    expect(inserted.conversation_id).toBeNull();
    expect(h.tablesRead).not.toContain("contacts");
    expect(h.tablesRead).not.toContain("messages");
  });

  it("creates a personal reminder with no customer", async () => {
    const res = await POST(
      post({
        scheduled_for: "2999-01-01T10:00:00.000Z",
        message_text: "Call the Dubai lead after lunch",
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { followup: Record<string, unknown> };
    expect(json.followup).toMatchObject({ recipient_phone: "919876543210" });
    expect(h.rows[0].contact_id).toBeNull();
    expect(h.rows[0].conversation_id).toBeNull();
  });

  it("fails closed without an agent number — no customer fallback", async () => {
    h.agentProfile = null;
    const res = await POST(post(valid));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/whatsapp number/i);
    // Nothing created: the customer's phone must never substitute.
    expect(h.rows).toHaveLength(0);
  });

  it("fails closed on an invalid agent number and on profile errors", async () => {
    h.agentProfile = { whatsapp_number: "not-a-number" };
    const bad = await POST(post(valid));
    expect(bad.status).toBe(400);
    expect(h.rows).toHaveLength(0);

    h.profileError = true;
    const errRes = await POST(post(valid));
    expect(errRes.status).toBe(400);
    expect(h.rows).toHaveLength(0);
  });

  it("normalizes a country-code-less agent number with the India default", async () => {
    // Bare 10-digit profile: accepted without warnings, stored and
    // submitted as the +91-prefixed normalized value — never
    // substituted with the customer phone.
    h.agentProfile = { whatsapp_number: "9876543210" };
    const res = await POST(post(valid));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { followup: Record<string, unknown> };
    expect(json.followup).toMatchObject({ recipient_phone: "919876543210" });
    expect(h.rows[0].recipient_phone).toBe("919876543210");
  });

  it("rejects past times and viewers", async () => {
    const past = await POST(post({ ...valid, scheduled_for: "2000-01-01T00:00:00Z" }));
    expect(past.status).toBe(400);
    h.role = "viewer";
    const forbidden = await POST(post(valid));
    expect(forbidden.status).toBe(403);
  });

  it("ignores any contact_id in the body — including cross-account ones", async () => {
    h.contact = { id: "c-1", account_id: "acct-2", phone: "+91111", name: "X" };
    // No contact lookup happens at all: creation succeeds with a
    // NULL contact, never another account's contact.
    const res = await POST(post(valid));
    expect(res.status).toBe(201);
    expect(h.rows[0].contact_id).toBeNull();
    expect(h.tablesRead).not.toContain("contacts");
  });
});
