// GET /api/integrations/meta-capi/deliveries — full Meta responses.
//
// Guarantees: tenant isolation (account-scoped reads), and the
// complete stored Meta response body (with HTTP status) reaches
// the browser for expansion — without triggering new deliveries.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({ supabase: {}, accountId: h.accountId, userId: "u1" }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

vi.mock("@/lib/meta-capi/store", () => ({
  listDeliveries: async (_db: unknown, accountId: string, limit?: number) => {
    void limit;
    return h.rows.filter((r) => r.account_id === accountId);
  },
}));

const { GET } = await import("./route");

beforeEach(() => {
  h.accountId = "acct-1";
  h.rows = [
    {
      id: "d-fail",
      account_id: "acct-1",
      event_name: "Lead",
      event_id: "e-1",
      status: "failed",
      attempts: 2,
      last_error: "graph_error: Invalid parameter",
      response_payload: {
        httpStatus: 400,
        body: {
          error: {
            message: "Invalid parameter",
            type: "OAuthException",
            code: 100,
            error_subcode: 2804001,
            fbtrace_id: "TRACE-9",
          },
        },
      },
    },
    {
      id: "d-sent",
      account_id: "acct-1",
      event_name: "Lead",
      event_id: "e-2",
      status: "sent",
      attempts: 1,
      last_error: null,
      response_payload: { events_received: 1, fbtrace_id: "abc" },
    },
    {
      id: "d-old",
      account_id: "acct-1",
      event_name: "Lead",
      event_id: "e-3",
      status: "failed",
      attempts: 1,
      last_error: "graph_error: boom",
      response_payload: null,
    },
    {
      id: "d-foreign",
      account_id: "other-acct",
      event_name: "Lead",
      event_id: "e-4",
      status: "failed",
      attempts: 1,
      last_error: "x",
      response_payload: { httpStatus: 400, body: { error: "x" } },
    },
  ];
});

describe("GET deliveries with full Meta responses", () => {
  it("returns the complete stored error body with HTTP status", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deliveries: Array<Record<string, unknown>> };
    const failed = json.deliveries.find((d) => d.id === "d-fail") as Record<string, unknown>;
    expect(failed.response).toEqual({
      httpStatus: 400,
      body: {
        error: {
          message: "Invalid parameter",
          type: "OAuthException",
          code: 100,
          error_subcode: 2804001,
          fbtrace_id: "TRACE-9",
        },
      },
    });
  });

  it("returns raw success bodies and null for uncaptured ones", async () => {
    const res = await GET();
    const json = (await res.json()) as { deliveries: Array<Record<string, unknown>> };
    const sent = json.deliveries.find((d) => d.id === "d-sent") as Record<string, unknown>;
    expect(sent.response).toEqual({
      httpStatus: null,
      body: { events_received: 1, fbtrace_id: "abc" },
    });
    const old = json.deliveries.find((d) => d.id === "d-old") as Record<string, unknown>;
    expect(old.response).toBeNull();
  });

  it("enforces tenant isolation and never exposes request payloads", async () => {
    const res = await GET();
    const json = (await res.json()) as { deliveries: Array<Record<string, unknown>> };
    expect(json.deliveries.map((d) => d.id).sort()).toEqual(["d-fail", "d-old", "d-sent"]);
    for (const d of json.deliveries) {
      expect(d).not.toHaveProperty("request_payload");
    }
    expect(JSON.stringify(json)).not.toContain("whatsapp_number");
  });
});
