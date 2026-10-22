// Meta CAPI public projections — response exposure contract.
//
// Pins that the complete Meta response body (and only that) reaches
// the browser: full nested bodies survive, legacy raw rows still
// render, missing bodies map to null, and request payloads
// (customer matching data) are never exposed.

import { describe, expect, it } from "vitest";

import { toPublicDelivery, toPublicDeliveryResponse } from "./serialize";
import type { MetaCapiDeliveryRow } from "./types";

function row(overrides: Partial<MetaCapiDeliveryRow> = {}): MetaCapiDeliveryRow {
  return {
    id: "d-1",
    account_id: "acct-1",
    mapping_id: null,
    flow_run_id: null,
    contact_id: null,
    source_action: "meta_lead_received",
    source_value: null,
    event_name: "Lead",
    event_id: "e-1",
    action_source: "business_messaging",
    is_test: false,
    status: "failed",
    attempts: 1,
    last_error: "graph_error: Invalid parameter",
    request_payload: { data: [{ event_name: "Lead" }] },
    response_payload: null,
    next_retry_at: null,
    claimed_at: null,
    delivered_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const FULL_BODY = {
  error: {
    message: "Invalid parameter",
    type: "OAuthException",
    code: 100,
    error_subcode: 2804001,
    fbtrace_id: "TRACE-9",
    error_data: { details: [{ row: 0 }] },
  },
};

describe("toPublicDeliveryResponse", () => {
  it("exposes the complete stored body with its HTTP status", () => {
    expect(
      toPublicDeliveryResponse(row({ response_payload: { httpStatus: 400, body: FULL_BODY } as never })),
    ).toEqual({ httpStatus: 400, body: FULL_BODY });
  });

  it("normalizes legacy raw success rows without inventing a status", () => {
    const legacy = { events_received: 2, fbtrace_id: "abc" };
    expect(toPublicDeliveryResponse(row({ response_payload: legacy as never }))).toEqual({
      httpStatus: null,
      body: legacy,
    });
  });

  it("returns null when no response was captured", () => {
    expect(toPublicDeliveryResponse(row({ response_payload: null }))).toBeNull();
  });
});

describe("toPublicDelivery", () => {
  it("includes the full response for failed deliveries", () => {
    const pub = toPublicDelivery(
      row({ response_payload: { httpStatus: 400, body: FULL_BODY } as never }),
    );
    expect(pub.response).toEqual({ httpStatus: 400, body: FULL_BODY });
    expect(pub.lastError).toBe("graph_error: Invalid parameter");
  });

  it("includes the full response for sent deliveries", () => {
    const body = { events_received: 1, fbtrace_id: "abc", messages: ["ok"] };
    const pub = toPublicDelivery(row({ status: "sent", response_payload: body as never }));
    expect(pub.response).toEqual({ httpStatus: null, body });
  });

  it("reports null when the response was never captured", () => {
    expect(toPublicDelivery(row({})).response).toBeNull();
  });

  it("never exposes the request payload (customer matching data)", () => {
    const pub = toPublicDelivery(row({}) as MetaCapiDeliveryRow);
    expect(pub).not.toHaveProperty("request_payload");
    expect(JSON.stringify(pub)).not.toContain("whatsapp_number");
    expect(JSON.stringify(pub)).not.toContain("access_token");
  });
});
