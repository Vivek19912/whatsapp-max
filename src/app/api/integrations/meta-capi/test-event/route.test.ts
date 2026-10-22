// Meta Conversions API — test event route.
//
// A test event must exercise the real POST /{dataset_id}/events edge with
// the account's Test Event Code, and "sent" must only be reported when
// Meta confirms events_received >= 1. Never a production conversion.
//
// The payload mirrors the production CRM lifecycle shape
// (system_generated + crm markers, synthetic identifiers only), and every
// Meta answer — success, 0-events, or Graph error — is persisted in full
// so Recent Deliveries renders the exact Meta verdict.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetaGraphError } from "@/lib/meta-lead-ads/errors";
import { toPublicDelivery } from "@/lib/meta-capi/serialize";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  roleOk: true,
  config: null as Record<string, unknown> | null,
  token: "tok" as string | null,
  appSecret: null as string | null,
  delivery: null as Record<string, unknown> | null,
  marked: [] as Array<{
    fn: string;
    id: string;
    error?: unknown;
    response?: unknown;
  }>,
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
  markDeliveryFailed: async (
    _db: unknown,
    id: string,
    _attempts?: unknown,
    error?: unknown,
    _nextRetryAt?: unknown,
    response?: unknown,
  ) => {
    h.marked.push({ fn: "failed", id, error, response });
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
  it("sends nothing on module load — a test event requires an explicit POST", async () => {
    // The import at the top of this file already happened; if merely
    // loading the route sent events, sendCalls would be non-empty here.
    expect(h.sendCalls).toHaveLength(0);
    expect(h.delivery).toBeNull();
    expect(h.marked).toHaveLength(0);
  });

  it("sends a CRM-lifecycle test event and reports acceptance", async () => {
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
    const event = payload.data[0] as {
      action_source: string;
      custom_data?: Record<string, unknown>;
      user_data?: Record<string, unknown>;
      messaging_channel?: unknown;
      event_name: string;
    };
    // CRM lifecycle shape, never a messaging conversion.
    expect(event.action_source).toBe("system_generated");
    expect(event.custom_data).toMatchObject({
      event_source: "crm",
      lead_event_source: "WhatsApp Max",
    });
    expect(event).not.toHaveProperty("messaging_channel");
    // Exactly one hashed synthetic identifier — never a real customer,
    // never an invented original Meta lead id.
    expect(event.user_data).not.toHaveProperty("lead_id");
    const em = (event.user_data ?? {}).em;
    expect(typeof em).toBe("string");
    expect(em).toMatch(/^[0-9a-f]{64}$/);
    // Test events are labelled, never production conversions.
    expect(h.delivery).toMatchObject({
      is_test: true,
      status: "pending",
      action_source: "system_generated",
    });
    expect(h.marked).toEqual([{ fn: "sent", id: "d1" }]);
  });

  it("ignores the account's configured action_source for CRM tests", async () => {
    h.config = { ...(h.config ?? {}), action_source: "website" };

    const res = await POST(post({}));

    expect(res.status).toBe(200);
    const payload = h.sendCalls[0].body as {
      data: Array<Record<string, unknown>>;
    };
    const event = payload.data[0] as Record<string, unknown>;
    expect(event.action_source).toBe("system_generated");
    expect(event).not.toHaveProperty("messaging_channel");
    expect(h.delivery).toMatchObject({ action_source: "system_generated" });
  });

  it("does not mutate config or mark dataset access verified", async () => {
    const before = { ...(h.config ?? {}) };

    const res = await POST(post({}));

    expect(res.status).toBe(200);
    // No status flip, no action_source rewrite: the store mock only
    // exposes read/insert/mark fns, so any config write would throw —
    // and the snapshot proves nothing changed.
    expect(h.config).toEqual(before);
  });

  it("persists the complete Meta error (nested fields, fbtrace_id) on rejection", async () => {
    const graphBody = {
      error: {
        message: "Invalid parameter",
        type: "OAuthException",
        code: 100,
        error_subcode: 2804001,
        error_data: { blurb: "Invalid parameter value" },
        error_user_title: "Could not process event",
        error_user_msg: "Please check the event data and try again.",
      },
      fbtrace_id: "AbC123xYz",
    };
    h.sendImpl = () => {
      throw new MetaGraphError({
        message: "Invalid parameter",
        graphType: "OAuthException",
        graphCode: 100,
        graphSubcode: 2804001,
        graphStatus: 400,
        graphBody,
        status: 400,
      });
    };

    const res = await POST(post({}));

    expect(res.status).toBe(502);
    const json = (await res.json()) as {
      code: string;
      error: string;
      response: { httpStatus: number | null; body: unknown };
    };
    expect(json.code).toBe("test_failed");
    expect(json.error).toBe("Invalid parameter");
    // The API response and the ledger row carry the full Meta answer.
    expect(json.response).toEqual({ httpStatus: 400, body: graphBody });
    expect(h.marked).toHaveLength(1);
    expect(h.marked[0]).toMatchObject({ fn: "failed", id: "d1" });
    expect(h.marked[0].response).toEqual({ httpStatus: 400, body: graphBody });
    const body = (h.marked[0].response as { body: typeof graphBody }).body;
    expect(body.error.error_subcode).toBe(2804001);
    expect(body.error.error_data).toEqual({ blurb: "Invalid parameter value" });
    expect(body.fbtrace_id).toBe("AbC123xYz");
  });

  it("redacts credential-looking keys before persisting the Meta body", async () => {
    h.sendImpl = () => {
      throw new MetaGraphError({
        message: "Invalid parameter",
        graphStatus: 400,
        status: 400,
        graphBody: {
          error: { message: "Invalid parameter", code: 100 },
          access_token: "SECRET-TOKEN",
          fbtrace_id: "trace-1",
        },
      });
    };

    const res = await POST(post({}));

    expect(res.status).toBe(502);
    const stored = h.marked[0].response as {
      httpStatus: number | null;
      body: Record<string, unknown>;
    };
    expect(stored.body.access_token).toBe("[redacted]");
    expect(stored.body.fbtrace_id).toBe("trace-1");
  });

  it("handles network failures without inventing Meta response fields", async () => {
    h.sendImpl = () => {
      throw new Error("socket hang up");
    };

    const res = await POST(post({}));

    expect(res.status).toBe(502);
    const json = (await res.json()) as {
      code: string;
      error: string;
      response: { httpStatus: number | null; body: unknown };
    };
    expect(json.code).toBe("test_failed");
    expect(json.error).toBe("Meta rejected the test event.");
    // No Graph exchange happened: status stays null and the body is
    // just the local message — never a fabricated Meta error shape.
    expect(json.response).toEqual({
      httpStatus: null,
      body: { message: "socket hang up" },
    });
    expect(h.marked[0].response).toEqual(json.response);
  });

  it("persists Meta's body when it accepts the request but counts 0 events", async () => {
    h.sendImpl = () => ({ events_received: 0, fbtrace_id: "trace-0" });

    const res = await POST(post({}));

    expect(res.status).toBe(502);
    const json = (await res.json()) as {
      code: string;
      response: { httpStatus: number | null; body: unknown };
    };
    expect(json.code).toBe("test_failed");
    expect(h.marked).toHaveLength(1);
    expect(h.marked[0]).toMatchObject({ fn: "failed", id: "d1" });
    // The exchange is stored (httpStatus null: sendEvents returns the
    // parsed body, not the transport status) instead of a bare message.
    expect(h.marked[0].response).toEqual({
      httpStatus: null,
      body: { events_received: 0, fbtrace_id: "trace-0" },
    });
    expect(json.response).toEqual(h.marked[0].response);
  });

  it("exposes the stored test-event response via Recent Deliveries without credentials", async () => {
    h.sendImpl = () => {
      throw new MetaGraphError({
        message: "Invalid parameter",
        graphStatus: 400,
        status: 400,
        graphBody: {
          error: { message: "Invalid parameter", code: 100 },
          access_token: "SECRET-TOKEN",
          fbtrace_id: "trace-2",
        },
      });
    };
    await POST(post({}));

    // What the ledger holds is what the viewer renders: toPublicDelivery
    // is the exact projection the Recent Deliveries endpoints return.
    const stored = h.marked[0].response as {
      httpStatus: number | null;
      body: unknown;
    };
    const pub = toPublicDelivery({
      id: "d1",
      event_name: "Lead",
      event_id: "test:1",
      source_action: "test",
      source_value: null,
      status: "failed",
      attempts: 1,
      is_test: true,
      last_error: "Invalid parameter",
      created_at: new Date().toISOString(),
      delivered_at: null,
      response_payload: stored,
    } as unknown as Parameters<typeof toPublicDelivery>[0]);
    expect(pub.isTest).toBe(true);
    expect(pub.response).toEqual({
      httpStatus: 400,
      body: {
        error: { message: "Invalid parameter", code: 100 },
        access_token: "[redacted]",
        fbtrace_id: "trace-2",
      },
    });
  });

  it("requires dataset, token, and a Test Event Code first", async () => {
    h.config = { ...(h.config ?? {}), test_event_code: null };
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(h.sendCalls).toHaveLength(0);
  });
});
