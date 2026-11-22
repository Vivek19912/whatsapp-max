// CRM Feedback WITHOUT migration 176 applied.
//
// Regression suite for the deployed "Internal server error" toast:
// the code references meta_crm_config.access_token, but the column
// does not exist until migration 176_meta_crm_dedicated_token is
// applied. PostgREST rejects with 42703 (a plain object, not an
// Error with .status). The routes must map that to an actionable
// message — never a bare 500 — and GET must flag the gap so the UI
// shows guidance instead of a dead token field.
//
// The mock below simulates the un-migrated database: any select or
// upsert touching `access_token` throws the PostgREST-shaped error.

import { beforeEach, describe, expect, it, vi } from "vitest";

const MISSING_COLUMN = {
  code: "42703",
  message: 'column "access_token" of relation "meta_crm_config" does not exist',
};

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "admin-1",
  role: "admin" as string,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

type Row = Record<string, unknown>;

function unmigratedDb() {
  const tables = h.tables;
  const filtersOf = (filters: Array<[string, unknown]>) => (r: Row) =>
    filters.every(([c, v]) => r[c] === v);
  const chain = (table: string, cols: string[], filters: Array<[string, unknown]> = []): Record<string, (...a: never[]) => unknown> => {
    const api: Record<string, (...a: never[]) => unknown> = {
      select: () => chain(table, cols, filters),
      eq: (c: string, v: unknown) => chain(table, cols, [...filters, [c, v]]),
      maybeSingle: async () => ({ data: (tables[table] ?? []).filter(filtersOf(filters))[0] ?? null, error: null }),
      single: async () => {
        if (cols.includes("*") && table === "meta_crm_config") {
          // SELECT * works — the column is simply absent from rows.
          const rows = (tables[table] ?? []).filter(filtersOf(filters));
          if (rows.length === 0) return { data: null, error: { message: "none" } };
          return { data: rows[0], error: null };
        }
        throw { ...MISSING_COLUMN };
      },
      then: (resolve: (v: unknown) => void) => {
        const rows = (tables[table] ?? []).filter((r: Row) =>
          filters.every(([c, v]) => r[c] === v),
        );
        return resolve({ data: rows, error: null });
      },
    };
    return api;
  };
  return {
    from(table: string) {
      return {
        select: (cols: string) => {
          if (table === "meta_crm_config" && cols !== "*" && cols.split(",").map((s) => s.trim()).includes("access_token")) {
            throw { ...MISSING_COLUMN };
          }
          return chain(table, cols.split(",").map((s) => s.trim()));
        },
        upsert: (payload: Row) => {
          if (table === "meta_crm_config" && "access_token" in payload) {
            return {
              select: () => ({
                single: async () => {
                  throw { ...MISSING_COLUMN };
                },
              }),
            };
          }
          return {
            select: () => ({
              single: async () => {
                const rows = (tables[table] ??= []);
                const row: Row = { id: "cfg-1", ...payload };
                rows.push(row);
                return { data: row, error: null };
              },
            }),
          };
        },
      };
    },
  };
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => ({ supabase: unmigratedDb(), accountId: h.accountId, userId: h.userId, role: h.role }),
  getCurrentAccount: async () => ({ supabase: unmigratedDb(), accountId: h.accountId, userId: h.userId, role: h.role }),
  toErrorResponse: (err: unknown) => {
    if (err instanceof Error && "status" in err) {
      return Response.json({ error: (err as Error).message }, { status: Number((err as { status: unknown }).status) || 500 });
    }
    return Response.json({ error: "Internal server error" }, { status: 500 });
  },
}));

vi.mock("@/lib/meta-lead-ads/store", () => ({
  getUserToken: async () => "LEAD_ADS_TOKEN_must_never_be_used",
}));

vi.mock("@/lib/meta-crm/datasets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-crm/datasets")>();
  return { ...actual, verifyDatasetOwnership: async () => ({ verified: true }) };
});

const { PUT: configPut, GET: configGet } = await import("./config/route");

const put = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-crm/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.tables = {
    meta_crm_datasets: [
      { id: "row-ds", account_id: "acct-1", dataset_id: "1830596054845292", business_portfolio_id: "BIZ1", dataset_name: "DS" },
    ],
    meta_crm_config: [],
  };
});

describe("un-migrated database (migration 176 missing)", () => {
  it("save with a token returns an actionable 503, never a bare 500", async () => {
    const res = await configPut(put({ enabled: true, datasetRowId: "row-ds", accessToken: "CRM_TOKEN_new" }));
    const json = (await res.json()) as { error?: string; code?: string };
    expect(res.status).toBe(503);
    expect(json.code).toBe("migration_missing");
    expect(json.error).toContain("176_meta_crm_dedicated_token");
    expect(JSON.stringify(json)).not.toContain("CRM_TOKEN_new");
    expect(json.error).not.toBe("Internal server error");
  });

  it("dataset-only saves still work without the migration", async () => {
    const res = await configPut(put({ enabled: false, datasetRowId: null }));
    expect(res.status).toBe(200);
  });

  it("GET flags the missing token storage instead of looking healthy", async () => {
    const res = await configGet();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { tokenMigrationMissing?: boolean };
    expect(json.tokenMigrationMissing).toBe(true);
  });
});
