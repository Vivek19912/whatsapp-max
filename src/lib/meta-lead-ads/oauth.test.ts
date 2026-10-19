// Meta Lead Ads — OAuth handshake helpers.
//
// Pins the tenant-binding and response-safety contracts:
//   * state values are unique, hashed, and compared safely;
//   * the authorization URL requests the required scopes and no secret;
//   * callback redirects use only safe statuses/reasons;
//   * page selection accepts only well-formed, bounded page ids.

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import type { MetaLeadAdsConfig } from "./config";
import {
  buildOAuthDialogUrl,
  generateOAuthState,
  hashOAuthState,
  META_LEAD_OAUTH_CALLBACK_PATH,
  normalizeSelectedPageIds,
  oauthSettingsRedirect,
  oauthStatesMatch,
} from "./oauth";

const CONFIG: MetaLeadAdsConfig = {
  appId: "1831465341391155",
  appSecret: "platform-secret",
  webhookVerifyToken: "verify",
  graphVersion: "v26.0",
};

const REQUEST = new Request("https://whatsappmax.in/api/integrations/meta-lead-ads/oauth/connect");

describe("OAuth state", () => {
  it("generates unique states and stores only hashes", () => {
    const first = generateOAuthState();
    const second = generateOAuthState();

    expect(first).not.toBe(second);
    expect(hashOAuthState(first)).toHaveLength(64);
    expect(hashOAuthState(first)).toBe(
      crypto.createHash("sha256").update(first, "utf8").digest("hex"),
    );
    expect(hashOAuthState(first)).not.toContain(first);
  });

  it("compares raw states safely", () => {
    expect(oauthStatesMatch("abc", "abc")).toBe(true);
    expect(oauthStatesMatch("abc", "abd")).toBe(false);
    expect(oauthStatesMatch("abc", "abcd")).toBe(false);
    expect(oauthStatesMatch("", "")).toBe(false);
  });
});

describe("OAuth dialog URL", () => {
  it("requests the required scopes and callback without secrets", () => {
    const state = generateOAuthState();
    const url = new URL(
      buildOAuthDialogUrl(CONFIG, "https://whatsappmax.in/api/x/callback", state),
    );

    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v26.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("1831465341391155");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe(state);
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toEqual(
      expect.arrayContaining([
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_metadata",
        "leads_retrieval",
        "ads_management",
      ]),
    );
    expect(url.toString()).not.toContain("platform-secret");
  });
});

describe("OAuth settings redirect", () => {
  it("accepts only safe statuses and reasons", () => {
    const ok = oauthSettingsRedirect(REQUEST, "select");
    expect(ok.pathname).toBe("/settings");
    expect(ok.searchParams.get("tab")).toBe("meta-lead-ads");
    expect(ok.searchParams.get("meta_oauth")).toBe("select");

    const bad = oauthSettingsRedirect(
      REQUEST,
      "error",
      "'); DROP TABLE accounts; --",
    );
    expect(bad.searchParams.get("meta_oauth")).toBe("error");
    expect(bad.searchParams.has("meta_oauth_error")).toBe(false);
  });

  it("uses the fixed callback path", () => {
    expect(META_LEAD_OAUTH_CALLBACK_PATH).toBe(
      "/api/integrations/meta-lead-ads/oauth/callback",
    );
  });
});

describe("normalizeSelectedPageIds", () => {
  it("accepts only numeric ids and bounds the selection", () => {
    const ids = normalizeSelectedPageIds([
      "1029384756",
      " my-page ",
      123,
      "1029384756",
      ...Array.from({ length: 30 }, (_, i) => String(2000000000 + i)),
    ]);

    expect(ids[0]).toBe("1029384756");
    expect(ids).not.toContain("my-page");
    expect(ids.length).toBeLessThanOrEqual(25);
  });
});
