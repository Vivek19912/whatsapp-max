// Meta Conversions API — Graph client / appsecret_proof behaviour.
//
// Regression guard for "Invalid appsecret_proof provided in the API
// argument": a proof must only ever be sent when it is computed with the
// secret of the app that issued the token. The platform Lead Ads secret
// is never used for a customer token; with no customer secret we send no
// proof at all.

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { MetaGraphError } from "@/lib/meta-lead-ads/errors";

import {
  capiRequest,
  describeCapiVerificationError,
  describeDatasetAccessError,
  graphDiagnosticRef,
  sendEvents,
  validateDataset,
  validateToken,
} from "./client";

const platform = { graphVersion: "v26.0" };

function captureFetch(body: unknown, status = 200) {
  const state = { url: "", init: null as RequestInit | null };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    state.url = input.toString();
    state.init = init ?? null;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, state };
}

describe("capiRequest appsecret_proof", () => {
  it("sends the token but NO proof when no customer App Secret is configured", async () => {
    const { fetchImpl, state } = captureFetch({ id: "123", name: "DS" });

    await capiRequest("/123", platform, { token: "TOKEN", fetchImpl });

    const url = new URL(state.url);
    expect(url.origin).toBe("https://graph.facebook.com");
    expect(url.pathname).toBe("/v26.0/123");
    expect(url.searchParams.get("access_token")).toBe("TOKEN");
    expect(url.searchParams.has("appsecret_proof")).toBe(false);
  });

  it("treats an empty App Secret as absent (never sends a bogus proof)", async () => {
    const { fetchImpl, state } = captureFetch({});

    await capiRequest("/x", platform, { token: "T", appSecret: "", fetchImpl });

    expect(new URL(state.url).searchParams.has("appsecret_proof")).toBe(false);
  });

  it("derives the proof from the exact token with the provided App Secret", async () => {
    const { fetchImpl, state } = captureFetch({ id: "123" });

    await capiRequest("/123", platform, {
      token: "CUSTOMER_TOKEN",
      appSecret: "CUSTOMER_APP_SECRET",
      fetchImpl,
    });

    const expected = crypto
      .createHmac("sha256", "CUSTOMER_APP_SECRET")
      .update("CUSTOMER_TOKEN")
      .digest("hex");
    expect(new URL(state.url).searchParams.get("appsecret_proof")).toBe(expected);
  });

  it("forwards the App Secret through validateDataset", async () => {
    const { fetchImpl, state } = captureFetch({ id: "123", name: "My Dataset" });

    const info = await validateDataset(platform, "123", "TOKEN", {
      appSecret: "SECRET_X",
      fetchImpl,
    });

    expect(info).toEqual({ id: "123", name: "My Dataset" });
    const expected = crypto
      .createHmac("sha256", "SECRET_X")
      .update("TOKEN")
      .digest("hex");
    expect(new URL(state.url).searchParams.get("appsecret_proof")).toBe(expected);
  });

  it("forwards the App Secret on event sends (POST body preserved)", async () => {
    const { fetchImpl, state } = captureFetch({ events_received: 1 });

    await sendEvents(
      platform,
      "123",
      "TOKEN",
      { data: [{ event_name: "Lead" }] },
      { appSecret: "SECRET_X", fetchImpl },
    );

    expect(state.init?.method).toBe("POST");
    expect(JSON.parse(String(state.init?.body))).toEqual({
      data: [{ event_name: "Lead" }],
    });
    const expected = crypto
      .createHmac("sha256", "SECRET_X")
      .update("TOKEN")
      .digest("hex");
    expect(new URL(state.url).searchParams.get("appsecret_proof")).toBe(expected);
  });

  it("surfaces Meta's appsecret_proof rejection without leaking secrets", async () => {
    const { fetchImpl } = captureFetch(
      {
        error: {
          message: "Invalid appsecret_proof provided in the API argument",
          type: "OAuthException",
          code: 1,
        },
      },
      400,
    );

    await expect(
      validateDataset(platform, "123", "TOKEN", {
        appSecret: "WRONG",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      message: /appsecret_proof/i,
      graphCode: 1,
      graphType: "OAuthException",
    });
  });
});

describe("validateToken", () => {
  it("authenticates via GET /me without touching any dataset", async () => {
    const { fetchImpl, state } = captureFetch({ id: "u1", name: "Tester" });

    const identity = await validateToken(platform, "TOKEN", { fetchImpl });

    expect(identity).toEqual({ id: "u1", name: "Tester" });
    const parsed = new URL(state.url);
    expect(parsed.pathname).toBe("/v26.0/me");
    expect(parsed.searchParams.get("fields")).toBe("id,name");
    expect(state.init?.method).toBe("GET");
    expect(state.init?.body).toBeUndefined();
  });

  it("forwards the customer App Secret for the proof like other calls", async () => {
    const { fetchImpl, state } = captureFetch({ id: "u1" });

    await validateToken(platform, "TOKEN", {
      appSecret: "SECRET_X",
      fetchImpl,
    });

    const expected = crypto
      .createHmac("sha256", "SECRET_X")
      .update("TOKEN")
      .digest("hex");
    expect(new URL(state.url).searchParams.get("appsecret_proof")).toBe(expected);
  });
});

describe("capiRequest error body capture", () => {
  it("attaches the complete Meta response body to the thrown error", async () => {
    const fullBody = {
      error: {
        message: "Invalid parameter",
        type: "OAuthException",
        code: 100,
        error_subcode: 2804001,
        error_data: { blurb: "bad value" },
        fbtrace_id: "TRACE-ABC",
      },
    };
    const { fetchImpl } = captureFetch(fullBody, 400);

    const failure = await sendEvents(platform, "123", "TOKEN", { data: [] }, {
      fetchImpl,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(MetaGraphError);
    const graphErr = failure as MetaGraphError & { graphBody?: unknown };
    expect(graphErr.graphStatus).toBe(400);
    expect(graphErr.graphBody).toEqual(fullBody);
  });

  it("captures raw text when Meta returns a non-JSON error body", async () => {
    const fetchImpl = (async () => {
      return new Response("gateway exploded", {
        status: 502,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;

    const failure = await sendEvents(platform, "123", "TOKEN", { data: [] }, {
      fetchImpl,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    const graphErr = failure as MetaGraphError & { graphBody?: unknown };
    expect(graphErr.graphStatus).toBe(502);
    expect(graphErr.graphBody).toEqual({ raw: "gateway exploded" });
  });
});

describe("describeDatasetAccessError", () => {
  it("never reports a #100 dataset failure as an invalid token", async () => {
    const message = describeDatasetAccessError(
      new MetaGraphError({
        message: "(#100) Missing perms",
        graphType: "OAuthException",
        graphCode: 100,
        graphSubcode: 33,
        graphStatus: 400,
        status: 400,
      }),
      "123",
    );
    expect(message).toMatch(/authenticated, but dataset 123 could not be read/);
    expect(message).not.toMatch(/invalid, expired, or revoked/i);
    expect(message).toMatch(/Graph #100/);
  });

  it("exposes only code, subcode, and type as diagnostic details", () => {
    expect(
      graphDiagnosticRef(
        new MetaGraphError({
          message: "(#100) Missing perms",
          graphType: "OAuthException",
          graphCode: 100,
          graphSubcode: 33,
          graphStatus: 400,
          status: 400,
        }),
      ),
    ).toEqual({ graphCode: 100, graphSubcode: 33, graphType: "OAuthException" });
  });
});

describe("describeCapiVerificationError", () => {
  it("explains an appsecret_proof mismatch actionably", () => {
    const message = describeCapiVerificationError(
      new MetaGraphError({
        message: "Invalid appsecret_proof provided in the API argument",
        graphType: "OAuthException",
        graphCode: 1,
        graphStatus: 400,
        status: 400,
      }),
    );
    expect(message).toMatch(/appsecret_proof/i);
    expect(message).toMatch(/App Secret/i);
    expect(message).toMatch(/different Meta app/i);
  });

  it("explains an invalid or expired token", () => {
    const message = describeCapiVerificationError(
      new MetaGraphError({
        message: "Invalid OAuth access token.",
        graphType: "OAuthException",
        graphCode: 190,
        graphStatus: 400,
        status: 401,
      }),
    );
    expect(message).toMatch(/invalid, expired, or revoked/i);
  });

  it("explains insufficient dataset permissions", () => {
    const message = describeCapiVerificationError(
      new MetaGraphError({
        message: "(#200) Requires ads_management permission",
        graphCode: 200,
        graphStatus: 400,
        status: 400,
      }),
    );
    expect(message).toMatch(/lacks permission/i);
  });
});
