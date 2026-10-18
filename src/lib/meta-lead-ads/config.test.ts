import { describe, expect, it } from "vitest";

import {
  graphBase,
  metaLeadAdsConfig,
  metaLeadAdsConfigured,
  oauthBase,
  redirectUriFromRequest,
} from "./config";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    META_LEAD_ADS_APP_ID: "1234567890",
    META_LEAD_ADS_APP_SECRET: "super-secret",
    META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN: "verify-me",
    META_GRAPH_VERSION: "v21.0",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

describe("metaLeadAdsConfig", () => {
  it("returns the resolved config when every value is present", () => {
    expect(metaLeadAdsConfig(env())).toEqual({
      appId: "1234567890",
      appSecret: "super-secret",
      webhookVerifyToken: "verify-me",
      graphVersion: "v21.0",
    });
    expect(metaLeadAdsConfigured(env())).toBe(true);
  });

  it("is null when any required value is missing", () => {
    for (const key of [
      "META_LEAD_ADS_APP_ID",
      "META_LEAD_ADS_APP_SECRET",
      "META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN",
      "META_GRAPH_VERSION",
    ]) {
      expect(metaLeadAdsConfig(env({ [key]: undefined }))).toBeNull();
      expect(metaLeadAdsConfig(env({ [key]: "" }))).toBeNull();
    }
    expect(metaLeadAdsConfigured(env({ META_LEAD_ADS_APP_ID: undefined }))).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const cfg = metaLeadAdsConfig(env({ META_LEAD_ADS_APP_ID: "  123  " }));
    expect(cfg?.appId).toBe("123");
  });

  it("rejects a malformed Graph version (never bake in a version)", () => {
    expect(metaLeadAdsConfig(env({ META_GRAPH_VERSION: "21.0" }))).toBeNull();
    expect(metaLeadAdsConfig(env({ META_GRAPH_VERSION: "latest" }))).toBeNull();
    expect(metaLeadAdsConfig(env({ META_GRAPH_VERSION: "v21" }))).toBeNull();
    expect(metaLeadAdsConfig(env({ META_GRAPH_VERSION: "v21.0" }))?.graphVersion).toBe(
      "v21.0",
    );
  });
});

describe("graph/oauth bases", () => {
  it("version the host roots", () => {
    expect(graphBase("v21.0")).toBe("https://graph.facebook.com/v21.0");
    expect(oauthBase("v20.0")).toBe("https://www.facebook.com/v20.0/dialog/oauth");
  });
});

describe("redirectUriFromRequest", () => {
  it("derives the callback URL from forwarded headers", () => {
    const req = new Request("https://internal.local/api", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" },
    });
    expect(redirectUriFromRequest(req)).toBe(
      "https://app.example.com/api/integrations/meta-lead-ads/callback",
    );
  });
});
