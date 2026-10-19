// Meta Lead Ads — read-only status endpoint.
//
// Pins the production regression: refreshing Settings must NOT change
// the stored credential or flip a healthy connection to
// "needs_attention". The status route is a pure read (no Graph calls,
// no writes), so repeated polling is safe.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  connection: null as Record<string, unknown> | null,
  pages: [] as Array<Record<string, unknown>>,
  forms: [] as Array<Record<string, unknown>>,
  lastSync: [] as Array<Record<string, unknown>>,
  writes: [] as string[],
}));

function makeDb() {
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      update: () => {
        h.writes.push(`update:${table}`);
        return b;
      },
      insert: () => {
        h.writes.push(`insert:${table}`);
        return b;
      },
      upsert: () => {
        h.writes.push(`upsert:${table}`);
        return b;
      },
      maybeSingle: async () => ({
        data: table === "meta_lead_connections" ? h.connection : null,
        error: null,
      }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        const rows =
          table === "meta_lead_pages"
            ? h.pages
            : table === "meta_lead_forms"
              ? h.forms
              : table === "meta_lead_submissions"
                ? h.lastSync
                : [];
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: makeDb(),
    accountId: "acct-1",
    userId: "user-1",
  }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/meta-capi/store", () => ({
  getConfig: async () => null,
}));

vi.mock("@/lib/meta-lead-ads/config", () => ({
  metaLeadAdsConfigured: () => true,
}));

const { GET } = await import("./route");

beforeEach(() => {
  h.connection = {
    dataset_id: "1234567890",
    meta_user_name: "Page",
    status: "connected",
    scopes: "leads_retrieval,pages_manage_metadata",
    token_expiry: null,
    last_error: null,
    updated_at: "2026-01-01T00:00:00Z",
    access_token: "enc-stored-ciphertext",
  };
  h.pages = [
    {
      page_id: "P1",
      page_name: "Page",
      subscribed: true,
      webhook_verified: true,
      last_error: null,
      last_synced_at: "2026-01-01T00:00:00Z",
      last_polled_at: "2026-01-01T00:00:00Z",
    },
  ];
  h.forms = [
    { id: "form-1", enabled: true, import_status: "done", imported_count: 1 },
  ];
  h.lastSync = [{ processed_at: "2026-01-01T00:00:00Z" }];
  h.writes = [];
});

describe("GET /status", () => {
  it("keeps a valid token connected across repeated refreshes and never exposes it", async () => {
    const first = (await (await GET()).json()) as Record<string, unknown>;
    const second = (await (await GET()).json()) as Record<string, unknown>;

    expect(first.status).toBe("connected");
    expect(second.status).toBe("connected");
    expect(first.connected).toBe(true);
    expect(first.hasToken).toBe(true);
    expect(first.tokenSource).toBe("manual");

    // The ciphertext is untouched, and the response never carries it.
    expect(h.connection?.access_token).toBe("enc-stored-ciphertext");
    expect(JSON.stringify(first)).not.toContain("enc-stored-ciphertext");

    // A read-only status check performs no writes.
    expect(h.writes).toEqual([]);
  });

  it("reports an OAuth connection's provenance without exposing the token", async () => {
    h.connection = {
      ...h.connection,
      setup_source: "oauth",
      token_app_id: "1831465341391155",
      token_type: "USER",
      scopes: "pages_show_list,leads_retrieval",
    };
    const json = (await (await GET()).json()) as Record<string, unknown>;

    expect(json.tokenSource).toBe("oauth");
    expect((json.account as Record<string, unknown>).setupSource).toBe("oauth");
    expect((json.account as Record<string, unknown>).tokenAppId).toBe(
      "1831465341391155",
    );
    expect(JSON.stringify(json)).not.toContain("enc-stored-ciphertext");
  });

  it("reports a definitively revoked connection honestly", async () => {
    h.connection = { ...h.connection, status: "needs_reauth" };
    const json = (await (await GET()).json()) as Record<string, unknown>;
    expect(json.status).toBe("needs_reauth");
    expect(h.writes).toEqual([]);
  });
});
