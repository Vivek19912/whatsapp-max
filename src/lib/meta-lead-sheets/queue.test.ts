// Meta Sheets outbox — idempotency, update-vs-append, retries,
// tenant isolation. Google API calls are mocked; no production
// spreadsheets are touched.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class SheetsAuthError extends Error {
    readonly code = "needs_reauth" as const;
  }
  return {
    SheetsAuthError,
    accessTokenFor: new Map<string, string>(),
    authFailsFor: new Set<string>(),
    tabsEnsured: [] as Array<{ spreadsheetId: string; tab: string }>,
    headersEnsured: [] as Array<{ spreadsheetId: string; tab: string }>,
    appended: [] as Array<{ spreadsheetId: string; tab: string; rows: string[][] }>,
    updated: [] as Array<{ spreadsheetId: string; tab: string; row: number; values: string[] }>,
    columnValues: new Map<string, string[]>(),
    failAppendWith: null as { status: number } | null,
  };
});

vi.mock("./oauth", () => ({
  SheetsAuthError: h.SheetsAuthError,
  getSheetsAccessToken: async (_db: unknown, accountId: string) => {
    if (h.authFailsFor.has(accountId)) {
      throw new h.SheetsAuthError("expired");
    }
    if (!h.accessTokenFor.has(accountId)) {
      throw new h.SheetsAuthError("No Google account is connected.");
    }
    return h.accessTokenFor.get(accountId)!;
  },
}));

vi.mock("./sheets-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sheets-client")>();
  return {
    ...actual,
    ensureSheetsTab: async (token: string, spreadsheetId: string, tab: string) => {
      h.tabsEnsured.push({ spreadsheetId, tab });
    },
    ensureSheetsHeader: async (token: string, spreadsheetId: string, tab: string) => {
      h.headersEnsured.push({ spreadsheetId, tab });
      return { updated: false };
    },
    appendSheetsRows: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      rows: string[][],
    ) => {
      if (h.failAppendWith) {
        throw new actual.SheetsApiError("quota", h.failAppendWith.status);
      }
      h.appended.push({ spreadsheetId, tab, rows });
      // Simulate Sheets storing the lead id in column A.
      const key = `${spreadsheetId}::${tab}`;
      const existing = h.columnValues.get(key) ?? [];
      for (const r of rows) existing.push(r[0]);
      h.columnValues.set(key, existing);
    },
    updateSheetsRow: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      rowNumber: number,
      values: string[],
    ) => {
      h.updated.push({ spreadsheetId, tab, row: rowNumber, values });
    },
    findSheetsRowsByLeadId: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      leadIds: string[],
    ) => {
      const key = `${spreadsheetId}::${tab}`;
      const cells = h.columnValues.get(key) ?? [];
      const found = new Map<string, number>();
      cells.forEach((cell, index) => {
        if (leadIds.includes(cell) && !found.has(cell)) found.set(cell, index + 2);
      });
      return found;
    },
  };
});

import { drainSheetsQueue, maybeEnqueueSheetsSync } from "./queue";

type Row = Record<string, unknown>;

function makeDb(initial: Record<string, Row[]>) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }
  let idCounter = 100;

  function matches(row: Row, filters: Array<{ op: string; col: string; val: unknown }>): boolean {
    for (const f of filters) {
      if (f.op === "eq" && row[f.col] !== f.val) return false;
      if (f.op === "in" && !(f.val as unknown[]).includes(row[f.col])) return false;
      if (f.op === "lte" && String(row[f.col] ?? "") > String(f.val)) return false;
      if (f.op === "not-null" && row[f.col] === null) return false;
    }
    return true;
  }

  function builder(table: string) {
    let op: "select" | "update" | "insert" | "delete" = "select";
    let patch: Row = {};
    let insertRows: Row[] = [];
    const filters: Array<{ op: string; col: string; val: unknown }> = [];
    let orderCol: string | null = null;
    let limitN: number | null = null;
    let selectCols = "*";

    const matched = () =>
      (data[table] ?? []).filter((r) => matches(r, filters));

    const b: Record<string, (...args: never[]) => unknown> = {
      select: ((cols?: string) => {
        selectCols = cols ?? "*";
        return b;
      }) as never,
      insert: ((rows: Row | Row[]) => {
        op = "insert";
        insertRows = Array.isArray(rows) ? rows : [rows];
        // Execute immediately for insert (no chaining in our code except insert alone).
        for (const r of insertRows) {
          if (table === "meta_lead_sheets_queue") {
            const dup = (data[table] ?? []).some(
              (existing) =>
                existing.account_id === r.account_id &&
                existing.submission_id === r.submission_id,
            );
            if (dup) {
              return Promise.resolve({
                data: null,
                error: { code: "23505", message: "duplicate" },
              });
            }
          }
          (data[table] ??= []).push({
            id: (r as Row).id ?? `q-${idCounter++}`,
            status: "queued",
            attempts: 0,
            max_attempts: 8,
            next_retry_at: new Date(0).toISOString(),
            claimed_at: null,
            sheet_row_number: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...r,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }) as never,
      update: ((p: Row) => {
        op = "update";
        patch = p;
        return b;
      }) as never,
      delete: (() => {
        op = "delete";
        return b;
      }) as never,
      eq: ((col: string, val: unknown) => {
        filters.push({ op: "eq", col, val });
        return b;
      }) as never,
      in: ((col: string, val: unknown[]) => {
        filters.push({ op: "in", col, val });
        return b;
      }) as never,
      lte: ((col: string, val: unknown) => {
        filters.push({ op: "lte", col, val });
        return b;
      }) as never,
      not: ((col: string, _op: string, val: unknown) => {
        // Only used as .not(col, "is", null)
        if (val === null) filters.push({ op: "not-null", col, val });
        return b;
      }) as never,
      order: ((col: string) => {
        orderCol = col;
        return b;
      }) as never,
      limit: ((n: number) => {
        limitN = n;
        return b;
      }) as never,
      maybeSingle: (async () => {
        if (op === "update") {
          // Capture targets BEFORE patching: real Supabase returns the
          // updated rows even when the patch moves them out of the
          // filter (e.g. claim queued -> sending).
          const targets = matched();
          for (const row of targets) Object.assign(row, patch);
          return { data: targets[0] ?? null, error: null };
        }
        if (op === "delete") {
          data[table] = (data[table] ?? []).filter((r) => !matches(r, filters));
          return { data: null, error: null };
        }
        let rows = matched();
        if (orderCol) {
          rows = [...rows].sort((a, b) =>
            String(a[orderCol!] ?? "").localeCompare(String(b[orderCol!] ?? "")),
          );
        }
        if (limitN !== null) rows = rows.slice(0, limitN);
        return { data: rows[0] ?? null, error: null };
      }) as never,
      then: ((res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === "update") {
          for (const row of matched()) Object.assign(row, patch);
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        if (op === "delete") {
          data[table] = (data[table] ?? []).filter((r) => !matches(r, filters));
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        let rows = matched();
        if (orderCol) {
          rows = [...rows].sort((a, b) =>
            String(a[orderCol!] ?? "").localeCompare(String(b[orderCol!] ?? "")),
          );
        }
        if (limitN !== null) rows = rows.slice(0, limitN);
        void selectCols;
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      }) as never,
    };
    return b;
  }

  return { db: { from: (t: string) => builder(t) } as unknown as SupabaseClient, data };
}

const SUB = {
  id: "sub-1",
  account_id: "acct-1",
  meta_lead_id: "lead-1",
  flow_run_id: "run-1",
  form_name: "Form A",
  campaign_name: "Camp",
  ad_name: "Ad",
  source: "facebook",
  answers: { full_name: "Asha", phone_number: "+911234567890" },
  meta_created_time: "2026-03-01T10:00:00.000Z",
  created_at: "2026-03-01T10:00:00.000Z",
  status: "processed",
};

const CONFIG = {
  account_id: "acct-1",
  spreadsheet_id: "sheet-1",
  sheet_tab: "Meta Leads",
  auto_sync: true,
};

beforeEach(() => {
  h.accessTokenFor = new Map();
  h.authFailsFor = new Set();
  h.tabsEnsured = [];
  h.headersEnsured = [];
  h.appended = [];
  h.updated = [];
  h.columnValues = new Map();
  h.failAppendWith = null;
});

describe("maybeEnqueueSheetsSync", () => {
  it("enqueues once; duplicates are a no-op", async () => {
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [{ ...CONFIG }],
      meta_lead_submissions: [{ ...SUB }],
      meta_lead_sheets_queue: [],
    });
    const first = await maybeEnqueueSheetsSync(db, { accountId: "acct-1", submissionId: "sub-1" });
    const second = await maybeEnqueueSheetsSync(db, { accountId: "acct-1", submissionId: "sub-1" });
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(data.meta_lead_sheets_queue).toHaveLength(1);
  });

  it("skips when auto_sync is off or the submission has no Workspace row", async () => {
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [{ ...CONFIG, auto_sync: false }],
      meta_lead_submissions: [{ ...SUB }],
      meta_lead_sheets_queue: [],
    });
    expect(
      (await maybeEnqueueSheetsSync(db, { accountId: "acct-1", submissionId: "sub-1" })).enqueued,
    ).toBe(false);
    expect(data.meta_lead_sheets_queue).toHaveLength(0);
  });
});

describe("drainSheetsQueue", () => {
  function baseTables(queueRows: Row[]) {
    return {
      meta_lead_sheets_configs: [{ ...CONFIG }],
      meta_lead_sheets_connections: [
        { account_id: "acct-1", access_token: "x", refresh_token: "y", token_expiry: new Date(Date.now() + 3600_000).toISOString() },
      ],
      meta_lead_submissions: [{ ...SUB }],
      meta_lead_sheets_queue: queueRows,
      flow_runs: [{ id: "run-1", account_id: "acct-1", flow_id: "flow-1" }],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    };
  }

  it("appends a new lead exactly once", async () => {
    h.accessTokenFor.set("acct-1", "token-1");
    const { db, data } = makeDb(
      baseTables([
        {
          id: "q-1",
          account_id: "acct-1",
          submission_id: "sub-1",
          flow_run_id: "run-1",
          meta_lead_id: "lead-1",
          status: "queued",
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ]),
    );
    const result = await drainSheetsQueue(db, { onlyAccountId: "acct-1", force: true });
    expect(result.sent).toBe(1);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe("lead-1");
    expect(data.meta_lead_sheets_queue[0].status).toBe("sent");
  });

  it("updates the existing row when the lead was already synced", async () => {
    h.accessTokenFor.set("acct-1", "token-1");
    h.columnValues.set("sheet-1::Meta Leads", ["lead-1"]);
    const { db } = makeDb(
      baseTables([
        {
          id: "q-1",
          account_id: "acct-1",
          submission_id: "sub-1",
          flow_run_id: "run-1",
          meta_lead_id: "lead-1",
          status: "queued",
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: 2,
          next_retry_at: new Date(0).toISOString(),
        },
      ]),
    );
    const result = await drainSheetsQueue(db, { onlyAccountId: "acct-1", force: true });
    expect(result.sent).toBe(1);
    expect(h.updated).toHaveLength(1);
    expect(h.updated[0].row).toBe(2);
    expect(h.appended).toHaveLength(0);
  });

  it("recovers the row number by scanning column A when the mapping was lost", async () => {
    h.accessTokenFor.set("acct-1", "token-1");
    // The row was appended before a crash; mapping is null but the
    // sheet already holds the lead.
    h.columnValues.set("sheet-1::Meta Leads", ["lead-1"]);
    const { db } = makeDb(
      baseTables([
        {
          id: "q-1",
          account_id: "acct-1",
          submission_id: "sub-1",
          flow_run_id: "run-1",
          meta_lead_id: "lead-1",
          status: "queued",
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ]),
    );
    const result = await drainSheetsQueue(db, { onlyAccountId: "acct-1", force: true });
    expect(result.sent).toBe(1);
    // No second row appended — the existing row was updated.
    expect(h.appended).toHaveLength(0);
    expect(h.updated).toHaveLength(1);
  });

  it("retries quota errors with backoff and never marks them sent", async () => {
    h.accessTokenFor.set("acct-1", "token-1");
    h.failAppendWith = { status: 429 };
    const { db, data } = makeDb(
      baseTables([
        {
          id: "q-1",
          account_id: "acct-1",
          submission_id: "sub-1",
          flow_run_id: "run-1",
          meta_lead_id: "lead-1",
          status: "queued",
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ]),
    );
    const result = await drainSheetsQueue(db, { onlyAccountId: "acct-1", force: true });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe("failed");
    expect((data.meta_lead_sheets_queue[0].attempts as number)).toBe(1);
  });

  it("reports expired credentials without losing the row", async () => {
    h.authFailsFor.add("acct-1");
    const { db, data } = makeDb(
      baseTables([
        {
          id: "q-1",
          account_id: "acct-1",
          submission_id: "sub-1",
          flow_run_id: "run-1",
          meta_lead_id: "lead-1",
          status: "queued",
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ]),
    );
    const result = await drainSheetsQueue(db, { onlyAccountId: "acct-1", force: true });
    expect(result.needsReauth).toBe(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe("queued");
    expect(h.appended).toHaveLength(0);
  });

  it("never touches another account's queue", async () => {
    h.accessTokenFor.set("acct-1", "token-1");
    const { db } = makeDb(
      baseTables([
        {
          id: "q-1",
          account_id: "acct-1",
          submission_id: "sub-1",
          flow_run_id: "run-1",
          meta_lead_id: "lead-1",
          status: "queued",
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: "q-2",
          account_id: "acct-2",
          submission_id: "sub-2",
          flow_run_id: "run-2",
          meta_lead_id: "lead-2",
          status: "queued",
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ]),
    );
    const result = await drainSheetsQueue(db, { onlyAccountId: "acct-1", force: true });
    expect(result.attempted).toBe(1);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe("lead-1");
  });

  it("a failed prompt drain recovers on the next drain without duplicating the row", async () => {
    h.accessTokenFor.set("acct-1", "token-1");
    // First attempt (prompt drain) hits a transient Google outage.
    h.failAppendWith = { status: 500 };
    const { db, data } = makeDb(
      baseTables([
        {
          id: "q-1",
          account_id: "acct-1",
          submission_id: "sub-1",
          flow_run_id: "run-1",
          meta_lead_id: "lead-1",
          status: "queued",
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ]),
    );
    const first = await drainSheetsQueue(db, { onlyAccountId: "acct-1", force: true });
    expect(first.sent).toBe(0);
    expect(first.failed).toBe(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe("failed");
    expect(h.appended).toHaveLength(0);

    // The five-minute cron fallback retries after backoff and the
    // lead lands exactly once.
    h.failAppendWith = null;
    data.meta_lead_sheets_queue[0].next_retry_at = new Date(0).toISOString();
    const second = await drainSheetsQueue(db, { onlyAccountId: "acct-1" });
    expect(second.sent).toBe(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe("sent");
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe("lead-1");
  });
});
