// Meta Lead Ads — processing must not invalidate a healthy credential.
//
// Regression for the production bug: a `#100` invalid-field response
// (which Meta labels `type: "OAuthException"`) was classified as an
// authentication failure, so a background retry overwrote a valid
// connection with `needs_reauth` and Settings showed "Token needs
// attention" after a refresh. Only a definitive token rejection
// (#190/#102/#463) may do that, and a stale worker may never overwrite
// a token the customer re-saved in the meantime.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetaGraphError } from "./errors";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  leadError: null as unknown,
  onLead: null as (() => void) | null,
}));

vi.mock("./graph-client", () => ({
  getLead: async () => {
    h.onLead?.();
    if (h.leadError) throw h.leadError;
    return { id: "L1", platform: "facebook", field_data: [] };
  },
}));

vi.mock("@/lib/meta-capi/triggers", () => ({
  onMetaLeadReceived: async () => {},
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ""),
}));

function makeDb(initial: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    tables[table] = rows.map((r) => ({ ...r }));
  }
  const writes: Array<{ table: string; payload: Row }> = [];

  function builder(table: string) {
    let op: "select" | "update" | "insert" = "select";
    let payload: Row = {};
    const filters: Array<[string, unknown, boolean]> = [];

    const matched = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every(([c, v, negate]) => (negate ? r[c] !== v : r[c] === v)),
      );

    const apply = () => {
      if (op !== "update") return { data: matched(), error: null };
      writes.push({ table, payload: { ...payload } });
      const rows = matched();
      for (const row of rows) Object.assign(row, payload);
      return { data: rows, error: null };
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
      eq: (c: string, v: unknown) => {
        filters.push([c, v, false]);
        return b;
      },
      neq: (c: string, v: unknown) => {
        filters.push([c, v, true]);
        return b;
      },
      or: () => b,
      is: () => b,
      not: () => b,
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        const r = apply();
        return { data: (r.data as Row[] | null)?.[0] ?? null, error: null };
      },
      single: async () => {
        const r = apply();
        return { data: (r.data as Row[] | null)?.[0] ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(apply()).then(res, rej),
    };
    return b;
  }

  return { db: { from: (t: string) => builder(t) } as unknown as SupabaseClient, tables, writes };
}

function seed() {
  return makeDb({
    meta_lead_submissions: [
      {
        id: "sub-1",
        account_id: "acct-1",
        meta_lead_id: "L1",
        page_id: "P1",
        form_id: "F1",
        form_name: "Form",
        status: "failed",
        attempts: 1,
        claimed_at: null,
      },
    ],
    meta_lead_pages: [
      { account_id: "acct-1", page_id: "P1", access_token: "enc:page-token" },
    ],
    meta_lead_connections: [
      {
        account_id: "acct-1",
        access_token: "enc:stored-token",
        status: "connected",
        last_error: null,
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
}

const { processSubmissionById } = await import("./process-lead");

beforeEach(() => {
  h.leadError = null;
  h.onLead = null;
});

describe("processSubmissionById — connection status stays reliable", () => {
  it("does not invalidate the token on a #100 invalid-field error", async () => {
    h.leadError = new MetaGraphError({
      message: "(#100) Tried accessing nonexisting field (page_id)",
      graphType: "OAuthException",
      graphCode: 100,
      graphStatus: 400,
      status: 400,
    });
    const { db, tables } = seed();

    const result = await processSubmissionById(db, CONFIG, "sub-1");

    expect(result.outcome).toBe("failed");
    expect(tables.meta_lead_connections[0]).toMatchObject({
      status: "connected",
      last_error: null,
    });
    expect(tables.meta_lead_submissions[0]).toMatchObject({
      status: "failed",
      last_error: expect.stringContaining("#100"),
    });
  });

  it("does not invalidate the token on a #200 permission error", async () => {
    h.leadError = new MetaGraphError({
      message: "(#200) Requires leads_retrieval permission",
      graphType: "OAuthException",
      graphCode: 200,
      graphStatus: 400,
      status: 400,
    });
    const { db, tables } = seed();

    await processSubmissionById(db, CONFIG, "sub-1");

    expect(tables.meta_lead_connections[0].status).toBe("connected");
  });

  it("does not invalidate the token on a temporary network/5xx failure", async () => {
    h.leadError = new MetaGraphError({
      message: "Could not reach the Meta Graph API.",
    });
    const { db, tables } = seed();

    await processSubmissionById(db, CONFIG, "sub-1");

    expect(tables.meta_lead_connections[0].status).toBe("connected");
  });

  it("marks the connection only on a definitive #190 rejection", async () => {
    h.leadError = new MetaGraphError({
      message: "Invalid OAuth access token.",
      graphType: "OAuthException",
      graphCode: 190,
      graphStatus: 400,
      status: 401,
    });
    const { db, tables } = seed();

    const result = await processSubmissionById(db, CONFIG, "sub-1");

    expect(result.outcome).toBe("failed");
    expect(tables.meta_lead_connections[0]).toMatchObject({
      status: "needs_reauth",
      last_error: "Meta authorization expired or was revoked.",
    });
  });

  it("cannot overwrite a token re-saved while a stale worker was in flight", async () => {
    const { db, tables } = seed();
    h.onLead = () => {
      // Simulate the customer saving a fresh token after this attempt
      // snapshotted the connection but before it failed.
      tables.meta_lead_connections[0].updated_at = "2026-01-02T00:00:00Z";
      tables.meta_lead_connections[0].access_token = "enc:fresh-token";
      tables.meta_lead_connections[0].status = "connected";
      tables.meta_lead_connections[0].last_error = null;
    };
    h.leadError = new MetaGraphError({
      message: "Invalid OAuth access token.",
      graphCode: 190,
      graphStatus: 400,
      status: 401,
    });

    await processSubmissionById(db, CONFIG, "sub-1");

    expect(tables.meta_lead_connections[0]).toMatchObject({
      access_token: "enc:fresh-token",
      status: "connected",
      last_error: null,
      updated_at: "2026-01-02T00:00:00Z",
    });
  });
});

const CONFIG = {
  appId: "1",
  appSecret: "secret",
  webhookVerifyToken: "verify",
  graphVersion: "v21.0",
};
