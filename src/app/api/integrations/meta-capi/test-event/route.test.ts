// Meta Conversions API — test event route.
//
// A test event must exercise the real POST /{dataset_id}/events edge with
// the account's Test Event Code, and "sent" must only be reported when
// Meta confirms events_received >= 1. Never a production conversion.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetaGraphError } from "@/lib/meta-lead-ads/errors";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  roleOk: true,
  config: null as Record<string, unknown> | null,
  token: "tok" as string | null,
  appSecret: null as string | null,
  delivery: null as Record<string, unknown> | null,
  marked: [] as Array<{ fn: string; id: string }>,
  sendImpl: null as null | ((body: Record<string, unknown>) => Record<string, unknown>),
  sendCalls: [] as Array<{ dataset: unknown; body: unknown; opts: unknown }>,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => {
    if (!h.roleOk) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return { supabase: {}, accountId: h.accountId, userId: "u1" };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({}),
}));

vi.mock("@/lib/meta-capi/triggers", () => ({
  metaCapiPlatform: () => ({ graphVersion: "v26.0" }),
}));

vi.mock("@/lib/meta-capi/store", () => ({
  getConfig: async () => h.config,
  getDecryptedAppSecret: async () => h.appSecret,
  getDecryptedToken: async () => h.token,
  insertDelivery: async (_db: unknown, row: Record<string, unknown>) => {
    h.delivery = { id: "d1", attempts: 0, ...row };
    return h.delivery;
  },
  markDeliverySent: async (_db: unknown, id: string) => {
    h.marked.push({ fn: "sent", id });
  },
  markDeliveryFailed: async (_db: unknown, id: string) => {
    h.marked.push({ fn: "failed", id });
  },
}));

vi.mock("@/lib/meta-capi/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta-capi/client")>();
  return {
    ...actual,
    sendEvents: async (
      _platform: unknown,
      dataset: unknown,
      _token: unknown,
      body: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => {
      h.sendCalls.push({ dataset, body, opts });
      if (h.sendImpl) return h.sendImpl(body);
      return { events_received: 1, fbtrace_id: "trace" };
    },
  };
});

const { POST } = await import("./route");

const post = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-capi/test-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.accountId = "acct-1";
  h.roleOk = true;
  h.config = {
    account_id: "acct-1",
    dataset_id: "123",
    access_token: "enc",
    action_source: "business_messaging",
    test_event_code: "TEST123",
  };
  h.token = "tok";
  h.appSecret = null;
  h.delivery = null;
  h.marked = [];
  h.sendImpl = null;
  h.sendCalls = [];
});

describe("POST /meta-capi/test-event", () => {
  it("sends a labelled test event to the real edge and reports acceptance", async () => {
    const res = await POST(post({}));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      eventsReceived: number;
      note: string;
    };
    expect(json.ok).toBe(true);
    expect(json.eventsReceived).toBe(1);
    expect(json.note).toMatch(/TEST event/);
    expect(h.sendCalls).toHaveLength(1);
    expect(h.sendCalls[0].dataset).toBe("123");
    const payload = h.sendCalls[0].body as {
      data: Array<Record<string, unknown>>;
      test_event_code: string;
    };
    expect(payload.test_event_code).toBe("TEST123");
    expect(payload.data).toHaveLength(1);
    // Test events are labelled, never production conversions.
    expect(h.delivery).toMatchObject({ is_test: true, status: "pending" });
    expect(h.marked).toEqual([{ fn: "sent", id: "d1" }]);
  });

  it("reports a Meta rejection without claiming delivery", async () => {
    h.sendImpl = () => {
      throw new MetaGraphError({
        message: "(#100) Missing perms",
        graphType: "OAuthException",
        graphCode: 100,
        graphStatus: 400,
        status: 400,
      });
    };

    const res = await POST(post({}));

    expect(res.status).toBe(502);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe("test_failed");
    expect(h.marked).toEqual([{ fn: "failed", id: "d1" }]);
  });

  it("does not report acceptance when Meta confirms 0 events received", async () => {
    h.sendImpl = () => ({ events_received: 0 });

    const res = await POST(post({}));

    expect(res.status).toBe(502);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("test_failed");
    expect(h.marked).toEqual([{ fn: "failed", id: "d1" }]);
  });

  it("requires dataset, token, and a Test Event Code first", async () => {
    h.config = { ...(h.config ?? {}), test_event_code: null };
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(h.sendCalls).toHaveLength(0);
  });
});
