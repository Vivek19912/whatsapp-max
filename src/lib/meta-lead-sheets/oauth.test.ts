// Meta Sheets OAuth — account isolation, switching, refresh.
// Tokens are encrypted at rest; the fake db stands in for RLS.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decrypt } from "@/lib/whatsapp/encryption";

import {
  getSheetsAccessToken,
  saveSheetsConnection,
  SheetsAuthError,
} from "./oauth";

type Row = Record<string, unknown>;

function makeDb(initial: Record<string, Row[]>, opts: { denyWrites?: boolean } = {}) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }
  function matches(
    row: Row,
    filters: Array<{ col: string; val: unknown }>
  ): boolean {
    for (const f of filters) {
      if ((row[f.col] ?? null) !== (f.val ?? null)) return false;
    }
    return true;
  }
  function builder(table: string) {
    let op: "select" | "update" | "upsert" | "insert" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    const filters: Array<{ col: string; val: unknown }> = [];
    const b: Record<string, (...args: never[]) => unknown> = {
      select: (() => b) as never,
      upsert: ((rows: Row | Row[]) => {
        op = "upsert";
        payload = rows;
        return b;
      }) as never,
      update: ((p: Row) => {
        op = "update";
        payload = p;
        return b;
      }) as never,
      eq: ((col: string, val: unknown) => {
        filters.push({ col, val });
        return b;
      }) as never,
      maybeSingle: (async () => {
        if (op === "update") {
          if (opts.denyWrites) {
            return { data: null, error: { message: "RLS deny", code: "42501" } };
          }
          const targets = (data[table] ?? []).filter((r) => matches(r, filters));
          for (const row of targets) Object.assign(row, payload as Row);
          return { data: targets[0] ?? null, error: null };
        }
        if (op === "insert" || op === "upsert") {
          const list = Array.isArray(payload) ? payload : [payload as Row];
          for (const r of list) {
            const rr = r as Row;
            if (op === "upsert") {
              const existing = (data[table] ?? []).find(
                (e) => e.account_id === rr.account_id
              );
              if (existing) {
                Object.assign(existing, rr);
                continue;
              }
            }
            (data[table] ??= []).push({ ...(rr as Row) });
          }
          return { data: null, error: null };
        }
        const rows = (data[table] ?? []).filter((r) => matches(r, filters));
        return { data: rows[0] ?? null, error: null };
      }) as never,
      then: ((res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === "update") {
          if (opts.denyWrites) {
            return Promise.resolve({
              data: null,
              error: { message: "RLS deny", code: "42501" },
            }).then(res, rej);
          }
          const targets = (data[table] ?? []).filter((r) => matches(r, filters));
          for (const row of targets) Object.assign(row, payload as Row);
          return Promise.resolve({ data: targets, error: null }).then(res, rej);
        }
        if (op === "insert" || op === "upsert") {
          const list = Array.isArray(payload) ? payload : [payload as Row];
          for (const r of list) {
            const rr = r as Row;
            if (op === "upsert") {
              const existing = (data[table] ?? []).find(
                (e) => e.account_id === rr.account_id
              );
              if (existing) {
                Object.assign(existing, rr);
                continue;
              }
            }
            (data[table] ??= []).push({ ...(rr as Row) });
          }
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        const rows = (data[table] ?? []).filter((r) => matches(r, filters));
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      }) as never,
    };
    return b;
  }
  return {
    db: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    data,
  };
}

function pastExpiry() {
  return new Date(Date.now() - 3600_000).toISOString();
}

function tokenFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    return impl(url, init);
  }) as typeof fetch;
}

function okJson(body: unknown, headers?: Record<string, string>) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers ?? {}),
    json: async () => body,
    text: async () => "",
  } as unknown as Response;
}

function errJson(status: number, body: unknown, headers?: Record<string, string>) {
  return {
    ok: false,
    status,
    headers: new Headers(headers ?? {}),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "cid");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret");
});

async function connect(
  db: SupabaseClient,
  email: string,
  accessToken = "access-1",
  refreshToken = "refresh-1"
) {
  await saveSheetsConnection(
    db,
    "acct-1",
    {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 3600_000),
      scope: "scope",
      email,
    },
    null,
  );
}

describe("meta sheets oauth — account isolation and switching", () => {
  it("returns the currently saved account's token (switching accounts replaces it)", async () => {
    const { db, data } = makeDb({ meta_lead_sheets_connections: [] });
    await connect(db, "a@example.com", "access-A", "refresh-A");
    expect(await getSheetsAccessToken(db, "acct-1")).toBe("access-A");

    // Switching Google accounts replaces the stored grant.
    await connect(db, "b@example.com", "access-B", "refresh-B");
    expect(data.meta_lead_sheets_connections).toHaveLength(1);
    expect(await getSheetsAccessToken(db, "acct-1")).toBe("access-B");
  });

  it("never returns another account's token", async () => {
    const { db } = makeDb({ meta_lead_sheets_connections: [] });
    await connect(db, "a@example.com");
    await expect(getSheetsAccessToken(db, "acct-2")).rejects.toBeInstanceOf(
      SheetsAuthError
    );
  });

  it("refreshes an expired token and persists the rotation", async () => {
    const { db, data } = makeDb({ meta_lead_sheets_connections: [] });
    await connect(db, "a@example.com", "old-access", "refresh-1");
    data.meta_lead_sheets_connections[0].token_expiry = pastExpiry();

    const fetchImpl = tokenFetch((url) => {
      expect(url).toContain("oauth2.googleapis.com/token");
      return okJson({ access_token: "fresh-access", expires_in: 3600 });
    });
    expect(await getSheetsAccessToken(db, "acct-1", fetchImpl)).toBe("fresh-access");
    // Persisted for the next call (no second refresh).
    expect(decrypt(data.meta_lead_sheets_connections[0].access_token as string)).toBe(
      "fresh-access"
    );
    const quiet = tokenFetch(() => {
      throw new Error("must not refresh again");
    });
    expect(await getSheetsAccessToken(db, "acct-1", quiet)).toBe("fresh-access");
  });

  it("treats a throttled token endpoint as quota (no reconnect, no poisoning)", async () => {
    const { db, data } = makeDb({ meta_lead_sheets_connections: [] });
    await connect(db, "a@example.com", "old-access", "refresh-1");
    data.meta_lead_sheets_connections[0].token_expiry = pastExpiry();

    const fetchImpl = tokenFetch(() =>
      errJson(
        429,
        { error: { message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }] } },
        { "retry-after": "45" }
      )
    );
    const err = await getSheetsAccessToken(db, "acct-1", fetchImpl).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("SheetsQuotaError");
    // Connection untouched: no last_error poisoning.
    expect(data.meta_lead_sheets_connections[0].last_error ?? null).toBeNull();
  });

  it("still returns a fresh token when the persist write is denied (RLS-scoped reader)", async () => {
    const { db, data } = makeDb(
      { meta_lead_sheets_connections: [] },
      { denyWrites: true }
    );
    await connect(db, "a@example.com", "old-access", "refresh-1");
    data.meta_lead_sheets_connections[0].token_expiry = pastExpiry();

    const fetchImpl = tokenFetch(() =>
      okJson({ access_token: "fresh-access", expires_in: 3600 })
    );
    // No throw: the caller gets a usable token for this request.
    expect(await getSheetsAccessToken(db, "acct-1", fetchImpl)).toBe("fresh-access");
  });

  it("flags revoked grants for reconnect without masking the auth error", async () => {
    const { db, data } = makeDb(
      { meta_lead_sheets_connections: [] },
      { denyWrites: true }
    );
    await connect(db, "a@example.com", "old-access", "refresh-1");
    data.meta_lead_sheets_connections[0].token_expiry = pastExpiry();

    const fetchImpl = tokenFetch(() =>
      errJson(400, { error: "invalid_grant" })
    );
    // The write denial must not mask the real auth failure.
    await expect(getSheetsAccessToken(db, "acct-1", fetchImpl)).rejects.toBeInstanceOf(
      SheetsAuthError
    );
  });
});
