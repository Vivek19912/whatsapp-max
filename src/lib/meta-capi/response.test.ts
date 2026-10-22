// Meta CAPI stored responses — capture, sanitize, normalize.
//
// Pins the diagnostics contract: the COMPLETE Meta body (nested
// error data, subcodes, fbtrace_id, success fields) survives
// capture without truncation, credentials are redacted, and both
// the new envelope shape and legacy raw rows normalize for display.

import { describe, expect, it } from "vitest";

import { MetaGraphError } from "@/lib/meta-lead-ads/errors";

import {
  buildFailureResponse,
  normalizeStoredResponse,
  sanitizeResponseBody,
  toStoredResponse,
} from "./response";

const FULL_GRAPH_ERROR = {
  error: {
    message: "Invalid parameter",
    type: "OAuthException",
    code: 100,
    error_subcode: 2804001,
    error_data: { blurb: "Invalid parameter value", details: [{ code: 1 }] },
    error_user_title: "Could not process event",
    error_user_msg: "Please check the event data and try again.",
    fbtrace_id: "AbC123xYz",
  },
};

describe("sanitizeResponseBody", () => {
  it("preserves the complete error body verbatim (no truncation)", () => {
    const out = sanitizeResponseBody(FULL_GRAPH_ERROR) as typeof FULL_GRAPH_ERROR;
    expect(out).toEqual(FULL_GRAPH_ERROR);
    expect(out.error.error_subcode).toBe(2804001);
    expect(out.error.fbtrace_id).toBe("AbC123xYz");
    expect(out.error.error_data).toEqual({
      blurb: "Invalid parameter value",
      details: [{ code: 1 }],
    });
  });

  it("redacts credential-looking keys at any depth", () => {
    const out = sanitizeResponseBody({
      ok: true,
      access_token: "SECRET-TOKEN",
      nested: { appsecret_proof: "SECRET-PROOF", safe: "keep" },
      list: [{ client_secret: "SECRET" }, 1],
    }) as Record<string, unknown>;
    expect(out).toEqual({
      ok: true,
      access_token: "[redacted]",
      nested: { appsecret_proof: "[redacted]", safe: "keep" },
      list: [{ client_secret: "[redacted]" }, 1],
    });
  });

  it("handles primitives, nulls, and non-JSON values safely", () => {
    expect(sanitizeResponseBody(null)).toBeNull();
    expect(sanitizeResponseBody("text")).toBe("text");
    expect(sanitizeResponseBody(42)).toBe(42);
    expect(sanitizeResponseBody(undefined)).toBeNull();
    expect(sanitizeResponseBody(Symbol("s"))).toBeNull();
  });
});

describe("buildFailureResponse", () => {
  it("captures the full Graph error body with its HTTP status", () => {
    const err = new MetaGraphError({
      message: "Invalid parameter",
      graphStatus: 400,
      graphType: "OAuthException",
      graphCode: 100,
      graphSubcode: 2804001,
      graphBody: FULL_GRAPH_ERROR,
    });
    const stored = buildFailureResponse(err);
    expect(stored.httpStatus).toBe(400);
    expect(stored.body).toEqual(FULL_GRAPH_ERROR);
  });

  it("falls back safely for transport errors without a Meta body", () => {
    const stored = buildFailureResponse(new Error("network down"));
    expect(stored.httpStatus).toBeNull();
    expect(stored).toEqual({ httpStatus: null, body: { message: "network down" } });
  });

  it("never throws and never includes tokens", () => {
    const stored = buildFailureResponse(null);
    expect(stored).toEqual({ httpStatus: null, body: { message: "null" } });
  });
});

describe("normalizeStoredResponse", () => {
  it("passes new envelopes through", () => {
    const stored = toStoredResponse(400, FULL_GRAPH_ERROR);
    expect(normalizeStoredResponse(stored)).toEqual(stored);
  });

  it("normalizes legacy raw success rows", () => {
    const legacy = { events_received: 2, fbtrace_id: "abc" };
    expect(normalizeStoredResponse(legacy)).toEqual({
      httpStatus: null,
      body: legacy,
    });
  });

  it("returns null when there is nothing to show", () => {
    expect(normalizeStoredResponse(null)).toBeNull();
    expect(normalizeStoredResponse(undefined)).toBeNull();
  });
});
