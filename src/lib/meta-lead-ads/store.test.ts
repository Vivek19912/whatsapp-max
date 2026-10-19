// Meta Lead Ads — store tenant-boundary contracts.
//
// `getPageToken` must NEVER fall back to the account's user token for a
// Page the account has not connected: that would let one tenant read
// another tenant's Page leads. It only falls back when a connected Page
// row exists but Meta omitted a Page token.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp/encryption", () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ""),
}));

import { MetaLeadAdsError } from "./errors";
import { getPageToken } from "./store";

function makeDb(tables: Record<string, Array<Record<string, unknown>>>): SupabaseClient {
  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const matched = () =>
      (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const b = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

describe("getPageToken", () => {
  it("refuses a Page this account has not connected", async () => {
    const db = makeDb({
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1", access_token: "enc:pt" }],
      meta_lead_connections: [{ account_id: "acct-1", access_token: "enc:ut" }],
    });

    await expect(getPageToken(db, "acct-1", "P-OTHER")).rejects.toMatchObject({
      name: "MetaLeadAdsError",
      code: "page_not_found",
    });
    await expect(getPageToken(db, "acct-2", "P1")).rejects.toBeInstanceOf(
      MetaLeadAdsError,
    );
  });

  it("returns the decrypted Page token for a connected Page", async () => {
    const db = makeDb({
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1", access_token: "enc:pt" }],
    });
    await expect(getPageToken(db, "acct-1", "P1")).resolves.toBe("pt");
  });

  it("falls back to the user token only when the Page row exists without one", async () => {
    const db = makeDb({
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1", access_token: null }],
      meta_lead_connections: [{ account_id: "acct-1", access_token: "enc:ut" }],
    });
    await expect(getPageToken(db, "acct-1", "P1")).resolves.toBe("ut");
  });
});
