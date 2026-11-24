// Meta CRM feedback config + events API — contracts.
//
// Guarantees: admin-only writes, account isolation, verification
// fail-closed, no tokens in responses, retry preserves identity.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "admin-1",
  role: "admin" as string,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  ownership: "ok" as "ok" | "not-owned" | { throw: unknown },
  token: "STORED_TOKEN",
  configDbError: null as { code: string; message: string } | null,
  upsertDbError: null as { code: string; message: string } | null,
  tokensSeen: [] as unknown[],
  getUserTokenCalls: 0,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (min === "admin" && h.role !== "admin" && h.role !== "owner") {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return { supabase: fakeDb(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  getCurrentAccount: async () => {
    if (h.role === "viewer") throw Object.assign(new Error("Forbidden"), { status: 403 });
    return { supabase: fakeDb(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

vi.mock("@/lib/meta-lead-ads/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-lead-ads/store")>();
  return {
    ...actual,
    // Lead Ads connection token — CRM Feedback must NEVER use it.
    // Any call here is a separation violation; tests assert the
    // count stays zero on every CRM path.
    getUserToken: async () => {
      h.getUserTokenCalls += 1;
      return h.token;
    },
  };
});

vi.mock("@/lib/meta-crm/datasets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-crm/datasets")>();
  return {
    ...actual,
    verifyDatasetOwnership: async (args: { accessToken?: unknown }) => {
      h.tokensSeen.push(args?.accessToken);
      if (h.ownership === "ok") return { verified: true };
      if (h.ownership === "not-owned") {
        return {
          verified: false,
          reason:
            'Dataset 1830596054845292 ("IM CRM") was not found under Business Portfolio BIZ1.',
        };
      }
      throw (h.ownership as { throw: unknown }).throw;
    },
  };
});

type Row = Record<string, unknown>;

function fakeDb() {
  const tables = h.tables;
  function chain(table: string, filters: Array<[string, unknown]> = []) {
    const matches = (r: Row) =>
      filters.every(([c, v]) => {
        if (c === "__limit") return true;
        if (typeof c === "string" && c.startsWith("__in:")) {
          return (v as unknown[]).includes(r[c.slice(5)]);
        }
        return r[c] === v;
      });
    const api: Record<string, (...a: never[]) => unknown> = {
      select: () => chain(table, filters),
      eq: (c: string, v: unknown) => chain(table, [...filters, [c, v]]),
      in: (c: string, vals: unknown) => chain(table, [...filters, [`__in:${c}`, vals]]),
      order: () => chain(table, filters),
      limit: (n: number) => chain(table, [...filters, ["__limit", n]] as never),
      maybeSingle: async () => {
        if (table === "meta_crm_config" && h.configDbError) throw h.configDbError;
        const rows = (tables[table] ?? []).filter(matches);
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const rows = (tables[table] ?? []).filter(matches);
        return rows.length > 0
          ? { data: rows[0], error: null }
          : { data: null, error: { message: "none" } };
      },
      then: (resolve: (v: { data: Row[]; error: null }) => void) => {
        const lim = filters.find(([c]) => c === "__limit")?.[1] as number | undefined;
        let rows = (tables[table] ?? []).filter(matches);
        if (typeof lim === "number") rows = rows.slice(0, lim);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return api;
  }
  return {
    from(table: string) {
      const filtered = (filters: Array<[string, unknown]>) =>
        (tables[table] ?? []).filter((r) =>
          filters.every(([c, v]) => r[c] === v),
        );
      return {
        select: () => chain(table),
        insert: (payload: Row) => ({
          select: () => ({
            single: async () => {
              const row = { id: `evt-${Date.now()}`, ...payload };
              (tables[table] ??= []).push(row);
              return { data: row, error: null };
            },
          }),
        }),
        upsert: (payload: Row) => {
          const rows = (tables[table] ??= []);
          const idx = rows.findIndex((r) => r.account_id === payload.account_id);
          const row = idx >= 0 ? { ...rows[idx], ...payload } : { id: "cfg-1", ...payload };
          if (idx >= 0) rows[idx] = row;
          else rows.push(row);
          return {
            select: () => ({
              single: async () => {
                if (table === "meta_crm_config" && h.upsertDbError) throw h.upsertDbError;
                return { data: row, error: null };
              },
            }),
          };
        },
        update: (patch: Row) => ({
          eq: (col: string, val: unknown) => ({
            eq: (col2: string, val2: unknown) => ({
              then: (resolve: (v: { data: null; error: null }) => void) => {
                for (const r of filtered([[col, val], [col2, val2]])) Object.assign(r, patch);
                return Promise.resolve({ data: null, error: null }).then(resolve);
              },
            }),
            then: (resolve: (v: { data: null; error: null }) => void) => {
              for (const r of filtered([[col, val]])) Object.assign(r, patch);
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          }),
        }),
      };
    },
  };
}

const { GET: configGet, PUT: configPut } = await import("./config/route");
const { GET: eventsGet } = await import("./events/route");
const { POST: retryPost } = await import("./events/retry/route");

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "admin-1";
  h.role = "admin";
  h.ownership = "ok";
  h.token = "STORED_TOKEN";
  h.configDbError = null;
  h.upsertDbError = null;
  h.tokensSeen = [];
  h.getUserTokenCalls = 0;
  h.tables = {
    meta_crm_datasets: [
      {
        id: "row-ds",
        account_id: "acct-1",
        dataset_id: "1830596054845292",
        business_portfolio_id: "1171141236081090",
        dataset_name: "IM CRM",
      },
    ],
    meta_crm_config: [],
    meta_crm_events: [],
    flow_runs: [],
    contacts: [],
    flows: [],
  };
});

describe("PUT /api/integrations/meta-crm/config", () => {
  const put = (body: unknown) =>
    new Request("https://app.test/api/integrations/meta-crm/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("enables after verification, encrypts the dedicated token, and never returns it", async () => {
    const { decrypt } = await import("@/lib/whatsapp/encryption");
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds", accessToken: "CRM_TOKEN_new" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; ownershipVerified: boolean; config: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.ownershipVerified).toBe(true);
    expect(json.config.enabled).toBe(true);
    expect(json.config.datasetId).toBe("1830596054845292");
    expect(json.config.hasToken).toBe(true);
    // The response carries a boolean, never the value.
    expect(JSON.stringify(json)).not.toContain("CRM_TOKEN_new");
    // Stored encrypted at rest — decrypts to the supplied value.
    const stored = h.tables.meta_crm_config[0]?.access_token as string;
    expect(typeof stored).toBe("string");
    expect(stored).not.toContain("CRM_TOKEN_new");
    expect(decrypt(stored)).toBe("CRM_TOKEN_new");
    // Verification used the dedicated token — never the Lead Ads one.
    expect(h.tokensSeen).toEqual(["CRM_TOKEN_new"]);
    expect(h.getUserTokenCalls).toBe(0);
    expect(JSON.stringify(h.tables).includes("STORED_TOKEN")).toBe(false);
  });

  it("requires a CRM token to enable (no silent fallback)", async () => {
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain("access token");
    expect(h.tables.meta_crm_config[0]?.enabled).not.toBe(true);
    expect(h.tokensSeen).toHaveLength(0);
  });

  it("reuses the stored token without re-pasting, then rotates it", async () => {
    const { decrypt, encrypt } = await import("@/lib/whatsapp/encryption");
    h.tables.meta_crm_config = [
      { account_id: "acct-1", enabled: false, dataset_id: null, access_token: encrypt("CRM_TOKEN_old") },
    ];
    const reuse = await configPut(put({ enabled: true, datasetRowId: "row-ds" }));
    expect(reuse.status).toBe(200);
    expect(h.tokensSeen).toEqual(["CRM_TOKEN_old"]);
    expect(h.getUserTokenCalls).toBe(0);

    const rotated = await configPut(put({ enabled: true, datasetRowId: "row-ds", accessToken: "CRM_TOKEN_rotated" }));
    expect(rotated.status).toBe(200);
    expect(h.tokensSeen).toEqual(["CRM_TOKEN_old", "CRM_TOKEN_rotated"]);
    expect(decrypt(h.tables.meta_crm_config[0]?.access_token as string)).toBe("CRM_TOKEN_rotated");
    expect(h.getUserTokenCalls).toBe(0);
  });

  it("disabling keeps the stored token; removal is explicit", async () => {
    const { decrypt, encrypt } = await import("@/lib/whatsapp/encryption");
    h.tables.meta_crm_config = [
      { account_id: "acct-1", enabled: true, dataset_id: "1830596054845292", access_token: encrypt("CRM_TOKEN_keep") },
    ];
    const disabled = await configPut(put({ enabled: false, datasetRowId: null }));
    expect(disabled.status).toBe(200);
    const json = (await disabled.json()) as { config: { enabled: boolean; hasToken: boolean } };
    expect(json.config.enabled).toBe(false);
    expect(json.config.hasToken).toBe(true);
    expect(decrypt(h.tables.meta_crm_config[0]?.access_token as string)).toBe("CRM_TOKEN_keep");

    const removed = await configPut(put({ enabled: false, datasetRowId: null, removeAccessToken: true }));
    expect(removed.status).toBe(200);
    const removedJson = (await removed.json()) as { config: { hasToken: boolean } };
    expect(removedJson.config.hasToken).toBe(false);
    expect(h.tables.meta_crm_config[0]?.access_token).toBeNull();

    // Enabling again without a token is refused.
    const relapsed = await configPut(put({ enabled: true, datasetRowId: "row-ds" }));
    expect(relapsed.status).toBe(400);
  });

  it("rejects enabling while removing the token", async () => {
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds", removeAccessToken: true }));
    expect(res.status).toBe(400);
  });

  it("refuses to enable when the dataset is absent from the business listing", async () => {
    h.ownership = "not-owned";
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds", accessToken: "CRM_TOKEN_x" }));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string; code?: string };
    expect(json.code).toBe("forbidden");
    // Names the actual ids instead of the generic ownership message.
    expect(json.error).toContain("1830596054845292");
    expect(h.tables.meta_crm_config[0]?.enabled).toBe(false);
    // The failed replacement is never stored.
    expect(h.tables.meta_crm_config[0]?.access_token).toBeUndefined();
    expect(h.getUserTokenCalls).toBe(0);
  });

  it("surfaces an expired token precisely instead of blaming ownership", async () => {
    const { MetaCrmError } = await import("@/lib/meta-crm/datasets");
    h.ownership = {
      throw: new MetaCrmError({
        code: "auth_failed",
        message: "Meta rejected the access token. It may be expired or invalid.",
        status: 401,
        metaCode: 190,
        metaSubcode: null,
      }),
    };
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds", accessToken: "CRM_TOKEN_expired" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: string; code?: string; metaCode?: number };
    expect(json.code).toBe("auth_failed");
    expect(json.metaCode).toBe(190);
    expect(json.error).toContain("expired or invalid");
    expect(h.tables.meta_crm_config[0]?.enabled).toBe(false);
    // The rejected token is never stored; the Lead Ads token untouched.
    expect(h.tables.meta_crm_config[0]?.access_token).toBeUndefined();
    expect(h.getUserTokenCalls).toBe(0);
  });

  it("surfaces missing dataset permissions with Meta codes", async () => {
    const { MetaCrmError } = await import("@/lib/meta-crm/datasets");
    h.ownership = {
      throw: new MetaCrmError({
        code: "forbidden",
        message: "Meta refused: insufficient permissions (code 200). Grant dataset creation rights to this token/business.",
        status: 403,
        metaCode: 200,
        metaSubcode: 33,
      }),
    };
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds", accessToken: "CRM_TOKEN_perms" }));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string; code?: string; metaCode?: number; metaSubcode?: number };
    expect(json.code).toBe("forbidden");
    expect(json.metaCode).toBe(200);
    expect(json.metaSubcode).toBe(33);
    expect(JSON.stringify(json).toLowerCase()).not.toContain("ownership could not be verified");
  });

  it("rejects foreign datasets and requires admin", async () => {
    h.tables.meta_crm_datasets = [];
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds" }));
    expect(res.status).toBe(400);
    h.role = "agent";
    const denied = await configPut(put({ enabled: false, datasetRowId: null }));
    expect(denied.status).toBe(403);
  });

  it("disables without verification", async () => {
    const res = await configPut(put({ enabled: false, datasetRowId: null }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { config: { enabled: boolean; autoSendLead: boolean } };
    expect(json.config.enabled).toBe(false);
    expect(json.config.autoSendLead).toBe(false);
  });

  it("persists the auto-send preference independently of enabled", async () => {
    const on = await configPut(put({ enabled: false, datasetRowId: null, autoSendLead: true }));
    expect(on.status).toBe(200);
    const onJson = (await on.json()) as { config: { enabled: boolean; autoSendLead: boolean } };
    expect(onJson.config.enabled).toBe(false);
    expect(onJson.config.autoSendLead).toBe(true);

    const off = await configPut(put({ enabled: false, datasetRowId: null, autoSendLead: false }));
    expect((await off.json()) as { config: { autoSendLead: boolean } }).toMatchObject({
      config: { autoSendLead: false },
    });

    const fetched = (await (await configGet()).json()) as { config: { autoSendLead: boolean } };
    expect(fetched.config.autoSendLead).toBe(false);
  });

  it("persists the column-visibility preference, defaulting to visible", async () => {
    const def = await configPut(put({ enabled: false, datasetRowId: null }));
    expect(((await def.json()) as { config: { showLeadQuality: boolean } }).config.showLeadQuality).toBe(true);

    const hidden = await configPut(put({ enabled: false, datasetRowId: null, showLeadQuality: false }));
    expect(hidden.status).toBe(200);
    expect(((await hidden.json()) as { config: { showLeadQuality: boolean } }).config.showLeadQuality).toBe(false);

    const fetched = (await (await configGet()).json()) as { config: { showLeadQuality: boolean } };
    expect(fetched.config.showLeadQuality).toBe(false);
  });

  it("persists the table allowlist by id, defaulting to unrestricted (null)", async () => {
    h.tables.flows = [
      { id: "flow-a", account_id: "acct-1", kind: "meta_lead_ads", name: "Rajasthan" },
      { id: "flow-b", account_id: "acct-1", kind: "meta_lead_ads", name: "Kerala" },
    ];
    const def = await configPut(put({ enabled: false, datasetRowId: null }));
    expect(((await def.json()) as { config: { allowedFlowIds: string[] | null } }).config.allowedFlowIds).toBeNull();

    const saved = await configPut(
      put({ enabled: false, datasetRowId: null, allowedFlowIds: ["flow-a"] }),
    );
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { config: { allowedFlowIds: string[] } }).config.allowedFlowIds).toEqual([
      "flow-a",
    ]);

    // Omitted = preserved, not cleared.
    const untouched = await configPut(put({ enabled: false, datasetRowId: null }));
    expect(((await untouched.json()) as { config: { allowedFlowIds: string[] } }).config.allowedFlowIds).toEqual([
      "flow-a",
    ]);

    // Empty array is an explicit block-all.
    const emptied = await configPut(put({ enabled: false, datasetRowId: null, allowedFlowIds: [] }));
    expect(((await emptied.json()) as { config: { allowedFlowIds: string[] } }).config.allowedFlowIds).toEqual(
      [],
    );

    const fetched = (await (await configGet()).json()) as { config: { allowedFlowIds: string[] } };
    expect(fetched.config.allowedFlowIds).toEqual([]);
  });

  it("rejects foreign, non-Meta, and malformed table ids", async () => {
    h.tables.flows = [
      { id: "flow-a", account_id: "acct-1", kind: "meta_lead_ads", name: "Rajasthan" },
      { id: "flow-chat", account_id: "acct-1", kind: "whatsapp_flow", name: "Chat" },
      { id: "flow-x", account_id: "acct-OTHER", kind: "meta_lead_ads", name: "Foreign" },
    ];
    for (const bad of [["flow-x"], ["flow-chat"], ["flow-gone"], "not-an-array"]) {
      const res = await configPut(put({ enabled: false, datasetRowId: null, allowedFlowIds: bad }));
      expect(res.status).toBe(400);
    }
    expect(h.tables.meta_crm_config).toHaveLength(0);
  });

  it("maps a missing allowlist column to an actionable 503", async () => {
    h.tables.flows = [{ id: "flow-a", account_id: "acct-1", kind: "meta_lead_ads", name: "Rajasthan" }];
    h.upsertDbError = { code: "42703", message: 'column "allowed_flow_ids" does not exist' };
    const res = await configPut(put({ enabled: false, datasetRowId: null, allowedFlowIds: ["flow-a"] }));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { code?: string; error?: string };
    expect(json.code).toBe("migration_missing");
    expect(json.error).toContain("183");
  });
});

describe("GET /api/integrations/meta-crm/config", () => {
  it("returns null config when unconfigured", async () => {
    const res = await configGet();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; config: { enabled: boolean; hasToken: boolean } };
    expect(json.ok).toBe(true);
    expect(json.config.enabled).toBe(false);
    expect(json.config.hasToken).toBe(false);
  });

  it("reports token presence without ever returning the value", async () => {
    const { encrypt } = await import("@/lib/whatsapp/encryption");
    h.tables.meta_crm_config = [
      { account_id: "acct-1", enabled: true, dataset_id: "DS1", access_token: encrypt("CRM_TOKEN_secret") },
    ];
    const res = await configGet();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { config: { hasToken: boolean } };
    expect(json.config.hasToken).toBe(true);
    expect(JSON.stringify(json)).not.toContain("CRM_TOKEN_secret");
  });

  it("returns an honest unconfigured state when the config table is missing", async () => {
    h.configDbError = { code: "42P01", message: 'relation "meta_crm_config" does not exist' };
    const res = await configGet();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      migrationMissing: boolean;
      config: { enabled: boolean; datasetId: null };
    };
    expect(json.ok).toBe(true);
    expect(json.migrationMissing).toBe(true);
    expect(json.config.enabled).toBe(false);
    expect(json.config.datasetId).toBeNull();
  });

  it("returns the stored allowlist (null when never configured)", async () => {
    h.tables.meta_crm_config = [{ account_id: "acct-1", enabled: true, dataset_id: "DS1" }];
    const legacy = (await (await configGet()).json()) as {
      config: { allowedFlowIds: string[] | null };
    };
    expect(legacy.config.allowedFlowIds).toBeNull();

    h.tables.meta_crm_config = [
      { account_id: "acct-1", enabled: true, dataset_id: "DS1", allowed_flow_ids: ["flow-a"] },
    ];
    const explicit = (await (await configGet()).json()) as {
      config: { allowedFlowIds: string[] | null };
    };
    expect(explicit.config.allowedFlowIds).toEqual(["flow-a"]);
  });
});

describe("migration 183_meta_crm_allowed_tables", () => {
  it("adds a nullable allowlist column (legacy rows stay unrestricted)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      `${process.cwd()}/supabase/migrations/183_meta_crm_allowed_tables.sql`,
      "utf8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS allowed_flow_ids UUID[]");
    // Nullable with no NOT NULL / DEFAULT: pre-existing rows read as
    // NULL, which the code treats as unrestricted legacy behavior.
    expect(sql).not.toMatch(/allowed_flow_ids[^;]*NOT NULL/);
    expect(sql).not.toMatch(/allowed_flow_ids[^;]*DEFAULT/);
  });
});

describe("migration 184 cross-table dedup guard (superseded by 185)", () => {
  it("never blocks and never mutates the ledger", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      `${process.cwd()}/supabase/migrations/184_meta_crm_cross_table_dedup.sql`,
      "utf8",
    );
    // The partial unique index could not be applied over preserved
    // historical duplicates, so 184 is a convergence stub: it drops
    // the index when a clean environment already created it, then
    // only reports duplicate groups for review.
    expect(sql).toContain("DROP INDEX IF EXISTS public.meta_crm_events_dataset_lead_event_key");
    expect(sql).not.toContain("RAISE EXCEPTION");
    expect(sql).toContain("RAISE NOTICE");
    // No data mutation: the stub never deletes rows and never flips
    // a Sent row to another status to satisfy an index.
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/UPDATE public\.meta_crm_events/i);
    expect(sql).not.toContain("CREATE UNIQUE INDEX");
  });
});

describe("migration 185 event-identity claims (atomic, history-preserving)", () => {
  async function sql(): Promise<string> {
    const { readFileSync } = await import("node:fs");
    return readFileSync(
      `${process.cwd()}/supabase/migrations/185_meta_crm_event_claims.sql`,
      "utf8",
    );
  }

  it("creates one claim row per event identity with a primary key", async () => {
    const text = await sql();
    expect(text).toContain("CREATE TABLE IF NOT EXISTS public.meta_crm_event_claims");
    expect(text).toContain("PRIMARY KEY (account_id, dataset_id, meta_lead_id, event_name)");
    expect(text).toContain("canonical_event_id");
  });

  it("accepts every event name the ledger accepts (incl. historical Junk)", async () => {
    // Derived from the authoritative definition — any future
    // CRM_EVENT_NAMES addition without a matching claims CHECK
    // fails here instead of in production with a 23514.
    const { CRM_EVENT_NAMES } = await import("@/lib/meta-crm/lead-quality");
    const text = await sql();
    expect(CRM_EVENT_NAMES).toContain("Junk");
    expect(CRM_EVENT_NAMES).toContain("DisqualifiedLead");
    for (const name of CRM_EVENT_NAMES) {
      expect(text).toContain(`'${name}'`);
    }
  });

  it("seeds claims from all history without touching the ledger", async () => {
    const text = await sql();
    expect(text).toContain("INSERT INTO public.meta_crm_event_claims");
    expect(text).toContain("ON CONFLICT (account_id, dataset_id, meta_lead_id, event_name) DO NOTHING");
    // Canonical preference: sent first, then pending/failed/skipped.
    expect(text).toMatch(/WHEN 'sent' THEN 0/);
    expect(text).toMatch(/WHEN 'pending' THEN 1/);
    // No destructive statements against the ledger, ever.
    expect(text).not.toMatch(/DELETE FROM public\.meta_crm_events/i);
    expect(text).not.toMatch(/DELETE FROM/i);
    expect(text).not.toMatch(/UPDATE public\.meta_crm_events/i);
  });

  it("provides an atomic enqueue function and converges clean environments", async () => {
    const text = await sql();
    expect(text).toContain("CREATE OR REPLACE FUNCTION public.enqueue_meta_crm_event(");
    // Claim first (mutual exclusion), then insert, then finalize.
    expect(text).toContain("ON CONFLICT (account_id, dataset_id, meta_lead_id, event_name) DO NOTHING");
    expect(text).toContain("FOR UPDATE");
    // Environments that applied the original 184 converge here.
    expect(text).toContain("DROP INDEX IF EXISTS public.meta_crm_events_dataset_lead_event_key");
    // Verification is read-only and never blocks reruns: the only
    // RAISE EXCEPTION in the file is the RPC's null-identity
    // programmer guard, not a migration gate.
    expect(text).toContain("meta lead id and dataset id are required");
    expect(text.match(/RAISE EXCEPTION/g)?.length).toBe(1);
    expect(text).toContain("RAISE NOTICE");
  });
});

describe("GET /api/integrations/meta-crm/events", () => {
  it("lists only the caller's account events with enrichment", async () => {
    h.tables.meta_crm_events = [
      {
        id: "evt-1",
        account_id: "acct-1",
        flow_id: "flow-1",
        flow_run_id: "run-1",
        meta_lead_id: "LEAD1",
        event_name: "QualifiedLead",
        from_quality: "",
        to_quality: "Qualified Lead",
        event_time: "2026-11-22T10:00:00.000Z",
        event_uuid: "u1",
        dataset_id: "1830596054845292",
        status: "sent",
        attempts: 1,
        max_attempts: 8,
        last_error: null,
        next_retry_at: new Date(0).toISOString(),
        sent_at: "2026-11-22T10:01:00.000Z",
        created_at: "2026-11-22T10:00:00.000Z",
      },
      {
        id: "evt-other",
        account_id: "acct-2",
        flow_id: null,
        flow_run_id: null,
        meta_lead_id: "LEADX",
        event_name: "Lead",
        from_quality: "",
        to_quality: "Lead",
        event_time: "2026-11-22T10:00:00.000Z",
        event_uuid: "u2",
        dataset_id: "DSX",
        status: "pending",
        attempts: 0,
        max_attempts: 8,
        last_error: null,
        next_retry_at: new Date(0).toISOString(),
        sent_at: null,
        created_at: "2026-11-22T10:00:00.000Z",
      },
    ];
    h.tables.flow_runs = [
      { id: "run-1", account_id: "acct-1", contact_id: "c-1" },
    ];
    h.tables.contacts = [{ id: "c-1", account_id: "acct-1", name: "Amit Verma" }];
    h.tables.flows = [{ id: "flow-1", account_id: "acct-1", name: "Spiti Table" }];
    const res = await eventsGet(
      new Request("https://app.test/api/integrations/meta-crm/events"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      events: Array<{ id: string; leadName: string | null; tableName: string | null }>;
      counts: Record<string, number>;
    };
    expect(json.ok).toBe(true);
    expect(json.events.map((e) => e.id)).toEqual(["evt-1"]);
    expect(json.events[0].leadName).toBe("Amit Verma");
    expect(json.events[0].tableName).toBe("Spiti Table");
    expect(json.counts.sent).toBe(1);
    expect(JSON.stringify(json).includes("STORED_TOKEN")).toBe(false);
  });

  it("rejects invalid filters and tolerates a missing migration", async () => {
    const bad = await eventsGet(
      new Request("https://app.test/api/integrations/meta-crm/events?status=bogus"),
    );
    expect(bad.status).toBe(400);
    const badEvent = await eventsGet(
      new Request("https://app.test/api/integrations/meta-crm/events?event_name=bogus"),
    );
    expect(badEvent.status).toBe(400);
  });
});

describe("POST /api/integrations/meta-crm/events/retry", () => {
  const post = (body: unknown) =>
    new Request("https://app.test/api/integrations/meta-crm/events/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("requeues failed events preserving identity", async () => {
    h.tables.meta_crm_events = [
      {
        id: "evt-f",
        account_id: "acct-1",
        status: "failed",
        attempts: 8,
        event_uuid: "uuid-f",
      },
    ];
    // dynamic import of trigger schedules after(); swallow outside scope
    const res = await retryPost(post({ event_id: "evt-f" }));
    expect(res.status).toBe(200);
    const row = h.tables.meta_crm_events[0];
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.event_uuid).toBe("uuid-f");
  });

  it("refuses sent rows and foreign rows", async () => {
    h.tables.meta_crm_events = [
      { id: "evt-s", account_id: "acct-1", status: "sent", event_uuid: "u" },
    ];
    const res = await retryPost(post({ event_id: "evt-s" }));
    expect(res.status).toBe(400);
    const missing = await retryPost(post({ event_id: "nope" }));
    expect(missing.status).toBe(404);
    h.tables.meta_crm_events = [
      { id: "evt-x", account_id: "acct-2", status: "failed", event_uuid: "u" },
    ];
    const foreign = await retryPost(post({ event_id: "evt-x" }));
    expect(foreign.status).toBe(404);
  });
});
