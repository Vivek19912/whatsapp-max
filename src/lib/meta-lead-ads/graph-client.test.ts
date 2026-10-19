// Meta Lead Ads — Graph client URL + capability contracts.
//
// These pin the fixes for the production failures:
//   * the Page read must NOT request the invalid `tasks` field
//     ("#100 Tried accessing nonexistent field (tasks)");
//   * no `appsecret_proof` is sent unless a MATCHING app secret is
//     supplied (a wrong proof is fatal);
//   * Load My Forms walks pagination instead of truncating at 100;
//   * dataset + lead-retrieval probes hit the documented endpoints.

import { describe, expect, it, vi } from "vitest";

import type { MetaLeadAdsConfig } from "./config";
import {
  getDataset,
  getPage,
  listForms,
  probeFormLeadAccess,
} from "./graph-client";

const CONFIG: MetaLeadAdsConfig = {
  appId: "1",
  appSecret: "platform-secret",
  webhookVerifyToken: "verify",
  graphVersion: "v21.0",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getPage", () => {
  it("requests only fields that exist on the Page node (never `tasks`)", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({ id: "P1", name: "My Page", access_token: "pt" });
    }) as unknown as typeof fetch;

    const page = await getPage(CONFIG, "user-token", "P1", { fetchImpl });

    expect(page.id).toBe("P1");
    const parsed = new URL(urls[0]);
    expect(parsed.pathname).toBe("/v21.0/P1");
    const fields = parsed.searchParams.get("fields") ?? "";
    expect(fields.split(",")).toEqual(["id", "name", "access_token"]);
    expect(fields).not.toContain("tasks");
    // No app secret supplied → no proof (a wrong proof is fatal).
    expect(parsed.searchParams.has("appsecret_proof")).toBe(false);
  });

  it("sends appsecret_proof only when an app secret is supplied", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({ id: "P1" });
    }) as unknown as typeof fetch;

    await getPage(CONFIG, "tok", "P1", {
      fetchImpl,
      appSecret: "matching-secret",
    });
    const parsed = new URL(urls[0]);
    expect(parsed.searchParams.get("appsecret_proof")).toBeTruthy();
  });
});

describe("listForms", () => {
  it("follows pagination instead of truncating at one page", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      const after = new URL(url).searchParams.get("after");
      if (!after) {
        return jsonResponse({
          data: [{ id: "F1", name: "One" }],
          paging: { cursors: { after: "c1" } },
        });
      }
      return jsonResponse({
        data: [{ id: "F2", name: "Two" }],
        paging: { cursors: { after: "c2" } },
      });
    }) as unknown as typeof fetch;

    const forms = await listForms(CONFIG, "pt", "P1", { fetchImpl, maxPages: 2 });

    expect(forms.map((f) => f.id)).toEqual(["F1", "F2"]);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get("after")).toBe("c1");
  });
});

describe("getDataset", () => {
  it("reads the dataset by id", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({ id: "D1", name: "Pixel" });
    }) as unknown as typeof fetch;

    const dataset = await getDataset(CONFIG, "tok", "D1", { fetchImpl });
    expect(dataset.name).toBe("Pixel");
    expect(new URL(urls[0]).pathname).toBe("/v21.0/D1");
    expect(new URL(urls[0]).searchParams.get("fields")).toBe("id,name");
  });
});

describe("probeFormLeadAccess", () => {
  it("hits the form leads edge with a minimal field set", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    const ok = await probeFormLeadAccess(CONFIG, "pt", "F1", { fetchImpl });
    expect(ok).toBe(true);
    const parsed = new URL(urls[0]);
    expect(parsed.pathname).toBe("/v21.0/F1/leads");
    expect(parsed.searchParams.get("limit")).toBe("1");
  });
});
