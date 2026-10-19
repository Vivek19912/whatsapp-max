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
  sendEvents,
  validateDataset,
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
