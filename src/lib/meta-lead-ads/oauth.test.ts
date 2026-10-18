import { describe, expect, it } from "vitest";

import type { MetaLeadAdsConfig } from "./config";
import {
  OAUTH_STATE_TTL_MS,
  buildAuthUrl,
  encodeOAuthState,
  newStateNonce,
  parseOAuthState,
} from "./oauth";

const CONFIG: MetaLeadAdsConfig = {
  appId: "1234567890",
  appSecret: "secret",
  webhookVerifyToken: "verify",
  graphVersion: "v21.0",
};

describe("OAuth state", () => {
  it("round-trips account + nonce through encryption", () => {
    const state = encodeOAuthState("acct-1", "nonce-abc", 1_000);
    expect(state).not.toContain("acct-1");
    expect(parseOAuthState(state, 1_000 + 1)).toEqual({
      accountId: "acct-1",
      nonce: "nonce-abc",
    });
  });

  it("rejects tampered or garbage state", () => {
    expect(() => parseOAuthState("not-encrypted")).toThrowError(/verified/);
  });

  it("rejects expired state and far-future timestamps", () => {
    const issued = 10_000_000;
    const state = encodeOAuthState("acct-1", "n", issued);
    expect(() => parseOAuthState(state, issued + OAUTH_STATE_TTL_MS + 1)).toThrowError(
      /expired/,
    );
    expect(() => parseOAuthState(state, issued - 120_000)).toThrowError(/expired/);
  });

  it("produces distinct nonces", () => {
    expect(newStateNonce()).not.toBe(newStateNonce());
  });
});

describe("buildAuthUrl", () => {
  it("targets the versioned dialog with scopes + an encrypted state", () => {
    const url = new URL(buildAuthUrl(CONFIG, "acct-1", "https://app.example.com/cb", "n1"));
    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/v21.0/dialog/oauth",
    );
    expect(url.searchParams.get("client_id")).toBe("1234567890");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/cb");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("leads_retrieval");
    expect(parseOAuthState(url.searchParams.get("state") as string).accountId).toBe(
      "acct-1",
    );
  });
});
