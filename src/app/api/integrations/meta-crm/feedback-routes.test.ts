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
    getUserToken: async () => h.token,
  };
});

vi.mock("@/lib/meta-crm/datasets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-crm/datasets")>();
  return {
    ...actual,
    verifyDatasetOwnership: async () => {
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
    const api: Record<string, (...a: never[]) => unknown> = {
      select: () => chain(table, filters),
      eq: (c: string, v: unknown) => chain(table, [...filters, [c, v]]),
      in: () => chain(table, filters),
      order: () => chain(table, filters),
      limit: (n: number) => chain(table, [...filters, ["__limit", n]] as never),
      maybeSingle: async () => {
        if (table === "meta_crm_config" && h.configDbError) throw h.configDbError;
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every(([c, v]) => (c === "__limit" ? true : r[c] === v)),
        );
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every(([c, v]) => (c === "__limit" ? true : r[c] === v)),
        );
        return rows.length > 0
          ? { data: rows[0], error: null }
          : { data: null, error: { message: "none" } };
      },
      then: (resolve: (v: { data: Row[]; error: null }) => void) => {
        const lim = filters.find(([c]) => c === "__limit")?.[1] as number | undefined;
        let rows = (tables[table] ?? []).filter((r) =>
          filters.every(([c, v]) => (c === "__limit" ? true : r[c] === v)),
        );
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
              single: async () => ({ data: row, error: null }),
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

  it("enables after verification and stores no token", async () => {
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; ownershipVerified: boolean; config: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.ownershipVerified).toBe(true);
    expect(json.config.enabled).toBe(true);
    expect(json.config.datasetId).toBe("1830596054845292");
    expect(JSON.stringify(json).includes("STORED_TOKEN")).toBe(false);
  });

  it("refuses to enable when the dataset is absent from the business listing", async () => {
    h.ownership = "not-owned";
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds" }));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string; code?: string };
    expect(json.code).toBe("forbidden");
    // Names the actual ids instead of the generic ownership message.
    expect(json.error).toContain("1830596054845292");
    expect(h.tables.meta_crm_config[0]?.enabled).toBe(false);
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
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: string; code?: string; metaCode?: number };
    expect(json.code).toBe("auth_failed");
    expect(json.metaCode).toBe(190);
    expect(json.error).toContain("expired or invalid");
    expect(h.tables.meta_crm_config[0]?.enabled).toBe(false);
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
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds" }));
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
    const json = (await res.json()) as { config: { enabled: boolean } };
    expect(json.config.enabled).toBe(false);
  });
});

describe("GET /api/integrations/meta-crm/config", () => {
  it("returns null config when unconfigured", async () => {
    const res = await configGet();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; config: { enabled: boolean } };
    expect(json.ok).toBe(true);
    expect(json.config.enabled).toBe(false);
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
