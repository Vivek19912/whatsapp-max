// Meta Lead Ads — OAuth and subscription Graph contracts.
//
// Uses injected fetch fixtures only: no production Meta calls.
//   * token exchange maps Graph errors safely;
//   * page discovery returns metadata without requesting Page tokens;
//   * app-level and Page-level subscription checks require our app id;
//   * subscription success accepts Meta's boolean/string shapes.

import { describe, expect, it, vi } from "vitest";

import type { MetaLeadAdsConfig } from "./config";
import {
  debugToken,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getAppPageSubscriptions,
  inspectPageSubscriptions,
  listManagedPages,
  subscribePageToLeadgen,
} from "./graph-client";

const CONFIG: MetaLeadAdsConfig = {
  appId: "1",
  appSecret: "platform-secret",
  webhookVerifyToken: "verify",
  graphVersion: "v26.0",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OAuth token exchange", () => {
  it("exchanges a code without exposing the client secret in test assertions", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({
        access_token: "user-token",
        token_type: "bearer",
        expires_in: 3600,
        scope: "pages_show_list,leads_retrieval",
      });
    }) as unknown as typeof fetch;

    const grant = await exchangeCodeForToken(
      CONFIG,
      "auth-code",
      "https://app.test/callback",
      fetchImpl,
    );

    expect(grant.accessToken).toBe("user-token");
    expect(grant.scopes).toEqual(["pages_show_list", "leads_retrieval"]);
    expect(Date.parse(grant.expiresAt ?? "")).toBeGreaterThan(Date.now());
    const parsed = new URL(urls[0]);
    expect(parsed.pathname).toBe("/v26.0/oauth/access_token");
    expect(parsed.searchParams.get("code")).toBe("auth-code");
  });

  it("maps a Graph exchange failure to exchange_failed with code/subcode", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            message: "(#100) Invalid verification code format.",
            type: "OAuthException",
            code: 100,
          },
        },
        400,
      ),
    ) as unknown as typeof fetch;

    await expect(
      exchangeCodeForToken(CONFIG, "bad", "https://app.test/callback", fetchImpl),
    ).rejects.toMatchObject({ code: "exchange_failed", graphCode: 100 });
  });

  it("upgrades to a long-lived token when Meta supports it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: "long-token", expires_in: 5184000 }),
    ) as unknown as typeof fetch;

    const grant = await exchangeForLongLivedToken(CONFIG, "short-token", fetchImpl);
    expect(grant.accessToken).toBe("long-token");
    expect(Date.parse(grant.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });
});

describe("managed page discovery", () => {
  it("requests metadata only and ignores embedded Page tokens", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({
        data: [
          { id: "P1", name: "One", tasks: ["MANAGE"], access_token: "secret-pt" },
          { id: "", name: "Bad" },
        ],
      });
    }) as unknown as typeof fetch;

    const pages = await listManagedPages(CONFIG, "user-token", { fetchImpl });

    expect(pages).toEqual([{ id: "P1", name: "One", tasks: ["MANAGE"] }]);
    const parsed = new URL(urls[0]);
    expect(parsed.pathname).toBe("/v26.0/me/accounts");
    expect(parsed.searchParams.get("fields")).toBe("id,name,tasks");
  });
});

describe("subscription verification", () => {
  it("requires leadgen at app level", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            object: "page",
            callback_url: "https://app.test/webhook",
            fields: [{ name: "leadgen" }, { name: "feed" }],
          },
          { object: "instagram", fields: [{ name: "comments" }] },
        ],
      }),
    ) as unknown as typeof fetch;

    const app = await getAppPageSubscriptions(CONFIG, { fetchImpl });
    expect(app).toMatchObject({ configured: true, fields: ["leadgen", "feed"] });
  });

  it("requires our app id in the Page readback", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "2", name: "Other", subscribed_fields: ["leadgen"] },
          { id: "1", name: "Ours", subscribed_fields: ["feed"] },
        ],
      }),
    ) as unknown as typeof fetch;

    const inspection = await inspectPageSubscriptions(CONFIG, "pt", "P1", {
      fetchImpl,
    });
    expect(inspection.subscribed).toBe(false);
    expect(inspection.appIdMatched).toBe(false);
  });

  it("accepts Meta's string success shape", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: "true" }),
    ) as unknown as typeof fetch;

    await expect(
      subscribePageToLeadgen(CONFIG, "pt", "P1", { fetchImpl }),
    ).resolves.toBe(true);
  });

  it("reports the token's issuing app", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          is_valid: true,
          app_id: "1",
          scopes: ["pages_show_list"],
          type: "USER",
          user_id: "U1",
        },
      }),
    ) as unknown as typeof fetch;

    const info = await debugToken(CONFIG, "user-token", { fetchImpl });
    expect(info).toMatchObject({ isValid: true, appId: "1", type: "USER" });
  });
});
