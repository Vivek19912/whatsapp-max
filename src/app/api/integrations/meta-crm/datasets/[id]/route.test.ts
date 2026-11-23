// DELETE /api/integrations/meta-crm/datasets/[id] — local-only removal.
//
// Guarantees: admin-only, account-scoped, never touches Meta (no
// Graph call exists on this path), blocks removal of the dataset
// currently selected by an ENABLED CRM Feedback config (409),
// preserves event history + queued rows, and keeps other
// workspaces untouched.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "admin-1",
  role: "admin" as string,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

type Row = Record<string, unknown>;

function matches(rows: Row[], filters: Array<[string, unknown]>) {
  return rows.filter((r) => filters.every(([c, v]) => r[c] === v));
}

function chain(table: string, filters: Array<[string, unknown]> = []) {
  const api: Record<string, (...a: never[]) => unknown> = {
    select: () => chain(table, filters),
    eq: (c: string, v: unknown) => chain(table, [...filters, [c, v]]),
    maybeSingle: async () => ({ data: matches(h.tables[table] ?? [], filters)[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => void) =>
      resolve({ data: matches(h.tables[table] ?? [], filters), error: null }),
  };
  return api;
}

function fakeDb() {
  return {
    from(table: string) {
      return {
        select: () => chain(table),
        delete: () => {
          const state: { filters: Array<[string, unknown]> } = { filters: [] };
          const api: Record<string, (...a: never[]) => unknown> = {
            eq: (c: string, v: unknown) => {
              state.filters.push([c, v]);
              return api;
            },
            then: (resolve: (v: { data: null; error: null }) => void) => {
              h.tables[table] = (h.tables[table] ?? []).filter(
                (r) => !state.filters.every(([c, v]) => r[c] === v),
              );
              return resolve({ data: null, error: null });
            },
          };
          return api;
        },
      };
    },
  };
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (min === "admin" && h.role !== "admin" && h.role !== "owner") {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return { supabase: fakeDb(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

const { DELETE } = await import("./route");

const del = (id: string) =>
  new Request(`https://app.test/api/integrations/meta-crm/datasets/${id}`, { method: "DELETE" });

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "admin-1";
  h.role = "admin";
  h.tables = {
    meta_crm_datasets: [
      {
        id: "row-a",
        account_id: "acct-1",
        business_portfolio_id: "BIZ",
        dataset_id: "111",
        dataset_name: "Himachal Vacation Triangle",
        dataset_type: "CRM",
        creation_status: "Created",
      },
      {
        id: "row-b",
        account_id: "acct-1",
        business_portfolio_id: "BIZ",
        dataset_id: "222",
        dataset_name: "Vacation Triangle 22 Nov",
        dataset_type: "CRM",
        creation_status: "Registered",
      },
      {
        id: "row-foreign",
        account_id: "acct-OTHER",
        business_portfolio_id: "BIZ",
        dataset_id: "999",
        dataset_name: "Foreign",
        dataset_type: "CRM",
        creation_status: "Created",
      },
    ],
    meta_crm_config: [],
    meta_crm_events: [
      {
        id: "evt-1",
        account_id: "acct-1",
        dataset_id: "111",
        event_name: "Lead",
        status: "pending",
      },
    ],
  };
});

describe("DELETE /api/integrations/meta-crm/datasets/[id]", () => {
  it("removes only the account's own registration; history rows survive", async () => {
    const res = await DELETE(del("row-a"), { params: Promise.resolve({ id: "row-a" }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; removed: { id: string; datasetId: string } };
    expect(json.ok).toBe(true);
    expect(json.removed).toMatchObject({ id: "row-a", datasetId: "111" });
    expect(h.tables.meta_crm_datasets.map((r) => r.id).sort()).toEqual(["row-b", "row-foreign"]);
    // Event history and queued rows are untouched.
    expect(h.tables.meta_crm_events).toHaveLength(1);
  });

  it("404s for unknown ids and other workspaces' rows (no cross-tenant delete)", async () => {
    const missing = await DELETE(del("nope"), { params: Promise.resolve({ id: "nope" }) });
    expect(missing.status).toBe(404);
    const foreign = await DELETE(del("row-foreign"), { params: Promise.resolve({ id: "row-foreign" }) });
    expect(foreign.status).toBe(404);
    expect(h.tables.meta_crm_datasets).toHaveLength(3);
  });

  it("rejects non-admin callers", async () => {
    h.role = "agent";
    const res = await DELETE(del("row-a"), { params: Promise.resolve({ id: "row-a" }) });
    expect(res.status).toBe(403);
    expect(h.tables.meta_crm_datasets).toHaveLength(3);
  });

  it("blocks removal of the dataset selected by an enabled CRM Feedback config", async () => {
    h.tables.meta_crm_config = [
      { account_id: "acct-1", enabled: true, dataset_ref: "row-a", dataset_id: "111" },
    ];
    const res = await DELETE(del("row-a"), { params: Promise.resolve({ id: "row-a" }) });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code?: string; error?: string };
    expect(json.code).toBe("dataset_in_use");
    expect(json.error).toContain("Disable CRM feedback");
    expect(h.tables.meta_crm_datasets).toHaveLength(3);
  });

  it("blocks by configured dataset_id even when the ref was nulled", async () => {
    h.tables.meta_crm_config = [{ account_id: "acct-1", enabled: true, dataset_ref: null, dataset_id: "111" }];
    const res = await DELETE(del("row-a"), { params: Promise.resolve({ id: "row-a" }) });
    expect(res.status).toBe(409);
  });

  it("allows removal once feedback is disabled (queued rows stay queued)", async () => {
    h.tables.meta_crm_config = [{ account_id: "acct-1", enabled: false, dataset_ref: "row-a", dataset_id: "111" }];
    const res = await DELETE(del("row-a"), { params: Promise.resolve({ id: "row-a" }) });
    expect(res.status).toBe(200);
    expect(h.tables.meta_crm_datasets.map((r) => r.id).sort()).toEqual(["row-b", "row-foreign"]);
    expect(h.tables.meta_crm_events).toHaveLength(1);
  });

  it("allows removing an unselected dataset while feedback uses another", async () => {
    h.tables.meta_crm_config = [{ account_id: "acct-1", enabled: true, dataset_ref: "row-b", dataset_id: "222" }];
    const res = await DELETE(del("row-a"), { params: Promise.resolve({ id: "row-a" }) });
    expect(res.status).toBe(200);
    expect(h.tables.meta_crm_datasets.map((r) => r.id).sort()).toEqual(["row-b", "row-foreign"]);
  });

  it("makes no Meta Graph API calls on this path", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(`${process.cwd()}/src/app/api/integrations/meta-crm/datasets/[id]/route.ts`, "utf8"),
    );
    expect(src).not.toContain("graph.facebook.com");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain("ads_dataset");
    expect(src).not.toContain("createCrmDataset");
  });
});
