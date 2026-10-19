// Meta Lead Ads — manual credentials route.
//
// Pins the security + reuse contracts:
//   * the raw token is never returned to the browser;
//   * Dataset ID + Page ID are validated before any Meta call;
//   * a Page owned by another account is rejected generically;
//   * a stored Conversions API token is reused server-side when the
//     caller leaves the token blank (no second copy/paste);
//   * the credentials are always written under the caller's account.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  foreign: [] as Array<Record<string, unknown>>,
  connection: null as Record<string, unknown> | null,
  pages: [] as Array<Record<string, unknown>>,
  capi: null as Record<string, unknown> | null,
  capiToken: null as string | null,
  saved: [] as Array<Record<string, unknown>>,
  connectCalls: [] as Array<Record<string, unknown>>,
  connectError: null as unknown,
  connected: {
    pageId: "P1",
    pageName: "My Page",
    subscribed: true,
    webhookVerified: true,
    warning: null,
  },
}));

function rlsClient() {
  function builder(table: string) {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        if (table === "meta_lead_connections") {
          return { data: h.connection, error: null };
        }
        return { data: h.pages[0] ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({
          data: table === "meta_lead_pages" ? h.pages : [],
          error: null,
        }).then(res, rej),
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

function adminClient() {
  function builder() {
    const b = {
      select: () => b,
      eq: () => b,
      neq: () => b,
      limit: async () => ({ data: h.foreign, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: h.foreign, error: null }).then(res, rej),
    };
    return b;
  }
  return { from: () => builder() } as unknown as SupabaseClient;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: rlsClient(),
    accountId: h.accountId,
    userId: "user-1",
  }),
  requireRole: async () => ({
    supabase: rlsClient(),
    accountId: h.accountId,
    userId: "user-1",
  }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => adminClient(),
}));

vi.mock("@/lib/meta-capi/store", () => ({
  getConfig: async () => h.capi,
  getDecryptedToken: async () => h.capiToken,
}));

vi.mock("@/lib/meta-lead-ads/connect-page", () => ({
  connectPage: async (_db: unknown, _config: unknown, args: Record<string, unknown>) => {
    h.connectCalls.push(args);
    if (h.connectError) throw h.connectError;
    return h.connected;
  },
}));

vi.mock("@/lib/meta-lead-ads/store", () => ({
  getConnection: async () => h.connection,
  saveCredentials: async (
    _db: unknown,
    accountId: string,
    input: Record<string, unknown>,
  ) => {
    h.saved.push({ accountId, ...input });
  },
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (value: string) => `decrypted:${value}`,
}));

const { GET, POST } = await import("./route");

const post = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-lead-ads/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.accountId = "acct-1";
  h.foreign = [];
  h.connection = null;
  h.pages = [];
  h.capi = null;
  h.capiToken = null;
  h.saved = [];
  h.connectCalls = [];
  h.connectError = null;
  h.connected = {
    pageId: "P1",
    pageName: "My Page",
    subscribed: true,
    webhookVerified: true,
    warning: null,
  };
  process.env.META_LEAD_ADS_APP_ID = "1";
  process.env.META_LEAD_ADS_APP_SECRET = "secret";
  process.env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.META_GRAPH_VERSION = "v21.0";
});

describe("POST /credentials — validation", () => {
  it("requires a Page ID", async () => {
    const res = await POST(post({ dataset_id: "1234567890", access_token: "x".repeat(30) }));
    expect(res.status).toBe(400);
    expect(h.connectCalls).toHaveLength(0);
  });

  it("requires a dataset when neither this account nor CAPI has one", async () => {
    const res = await POST(post({ page_id: "1029384756", access_token: "x".repeat(30) }));
    expect(res.status).toBe(400);
    expect(h.connectCalls).toHaveLength(0);
  });

  it("requires a token when neither this account nor CAPI has one", async () => {
    h.capi = { dataset_id: "1234567890", access_token: null };
    const res = await POST(post({ page_id: "1029384756", dataset_id: "1234567890" }));
    expect(res.status).toBe(400);
    expect(h.connectCalls).toHaveLength(0);
  });

  it("rejects a Page owned by another account before touching Meta", async () => {
    h.foreign = [{ account_id: "acct-2" }];
    const res = await POST(
      post({
        dataset_id: "1234567890",
        access_token: "x".repeat(30),
        page_id: "1029384756",
      }),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe("page_already_connected");
    expect(JSON.stringify(json)).not.toContain("acct-2");
    expect(h.connectCalls).toHaveLength(0);
  });
});

describe("POST /credentials — save", () => {
  it("verifies the Page and stores the credentials under the caller's account", async () => {
    const token = "system-user-token-1234567890";
    const res = await POST(
      post({ dataset_id: "1234567890", access_token: token, page_id: "1029384756" }),
    );

    expect(res.status).toBe(200);
    expect(h.connectCalls[0]).toMatchObject({
      accountId: "acct-1",
      token,
      pageId: "1029384756",
    });
    expect(h.saved).toEqual([
      {
        accountId: "acct-1",
        accessToken: token,
        datasetId: "1234567890",
        pageName: "My Page",
        connectedBy: "user-1",
      },
    ]);
    // The secret must never be echoed back.
    expect(JSON.stringify(await res.json())).not.toContain(token);
  });

  it("reuses the Conversions API token server-side when the token is blank", async () => {
    h.capi = { dataset_id: "99887766", access_token: "enc-capi" };
    h.capiToken = "capi-token-abcdefghijklmnop";

    const res = await POST(post({ page_id: "1029384756" }));
    expect(res.status).toBe(200);

    expect(h.connectCalls[0]).toMatchObject({
      accountId: "acct-1",
      token: "capi-token-abcdefghijklmnop",
    });
    expect(h.saved[0]).toMatchObject({
      accountId: "acct-1",
      datasetId: "99887766",
      accessToken: "capi-token-abcdefghijklmnop",
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.tokenSource).toBe("capi");
  });

  it("preserves the stored manual token when the token field is blank", async () => {
    h.connection = {
      dataset_id: "1234567890",
      meta_user_name: "My Page",
      status: "needs_reauth",
      last_error: "Meta authorization expired or was revoked.",
      updated_at: "2026-01-01T00:00:00Z",
      access_token: "enc-manual-token",
    };

    const res = await POST(
      post({ dataset_id: "1234567890", page_id: "1029384756" }),
    );
    expect(res.status).toBe(200);

    // The server decrypted and re-verified the EXISTING token; the
    // customer did not have to paste it again.
    expect(h.connectCalls[0]).toMatchObject({
      accountId: "acct-1",
      token: "decrypted:enc-manual-token",
    });
    expect(h.saved[0]).toMatchObject({
      accountId: "acct-1",
      accessToken: "decrypted:enc-manual-token",
    });
  });

  it("maps a unique violation from connectPage to the generic conflict", async () => {
    h.connectError = {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    };

    const res = await POST(
      post({
        dataset_id: "1234567890",
        access_token: "x".repeat(30),
        page_id: "1029384756",
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).code).toBe(
      "page_already_connected",
    );
  });
});

describe("GET /credentials — public shape", () => {
  it("never returns the stored token", async () => {
    h.connection = {
      dataset_id: "1234567890",
      meta_user_name: "My Page",
      status: "connected",
      last_error: null,
      updated_at: "2026-01-01T00:00:00Z",
      access_token: "enc-token",
    };
    h.pages = [
      {
        page_id: "P1",
        page_name: "My Page",
        subscribed: true,
        webhook_verified: true,
        last_error: null,
        last_synced_at: null,
        last_polled_at: null,
      },
    ];

    const res = await GET();
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.connected).toBe(true);
    expect(json.hasToken).toBe(true);
    expect(json.tokenSource).toBe("manual");
    expect(JSON.stringify(json)).not.toContain("enc-token");
  });
});
