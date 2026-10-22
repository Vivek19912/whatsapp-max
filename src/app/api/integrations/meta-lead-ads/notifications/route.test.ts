// Meta lead notifications — settings, deliveries, and test-email routes.
//
// Authorization: settings GET + deliveries GET are any-member;
// settings PUT + test POST are admin+. Tenant isolation comes from
// the account-scoped queries (never a client-supplied account id).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "admin" as string | null,
  accountId: "acct-1",
  settingsRow: null as Record<string, unknown> | null,
  deliveries: [] as Array<Record<string, unknown>>,
  writes: [] as Array<Record<string, unknown>>,
  profile: { email: "admin@example.com", full_name: "Ada Admin" } as Record<string, unknown> | null,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.role) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId };
  },
  requireRole: async (min: string) => {
    if (!h.role) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: "user-admin" };
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

vi.mock("@/lib/meta-lead-ads/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-lead-ads/notify")>();
  return {
    ...actual,
    sendTestNotificationEmail: vi.fn(async () => ({ to: "admin@example.com", messageId: "t-1" })),
  };
});

function fakeSupabase() {
  const state = { table: "" };
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    state.table = table;
    return api;
  };
  api.select = () => api;
  api.eq = () => api;
  api.order = () => api;
  api.limit = () => api;
  api.maybeSingle = async () => {
    if (state.table === "meta_lead_notification_settings") {
      return { data: h.settingsRow, error: null };
    }
    if (state.table === "profiles") return { data: h.profile, error: null };
    return { data: null, error: null };
  };
  api.upsert = (row: Record<string, unknown>) => {
    h.writes.push({ table: state.table, row });
    h.settingsRow = { ...row };
    return api;
  };
  api.then = (resolve: (v: { data: unknown; error: null }) => void) => {
    if (state.table === "meta_lead_notifications") {
      return Promise.resolve({ data: h.deliveries, error: null }).then(resolve);
    }
    return Promise.resolve({ data: null, error: null }).then(resolve);
  };
  return api;
}

const { GET: getSettings, PUT: putSettings } = await import("./settings/route");
const { GET: getDeliveries } = await import("./deliveries/route");
const { POST: postTest } = await import("./test/route");
const { sendTestNotificationEmail } = await import("@/lib/meta-lead-ads/notify");

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "admin";
  h.accountId = "acct-1";
  h.settingsRow = null;
  h.deliveries = [];
  h.writes = [];
  h.profile = { email: "admin@example.com", full_name: "Ada Admin" };
});

describe("GET notifications/settings", () => {
  it("returns defaults (disabled) when no row exists", async () => {
    const res = await getSettings();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { enabled: boolean; is_default: boolean };
    expect(json.enabled).toBe(false);
    expect(json.is_default).toBe(true);
  });

  it("returns the stored row when present", async () => {
    h.settingsRow = {
      enabled: true,
      subject_template: "S",
      body_template: "B",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const res = await getSettings();
    const json = (await res.json()) as { enabled: boolean };
    expect(json.enabled).toBe(true);
  });

  it("rejects unauthenticated readers", async () => {
    h.role = null;
    const res = await getSettings();
    expect(res.status).toBe(401);
  });
});

describe("PUT notifications/settings", () => {
  const put = (body: unknown) =>
    putSettings(
      new Request("https://app.test/api/integrations/meta-lead-ads/notifications/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("saves enabled + templates for the caller's account", async () => {
    const res = await put({ enabled: true, subject_template: "Hi {{lead_name}}", body_template: "B {{lead_link}}" });
    expect(res.status).toBe(200);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      table: "meta_lead_notification_settings",
      row: expect.objectContaining({ account_id: "acct-1", enabled: true }),
    });
  });

  it("rejects non-admin writers", async () => {
    h.role = "agent";
    const res = await put({ enabled: true });
    expect(res.status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it("rejects malformed bodies", async () => {
    expect((await put({ enabled: "yes" })).status).toBe(400);
    expect((await put({ enabled: true, subject_template: "" })).status).toBe(400);
    expect((await put({ enabled: true, body_template: "x".repeat(4001) })).status).toBe(400);
  });
});

describe("GET notifications/deliveries", () => {
  it("lists this account's deliveries without credentials", async () => {
    h.deliveries = [
      { id: "n-1", lead_name: "Asha", status: "sent", recipient_email: "s@example.com" },
    ];
    const res = await getDeliveries(
      new Request("https://app.test/x/notifications/deliveries?limit=25"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deliveries: Array<Record<string, unknown>> };
    expect(json.deliveries).toHaveLength(1);
    expect(JSON.stringify(json)).not.toMatch(/SMTP_PASS|app-password|RESEND_API_KEY/);
  });

  it("rejects unauthenticated readers", async () => {
    h.role = null;
    const res = await getDeliveries(
      new Request("https://app.test/x/notifications/deliveries"),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST notifications/test", () => {
  it("sends a sample to the caller's own email only", async () => {
    const res = await postTest();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; to: string };
    expect(json.ok).toBe(true);
    expect(json.to).toBe("admin@example.com");
    expect(vi.mocked(sendTestNotificationEmail)).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: "acct-1", userId: "user-admin" },
    );
  });

  it("rejects non-admin callers", async () => {
    h.role = "agent";
    const res = await postTest();
    expect(res.status).toBe(403);
    expect(vi.mocked(sendTestNotificationEmail)).not.toHaveBeenCalled();
  });
});
