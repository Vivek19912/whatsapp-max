// meta_crm_datasets persistence — duplicate protection + tenant scoping.
//
// Uses a minimal in-memory Supabase double; no network.

import { describe, expect, it } from "vitest";

import { listCrmDatasets, normalizePublicDatasets, saveCrmDataset } from "./store";

function makeDb(initial: Array<Record<string, unknown>> = []) {
  const rows = [...initial];
  const calls: Array<{ table: string; accountId: string | null }> = [];
  const db = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          const duplicate = rows.some(
            (r) =>
              r.account_id === payload.account_id && r.dataset_id === payload.dataset_id,
          );
          if (duplicate) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: { code: "23505" } }),
              }),
            };
          }
          const row = {
            id: `uuid-${rows.length + 1}`,
            ...payload,
            created_at: "2026-11-22T00:00:00.000Z",
            updated_at: "2026-11-22T00:00:00.000Z",
          };
          rows.push(row);
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
        select() {
          return {
            eq(col: string, val: unknown) {
              calls.push({ table, accountId: col === "account_id" ? (val as string) : null });
              const chain = {
                eq(c2: string, v2: unknown) {
                  void c2;
                  void v2;
                  return chain;
                },
                order() {
                  return {
                    limit: async () => ({
                      data: rows.filter((r) => r.account_id === val),
                      error: null,
                    }),
                  };
                },
                maybeSingle: async () => ({
                  data: rows.find((r) => r.account_id === val) ?? null,
                  error: null,
                }),
              };
              return chain;
            },
            order() {
              return {
                limit: async () => ({ data: rows, error: null }),
              };
            },
          };
        },
      };
    },
  };
  return { db: db as never, rows, calls };
}

describe("saveCrmDataset", () => {
  it("inserts metadata without secrets", async () => {
    const { db, rows } = makeDb();
    const { row, created } = await saveCrmDataset(db, {
      accountId: "acct-1",
      businessPortfolioId: "1171141236081090",
      datasetId: "1830596054845292",
      datasetName: "IM 22 Nov",
    });
    expect(created).toBe(true);
    expect(row.dataset_id).toBe("1830596054845292");
    expect(JSON.stringify(rows).toLowerCase()).not.toContain("token");
  });

  it("returns the existing row on duplicate instead of throwing", async () => {
    const existing = {
      id: "uuid-1",
      account_id: "acct-1",
      business_portfolio_id: "1171141236081090",
      dataset_id: "1830596054845292",
      dataset_name: "IM 22 Nov",
      dataset_type: "CRM",
      creation_status: "Created",
      created_by: "u1",
      created_at: "2026-11-22T00:00:00.000Z",
      updated_at: "2026-11-22T00:00:00.000Z",
    };
    const { db } = makeDb([existing]);
    const out = await saveCrmDataset(db, {
      accountId: "acct-1",
      businessPortfolioId: "1171141236081090",
      datasetId: "1830596054845292",
      datasetName: "IM 22 Nov",
    });
    expect(out.created).toBe(false);
    expect(out.row.id).toBe("uuid-1");
  });

  it("allows the same Meta dataset under different accounts", async () => {
    const { db } = makeDb([
      {
        id: "uuid-1",
        account_id: "acct-1",
        business_portfolio_id: "1171141236081090",
        dataset_id: "1830596054845292",
        dataset_name: "IM 22 Nov",
        dataset_type: "CRM",
        creation_status: "Created",
        created_by: "u1",
        created_at: "2026-11-22T00:00:00.000Z",
        updated_at: "2026-11-22T00:00:00.000Z",
      },
    ]);
    const out = await saveCrmDataset(db, {
      accountId: "acct-2",
      businessPortfolioId: "1171141236081090",
      datasetId: "1830596054845292",
      datasetName: "IM 22 Nov",
    });
    expect(out.created).toBe(true);
  });
});

describe("listCrmDatasets", () => {
  it("scopes reads to the caller's account", async () => {
    const { db, calls } = makeDb([
      {
        id: "uuid-1",
        account_id: "acct-1",
        dataset_id: "1",
        dataset_name: "A",
        business_portfolio_id: "B",
        dataset_type: "CRM",
        creation_status: "Created",
        created_by: null,
        created_at: "2026-11-22T00:00:00.000Z",
        updated_at: "2026-11-22T00:00:00.000Z",
      },
    ]);
    const rows = await listCrmDatasets(db, "acct-1");
    expect(rows).toHaveLength(1);
    expect(calls.some((c) => c.accountId === "acct-1")).toBe(true);
  });
});

describe("normalizePublicDatasets", () => {
  const created = {
    id: "row-created",
    account_id: "acct-1",
    business_portfolio_id: "1171141236081090",
    dataset_id: "1830596054845292",
    dataset_name: "IM 22 Nov",
    dataset_type: "CRM",
    creation_status: "Created",
    created_by: "u1",
    created_at: "2026-11-22T00:00:00.000Z",
    updated_at: "2026-11-22T00:00:00.000Z",
  };
  const registered = {
    id: "row-registered",
    account_id: "acct-1",
    business_portfolio_id: "1171141236081090",
    dataset_id: "1169732842278579",
    dataset_name: "IM CRM",
    dataset_type: "CRM",
    creation_status: "Registered",
    created_by: "u1",
    created_at: "2026-11-22T00:00:00.000Z",
    updated_at: "2026-11-22T00:00:00.000Z",
  };

  it("keeps both Created and Registered datasets with all fields", () => {
    const out = normalizePublicDatasets([created, registered]);
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.datasetId)).toEqual(["1830596054845292", "1169732842278579"]);
    const imCrm = out.find((d) => d.datasetId === "1169732842278579")!;
    expect(imCrm).toMatchObject({
      id: "row-registered",
      datasetName: "IM CRM",
      businessPortfolioId: "1171141236081090",
      datasetType: "CRM",
      creationStatus: "Registered",
    });
  });

  it("drops malformed rows without blanking valid ones", () => {
    const out = normalizePublicDatasets([
      registered,
      null,
      undefined,
      "nope",
      42,
      { id: "", dataset_id: "1169732842278579" },
      { id: "row-x" },
      { id: 7, dataset_id: "1169732842278579" },
      { id: "row-y", dataset_id: "   " },
    ]);
    expect(out.map((d) => d.datasetId)).toEqual(["1169732842278579"]);
  });

  it("returns [] for non-array payloads", () => {
    expect(normalizePublicDatasets(null)).toEqual([]);
    expect(normalizePublicDatasets(undefined)).toEqual([]);
    expect(normalizePublicDatasets({})).toEqual([]);
  });
});
