// Meta Lead Ads — store contracts.
//
//   * `getPageToken` must NEVER fall back to the account's user token
//     for a Page the account has not connected (tenant isolation).
//   * `markNeedsReauth` may only downgrade a connected row, and only
//     when it is still the row the caller observed (no stale worker
//     overwriting a freshly re-saved token).
//   * `saveCredentials` encrypts at rest and never touches leads.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp/encryption", () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ""),
}));

import { MetaLeadAdsError } from "./errors";
import {
  getPageToken,
  markNeedsReauth,
  saveCredentials,
  saveOAuthConnection,
} from "./store";

type Row = Record<string, unknown>;

interface Write {
  table: string;
  op: string;
  payload: Row;
  filters: Array<[string, unknown]>;
}

function makeDb(initial: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    tables[table] = rows.map((r) => ({ ...r }));
  }
  const writes: Write[] = [];

  function builder(table: string) {
    let op: "select" | "update" | "upsert" | "insert" = "select";
    let payload: Row = {};
    const filters: Array<[string, unknown]> = [];

    const matched = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every(([c, v]) => r[c] === v),
      );

    const run = () => {
      if (op === "select") return { data: matched(), error: null };
      writes.push({ table, op, payload: { ...payload }, filters: [...filters] });
      if (op === "update") {
        for (const row of matched()) Object.assign(row, payload);
        return { data: null, error: null };
      }
      if (op === "upsert" || op === "insert") {
        const key = table === "meta_lead_connections" ? "account_id" : "id";
        const existing = (tables[table] ?? []).find(
          (r) => r[key] === payload[key],
        );
        if (existing) Object.assign(existing, payload);
        else {
          if (!tables[table]) tables[table] = [];
          tables[table].push({ ...payload });
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Row) => {
        op = "update";
        payload = p;
        return b;
      },
      insert: (p: Row) => {
        op = "insert";
        payload = p;
        return b;
      },
      upsert: (p: Row) => {
        op = "upsert";
        payload = p;
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  return {
    db: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    tables,
    writes,
  };
}

const connected = (updatedAt: string): Row => ({
  account_id: "acct-1",
  access_token: "enc:old-token",
  status: "connected",
  last_error: null,
  updated_at: updatedAt,
});

describe("getPageToken", () => {
  it("refuses a Page this account has not connected", async () => {
    const { db } = makeDb({
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

  it("returns the decrypted Page token for a connected Page (never another tenant's)", async () => {
    const { db } = makeDb({
      meta_lead_pages: [
        { account_id: "acct-1", page_id: "P1", access_token: "enc:pt" },
        { account_id: "acct-2", page_id: "P1", access_token: "enc:other" },
      ],
    });
    await expect(getPageToken(db, "acct-1", "P1")).resolves.toBe("pt");
  });

  it("falls back to the user token only when the Page row exists without one", async () => {
    const { db } = makeDb({
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1", access_token: null }],
      meta_lead_connections: [{ account_id: "acct-1", access_token: "enc:ut" }],
    });
    await expect(getPageToken(db, "acct-1", "P1")).resolves.toBe("ut");
  });
});

describe("markNeedsReauth", () => {
  it("marks the observed connected row", async () => {
    const { db, tables } = makeDb({
      meta_lead_connections: [connected("2026-01-01T00:00:00Z")],
    });

    await markNeedsReauth(db, "acct-1", "revoked", {
      expectedUpdatedAt: "2026-01-01T00:00:00Z",
    });

    expect(tables.meta_lead_connections[0]).toMatchObject({
      status: "needs_reauth",
      last_error: "revoked",
    });
  });

  it("does NOT overwrite a connection that was re-saved after the attempt started", async () => {
    const { db, tables } = makeDb({
      meta_lead_connections: [
        {
          account_id: "acct-1",
          access_token: "enc:new-token",
          status: "connected",
          last_error: null,
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    await markNeedsReauth(db, "acct-1", "revoked", {
      expectedUpdatedAt: "2026-01-01T00:00:00Z",
    });

    expect(tables.meta_lead_connections[0]).toMatchObject({
      status: "connected",
      last_error: null,
      access_token: "enc:new-token",
    });
  });

  it("never revives a revoked row or re-flags an already-flagged row", async () => {
    const { db, tables } = makeDb({
      meta_lead_connections: [
        { ...connected("2026-01-01T00:00:00Z"), status: "needs_reauth" },
      ],
    });

    await markNeedsReauth(db, "acct-1", "again", {
      expectedUpdatedAt: "2026-01-01T00:00:00Z",
    });

    expect(tables.meta_lead_connections[0]).toMatchObject({
      status: "needs_reauth",
      last_error: null,
    });
  });
});

describe("saveCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("encrypts the token at rest and preserves existing leads/runs", async () => {
    const { db, tables } = makeDb({
      meta_lead_connections: [],
      meta_lead_submissions: [
        { id: "sub-1", account_id: "acct-1", meta_lead_id: "L1", status: "processed" },
      ],
      flow_runs: [{ id: "run-1", account_id: "acct-1", status: "completed" }],
    });

    await saveCredentials(db, "acct-1", {
      accessToken: "secret-token",
      datasetId: "123",
      pageName: "Page",
      connectedBy: "user-1",
    });

    expect(tables.meta_lead_connections[0]).toMatchObject({
      account_id: "acct-1",
      access_token: "enc:secret-token",
      status: "connected",
      last_error: null,
    });
    // Replacement only rewrites the connection row.
    expect(tables.meta_lead_submissions).toEqual([
      { id: "sub-1", account_id: "acct-1", meta_lead_id: "L1", status: "processed" },
    ]);
    expect(tables.flow_runs).toEqual([
      { id: "run-1", account_id: "acct-1", status: "completed" },
    ]);
    // Never stored in plaintext.
    expect(JSON.stringify(tables)).not.toContain('"secret-token"');
  });

  it("stores an OAuth connection with provenance and preserves an existing dataset", async () => {
    const { db, tables } = makeDb({
      meta_lead_connections: [
        { ...connected("2026-01-01T00:00:00Z"), dataset_id: "D1" },
      ],
    });

    await saveOAuthConnection(db, "acct-1", {
      accessToken: "oauth-token",
      tokenExpiry: "2026-04-01T00:00:00.000Z",
      scopes: ["pages_show_list", "ads_management"],
      metaUserId: "U1",
      metaUserName: "Olive",
      tokenAppId: "1",
      tokenType: "USER",
      datasetId: undefined,
      connectedBy: "user-1",
    });

    expect(tables.meta_lead_connections[0]).toMatchObject({
      account_id: "acct-1",
      dataset_id: "D1",
      setup_source: "oauth",
      token_app_id: "1",
      token_type: "USER",
      scopes: "pages_show_list,ads_management",
      status: "connected",
    });
    expect(JSON.stringify(tables)).not.toContain('"oauth-token"');
  });
});
