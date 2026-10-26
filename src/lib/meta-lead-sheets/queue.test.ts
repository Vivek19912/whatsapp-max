// Meta Sheets outbox — idempotency, update-vs-append, retries,
// tenant isolation. Google API calls are mocked; no production
// spreadsheets are touched.

import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class SheetsAuthError extends Error {
    readonly code = 'needs_reauth' as const;
  }
  return {
    SheetsAuthError,
    accessTokenFor: new Map<string, string>(),
    authFailsFor: new Set<string>(),
    quotaRefreshFor: new Set<string>(),
    missingTabs: new Set<string>(),
    tabsChecked: [] as Array<{ spreadsheetId: string; tab: string }>,
    tabsCreated: [] as Array<{ spreadsheetId: string; tab: string }>,
    headersEnsured: [] as Array<{ spreadsheetId: string; tab: string }>,
    headersWritten: [] as Array<{
      spreadsheetId: string;
      tab: string;
      headers: string[];
    }>,
    appended: [] as Array<{
      spreadsheetId: string;
      tab: string;
      rows: string[][];
    }>,
    updated: [] as Array<{
      spreadsheetId: string;
      tab: string;
      row: number;
      values: string[];
    }>,
    rewritten: [] as Array<{
      spreadsheetId: string;
      tab: string;
      rows: Array<{ rowNumber: number; values: string[] }>;
    }>,
    hidden: [] as Array<{
      spreadsheetId: string;
      tab: string;
      colIndex: number;
      hidden: boolean;
    }>,
    deleted: [] as Array<{
      spreadsheetId: string;
      tab: string;
      rows: number[];
    }>,
    columnValues: new Map<string, string[]>(),
    findCalls: [] as Array<{
      spreadsheetId: string;
      tab: string;
      leadIds: string[];
      idColumnIndex?: number;
    }>,
    failAppendWith: null as {
      status: number;
      reason?: string;
      retryAfterMs?: number | null;
    } | null,
    failFindWith: null as {
      status: number;
      reason?: string;
      retryAfterMs?: number | null;
    } | null,
    failFindOnCall: null as number | null,
    findCallCount: 0,
  };
});

vi.mock('./oauth', () => ({
  SheetsAuthError: h.SheetsAuthError,
  getSheetsAccessToken: async (_db: unknown, accountId: string) => {
    if (h.quotaRefreshFor.has(accountId)) {
      // Mock-safe quota signal: the drain detects this by name, the
      // same way it detects the real SheetsQuotaError.
      throw Object.assign(
        new Error('Google token endpoint throttled (429)'),
        {
          name: 'SheetsQuotaError',
          status: 429,
          retryAfterMs: 45_000,
        }
      );
    }
    if (h.authFailsFor.has(accountId)) {
      throw new h.SheetsAuthError('expired');
    }
    if (!h.accessTokenFor.has(accountId)) {
      throw new h.SheetsAuthError('No Google account is connected.');
    }
    return h.accessTokenFor.get(accountId)!;
  },
}));

vi.mock('./sheets-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sheets-client')>();
  return {
    ...actual,
    assertWorksheetTabExists: async (
      token: string,
      spreadsheetId: string,
      tab: string
    ) => {
      h.tabsChecked.push({ spreadsheetId, tab });
      if (h.missingTabs.has(`${spreadsheetId}::${tab}`)) {
        throw new actual.TabMissingError(spreadsheetId, tab, [
          'Sheet1',
          'Leads',
        ]);
      }
    },
    createWorksheetTab: async (
      token: string,
      spreadsheetId: string,
      tab: string
    ) => {
      h.tabsCreated.push({ spreadsheetId, tab });
    },
    ensureSheetsHeader: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      headers?: string[]
    ) => {
      h.headersEnsured.push({ spreadsheetId, tab });
      if (headers) h.headersWritten.push({ spreadsheetId, tab, headers });
      return { updated: false };
    },
    appendSheetsRows: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      rows: string[][]
    ) => {
      if (h.failAppendWith) {
        throw new actual.SheetsApiError(
          `quota${h.failAppendWith.reason ? ` [${h.failAppendWith.reason}]` : ''}`,
          h.failAppendWith.status,
          {
            reason: h.failAppendWith.reason ?? null,
            retryAfterMs: h.failAppendWith.retryAfterMs ?? null,
          }
        );
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
      values: string[]
    ) => {
      h.updated.push({ spreadsheetId, tab, row: rowNumber, values });
    },
    rewriteSheetRows: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      rows: Array<{ rowNumber: number; values: string[] }>
    ) => {
      h.rewritten.push({ spreadsheetId, tab, rows });
    },
    setSheetColumnHidden: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      colIndex: number,
      hidden: boolean
    ) => {
      h.hidden.push({ spreadsheetId, tab, colIndex, hidden });
    },
    deleteSheetRows: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      rowNumbers: number[]
    ) => {
      h.deleted.push({
        spreadsheetId,
        tab,
        rows: [...rowNumbers].sort((a, b) => a - b),
      });
      // Mirror Google's bottom-to-top delete in the tracked column.
      const key = `${spreadsheetId}::${tab}`;
      const cells = h.columnValues.get(key) ?? [];
      for (const n of [...rowNumbers].sort((a, b) => b - a)) {
        cells.splice(n - 2, 1);
      }
      h.columnValues.set(key, cells);
    },
    findSheetsRowsByLeadId: async (
      token: string,
      spreadsheetId: string,
      tab: string,
      leadIds: string[],
      _fetchImpl?: typeof fetch,
      idColumnIndex?: number
    ) => {
      const findCallNo = h.findCallCount++;
      if (
        h.failFindWith &&
        (h.failFindOnCall === null || h.failFindOnCall === findCallNo)
      ) {
        throw new actual.SheetsApiError(
          `quota${h.failFindWith.reason ? ` [${h.failFindWith.reason}]` : ''}`,
          h.failFindWith.status,
          {
            reason: h.failFindWith.reason ?? null,
            retryAfterMs: h.failFindWith.retryAfterMs ?? null,
          }
        );
      }
      h.findCalls.push({ spreadsheetId, tab, leadIds, idColumnIndex });
      const key = `${spreadsheetId}::${tab}`;
      const cells = h.columnValues.get(key) ?? [];
      const found = new Map<string, number>();
      cells.forEach((cell, index) => {
        if (leadIds.includes(cell) && !found.has(cell))
          found.set(cell, index + 2);
      });
      return found;
    },
  };
});

import {
  backfillFormSheets,
  cleanupTableRows,
  drainSheetsQueue,
  enqueueFormsDelta,
  getTableSheetsStatus,
  importTableLeads,
  invalidateTableRowMappings,
  isWithinImportRange,
  maybeEnqueueSheetsSync,
  planImportScope,
  remapLayoutChunk,
  resolveImportSubmittedAt,
  reviveTableFailedRows,
  verifyCleanupBatch,
} from './queue';

type Row = Record<string, unknown>;

function makeDb(initial: Record<string, Row[]>) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }
  let idCounter = 100;

  function matches(
    row: Row,
    filters: Array<{ op: string; col: string; val: unknown }>
  ): boolean {
    for (const f of filters) {
      if (f.op === 'eq' && row[f.col] !== f.val) return false;
      if (f.op === 'in' && !(f.val as unknown[]).includes(row[f.col]))
        return false;
      if (f.op === 'lte' && String(row[f.col] ?? '') > String(f.val))
        return false;
      if (f.op === 'gte' && String(row[f.col] ?? '') < String(f.val))
        return false;
      if (f.op === 'gt' && String(row[f.col] ?? '') <= String(f.val))
        return false;
      if (f.op === 'neq' && row[f.col] === f.val) return false;
      if (f.op === 'not-null' && row[f.col] === null) return false;
    }
    return true;
  }

  function builder(table: string) {
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let patch: Row = {};
    let insertRows: Row[] = [];
    const filters: Array<{ op: string; col: string; val: unknown }> = [];
    let orderCol: string | null = null;
    let limitN: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let selectCols = '*';

    const matched = () =>
      (data[table] ?? []).filter((r) => matches(r, filters));

    const paged = (rows: Row[]) => {
      if (rangeFrom !== null && rangeTo !== null) {
        return rows.slice(rangeFrom, rangeTo + 1);
      }
      if (limitN !== null) return rows.slice(0, limitN);
      return rows;
    };

    const b: Record<string, (...args: never[]) => unknown> = {
      select: ((cols?: string) => {
        selectCols = cols ?? '*';
        return b;
      }) as never,
      insert: ((rows: Row | Row[]) => {
        op = 'insert';
        insertRows = Array.isArray(rows) ? rows : [rows];
        // Execute immediately for insert (no chaining in our code except insert alone).
        for (const r of insertRows) {
          if (table === 'meta_lead_sheets_queue') {
            const dup = (data[table] ?? []).some(
              (existing) =>
                existing.account_id === r.account_id &&
                existing.submission_id === r.submission_id
            );
            if (dup) {
              return Promise.resolve({
                data: null,
                error: { code: '23505', message: 'duplicate' },
              });
            }
          }
          (data[table] ??= []).push({
            id: (r as Row).id ?? `q-${idCounter++}`,
            status: 'queued',
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
        op = 'update';
        patch = p;
        return b;
      }) as never,
      delete: (() => {
        op = 'delete';
        return b;
      }) as never,
      eq: ((col: string, val: unknown) => {
        filters.push({ op: 'eq', col, val });
        return b;
      }) as never,
      in: ((col: string, val: unknown[]) => {
        filters.push({ op: 'in', col, val });
        return b;
      }) as never,
      lte: ((col: string, val: unknown) => {
        filters.push({ op: 'lte', col, val });
        return b;
      }) as never,
      not: ((col: string, _op: string, val: unknown) => {
        // Only used as .not(col, "is", null)
        if (val === null) filters.push({ op: 'not-null', col, val });
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
      range: ((from: number, to: number) => {
        rangeFrom = from;
        rangeTo = to;
        return b;
      }) as never,
      gte: ((col: string, val: unknown) => {
        filters.push({ op: 'gte', col, val });
        return b;
      }) as never,
      gt: ((col: string, val: unknown) => {
        filters.push({ op: 'gt', col, val });
        return b;
      }) as never,
      neq: ((col: string, val: unknown) => {
        filters.push({ op: 'neq', col, val });
        return b;
      }) as never,
      maybeSingle: (async () => {
        if (op === 'update') {
          // Capture targets BEFORE patching: real Supabase returns the
          // updated rows even when the patch moves them out of the
          // filter (e.g. claim queued -> sending).
          const targets = matched();
          for (const row of targets) Object.assign(row, patch);
          return { data: targets[0] ?? null, error: null };
        }
        if (op === 'delete') {
          data[table] = (data[table] ?? []).filter((r) => !matches(r, filters));
          return { data: null, error: null };
        }
        let rows = matched();
        if (orderCol) {
          rows = [...rows].sort((a, b) =>
            String(a[orderCol!] ?? '').localeCompare(String(b[orderCol!] ?? ''))
          );
        }
        rows = paged(rows);
        return { data: rows[0] ?? null, error: null };
      }) as never,
      then: ((res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === 'update') {
          // Capture targets BEFORE patching (mirrors maybeSingle
          // above): real Supabase returns the updated rows even when
          // the patch moves them out of the filter.
          const targets = matched();
          for (const row of targets) Object.assign(row, patch);
          return Promise.resolve({ data: targets, error: null }).then(res, rej);
        }
        if (op === 'delete') {
          data[table] = (data[table] ?? []).filter((r) => !matches(r, filters));
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        let rows = matched();
        if (orderCol) {
          rows = [...rows].sort((a, b) =>
            String(a[orderCol!] ?? '').localeCompare(String(b[orderCol!] ?? ''))
          );
        }
        rows = paged(rows);
        void selectCols;
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

const SUB = {
  id: 'sub-1',
  account_id: 'acct-1',
  meta_lead_id: 'lead-1',
  flow_run_id: 'run-1',
  form_id: 'form-1',
  form_name: 'Form A',
  campaign_name: 'Camp',
  ad_name: 'Ad',
  source: 'facebook',
  answers: { full_name: 'Asha', phone_number: '+911234567890' },
  meta_created_time: '2026-03-01T10:00:00.000Z',
  created_at: '2026-03-01T10:00:00.000Z',
  status: 'processed',
};

const CONFIG = {
  account_id: 'acct-1',
  form_id: 'form-1',
  spreadsheet_id: 'sheet-1',
  sheet_tab: 'Meta Leads',
  auto_sync: true,
};

beforeEach(() => {
  h.accessTokenFor = new Map();
  h.authFailsFor = new Set();
  h.tabsChecked = [];
  h.tabsCreated = [];
  h.missingTabs = new Set();
  h.headersEnsured = [];
  h.headersWritten = [];
  h.appended = [];
  h.updated = [];
  h.rewritten = [];
  h.hidden = [];
  h.deleted = [];
  h.columnValues = new Map();
  h.findCalls = [];
  h.failAppendWith = null;
  h.failFindWith = null;
  h.failFindOnCall = null;
  h.findCallCount = 0;
  h.quotaRefreshFor = new Set();
});

describe('maybeEnqueueSheetsSync', () => {
  it('enqueues once; duplicates are a no-op', async () => {
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [{ ...CONFIG }],
      meta_lead_submissions: [{ ...SUB }],
      meta_lead_sheets_queue: [],
    });
    const first = await maybeEnqueueSheetsSync(db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    const second = await maybeEnqueueSheetsSync(db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(data.meta_lead_sheets_queue).toHaveLength(1);
  });

  it('skips when auto_sync is off or the submission has no Workspace row', async () => {
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [{ ...CONFIG, auto_sync: false }],
      meta_lead_submissions: [{ ...SUB }],
      meta_lead_sheets_queue: [],
    });
    expect(
      (
        await maybeEnqueueSheetsSync(db, {
          accountId: 'acct-1',
          submissionId: 'sub-1',
        })
      ).enqueued
    ).toBe(false);
    expect(data.meta_lead_sheets_queue).toHaveLength(0);
  });
});

describe('drainSheetsQueue', () => {
  function baseTables(queueRows: Row[]) {
    return {
      meta_lead_sheets_configs: [{ ...CONFIG }],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [{ ...SUB }],
      meta_lead_sheets_queue: queueRows,
      flow_runs: [{ id: 'run-1', account_id: 'acct-1', flow_id: 'flow-1' }],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    };
  }

  it('appends a new lead exactly once', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db, data } = makeDb(
      baseTables([
        {
          id: 'q-1',
          account_id: 'acct-1',
          submission_id: 'sub-1',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-1',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ])
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe('lead-1');
    expect(data.meta_lead_sheets_queue[0].status).toBe('sent');
  });

  it('updates the existing row when the lead was already synced', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.columnValues.set('sheet-1::Meta Leads', ['lead-1']);
    const { db } = makeDb(
      baseTables([
        {
          id: 'q-1',
          account_id: 'acct-1',
          submission_id: 'sub-1',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-1',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: 2,
          next_retry_at: new Date(0).toISOString(),
        },
      ])
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    expect(h.updated).toHaveLength(1);
    expect(h.updated[0].row).toBe(2);
    expect(h.appended).toHaveLength(0);
  });

  it('recovers the row number by scanning column A when the mapping was lost', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    // The row was appended before a crash; mapping is null but the
    // sheet already holds the lead.
    h.columnValues.set('sheet-1::Meta Leads', ['lead-1']);
    const { db } = makeDb(
      baseTables([
        {
          id: 'q-1',
          account_id: 'acct-1',
          submission_id: 'sub-1',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-1',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ])
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    // No second row appended — the existing row was updated.
    expect(h.appended).toHaveLength(0);
    expect(h.updated).toHaveLength(1);
  });

  it('retries quota errors with backoff and never marks them sent', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.failAppendWith = { status: 429 };
    const { db, data } = makeDb(
      baseTables([
        {
          id: 'q-1',
          account_id: 'acct-1',
          submission_id: 'sub-1',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-1',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ])
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(0);
    // Quota failures are scheduled for retry — never reported as
    // permanently failed.
    expect(result.failed).toBe(0);
    expect(result.retrying).toBe(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe('failed');
    expect(data.meta_lead_sheets_queue[0].attempts as number).toBe(1);
    // Jittered quota backoff (attempt 1: 30–60s), not the generic delay.
    const retryAt = Date.parse(
      data.meta_lead_sheets_queue[0].next_retry_at as string
    );
    expect(retryAt).toBeGreaterThan(Date.now() + 20_000);
    expect(retryAt).toBeLessThan(Date.now() + 5 * 60_000);
    expect(String(data.meta_lead_sheets_queue[0].last_error)).toContain(
      'quota'
    );
  });

  it('reports expired credentials without losing the row', async () => {
    h.authFailsFor.add('acct-1');
    const { db, data } = makeDb(
      baseTables([
        {
          id: 'q-1',
          account_id: 'acct-1',
          submission_id: 'sub-1',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-1',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ])
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.needsReauth).toBe(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe('queued');
    expect(h.appended).toHaveLength(0);
  });

  it("never touches another account's queue", async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db } = makeDb(
      baseTables([
        {
          id: 'q-1',
          account_id: 'acct-1',
          submission_id: 'sub-1',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-1',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: 'q-2',
          account_id: 'acct-2',
          submission_id: 'sub-2',
          flow_run_id: 'run-2',
          meta_lead_id: 'lead-2',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ])
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.attempted).toBe(1);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe('lead-1');
  });

  it('a failed prompt drain recovers on the next drain without duplicating the row', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    // First attempt (prompt drain) hits a transient Google outage.
    h.failAppendWith = { status: 500 };
    const { db, data } = makeDb(
      baseTables([
        {
          id: 'q-1',
          account_id: 'acct-1',
          submission_id: 'sub-1',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-1',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ])
    );
    const first = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(first.sent).toBe(0);
    expect(first.failed).toBe(0);
    expect(first.retrying).toBe(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe('failed');
    expect(h.appended).toHaveLength(0);

    // The five-minute cron fallback retries after backoff and the
    // lead lands exactly once.
    h.failAppendWith = null;
    data.meta_lead_sheets_queue[0].next_retry_at = new Date(0).toISOString();
    const second = await drainSheetsQueue(db, { onlyAccountId: 'acct-1' });
    expect(second.sent).toBe(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe('sent');
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe('lead-1');
  });
});

describe('per-table config — enqueue + backfill', () => {
  const SUB_A = {
    id: 'sub-a',
    account_id: 'acct-1',
    meta_lead_id: 'lead-a',
    flow_run_id: 'run-1',
    form_id: 'form-sg',
    form_name: 'Singapore Lead Ad',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha', budget: '5L' },
    meta_created_time: '2026-03-01T10:00:00.000Z',
    created_at: '2026-03-01T10:00:00.000Z',
    status: 'processed',
  };
  const SUB_B = {
    ...SUB_A,
    id: 'sub-b',
    meta_lead_id: 'lead-b',
    flow_run_id: 'run-2',
    form_id: 'form-other',
    form_name: 'Other Form',
    answers: { full_name: 'Ravi' },
  };

  it("maybeEnqueueSheetsSync requires this table's config (other tables never leak in)", async () => {
    const { db, data } = makeDb({
      // Only the OTHER table is configured.
      meta_lead_sheets_configs: [{ ...CONFIG, form_id: 'form-other' }],
      meta_lead_submissions: [SUB_A, SUB_B],
      meta_lead_sheets_queue: [],
    });
    expect(
      (
        await maybeEnqueueSheetsSync(db, {
          accountId: 'acct-1',
          submissionId: 'sub-a',
        })
      ).enqueued
    ).toBe(false);
    expect(
      (
        await maybeEnqueueSheetsSync(db, {
          accountId: 'acct-1',
          submissionId: 'sub-b',
        })
      ).enqueued
    ).toBe(true);
    expect(data.meta_lead_sheets_queue).toHaveLength(1);
    expect(data.meta_lead_sheets_queue[0].submission_id).toBe('sub-b');
  });

  it("maybeEnqueueSheetsSync skips when this table's auto_sync is off", async () => {
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [
        { ...CONFIG, form_id: 'form-sg', auto_sync: false },
      ],
      meta_lead_submissions: [SUB_A],
      meta_lead_sheets_queue: [],
    });
    expect(
      (
        await maybeEnqueueSheetsSync(db, {
          accountId: 'acct-1',
          submissionId: 'sub-a',
        })
      ).enqueued
    ).toBe(false);
    expect(data.meta_lead_sheets_queue).toHaveLength(0);
  });

  it("backfillFormSheets enqueues only this table's processed submissions", async () => {
    const FAILED = {
      ...SUB_B,
      id: 'sub-c',
      meta_lead_id: 'lead-c',
      status: 'failed',
    };
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [{ ...CONFIG, form_id: 'form-sg' }],
      meta_lead_submissions: [SUB_A, SUB_B, FAILED],
      meta_lead_sheets_queue: [],
    });
    const result = await backfillFormSheets(db, 'acct-1', 'form-sg', 500);
    expect(result).toMatchObject({ enqueued: 1, total: 1 });
    expect(data.meta_lead_sheets_queue).toHaveLength(1);
    expect(data.meta_lead_sheets_queue[0].submission_id).toBe('sub-a');
  });
});

describe('per-table drain filtering', () => {
  const FSG = 'form-sg';
  const FOTHER = 'form-other';
  const SUB_A = {
    id: 'sub-a',
    account_id: 'acct-1',
    meta_lead_id: 'lead-a',
    flow_run_id: 'run-1',
    form_id: FSG,
    form_name: 'Singapore Lead Ad',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha', phone_number: '+911234567890', budget: '5L' },
    meta_created_time: '2026-03-01T10:00:00.000Z',
    created_at: '2026-03-01T10:00:00.000Z',
    status: 'processed',
  };
  const SUB_B = {
    ...SUB_A,
    id: 'sub-b',
    meta_lead_id: 'lead-b',
    flow_run_id: 'run-2',
    form_id: FOTHER,
    form_name: 'Other Form',
    answers: { full_name: 'Ravi' },
  };
  const Q = (
    id: string,
    submissionId: string,
    metaLeadId: string,
    flowRunId: string
  ) => ({
    id,
    account_id: 'acct-1',
    submission_id: submissionId,
    flow_run_id: flowRunId,
    meta_lead_id: metaLeadId,
    status: 'queued',
    attempts: 0,
    max_attempts: 8,
    sheet_row_number: null,
    next_retry_at: new Date(0).toISOString(),
  });
  const CONN = {
    account_id: 'acct-1',
    access_token: 'x',
    refresh_token: 'y',
    token_expiry: new Date(Date.now() + 3600_000).toISOString(),
  };
  function tableTables(configs: Row[], queueRows: Row[], submissions: Row[]) {
    return {
      meta_lead_sheets_configs: configs,
      meta_lead_sheets_connections: [CONN],
      meta_lead_submissions: submissions,
      meta_lead_sheets_queue: queueRows,
      flow_runs: [
        { id: 'run-1', account_id: 'acct-1', flow_id: 'flow-1' },
        { id: 'run-2', account_id: 'acct-1', flow_id: 'flow-2' },
      ],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    };
  }
  const CFG = (
    formId: string,
    spreadsheetId = 'sheet-1',
    tab = 'Meta Leads'
  ) => ({
    ...CONFIG,
    form_id: formId,
    spreadsheet_id: spreadsheetId,
    sheet_tab: tab,
  });

  it('syncs only the table whose config exists (Singapore only)', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db, data } = makeDb(
      tableTables(
        [CFG(FSG)],
        [
          Q('q-a', 'sub-a', 'lead-a', 'run-1'),
          Q('q-b', 'sub-b', 'lead-b', 'run-2'),
        ],
        [SUB_A, SUB_B]
      )
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result).toMatchObject({
      attempted: 2,
      sent: 1,
      skippedNoConfig: 1,
      failed: 0,
    });
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe('lead-a');
    const parked = data.meta_lead_sheets_queue.find((r) => r.id === 'q-b')!;
    expect(parked.status).toBe('queued');
    expect(parked.attempts).toBe(0);
    expect(parked.claimed_at).toBeNull();
  });

  it('two tables sync to their own spreadsheets independently', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db } = makeDb(
      tableTables(
        [CFG(FSG, 'sheet-1', 'Tab A'), CFG(FOTHER, 'sheet-2', 'Tab B')],
        [
          Q('q-a', 'sub-a', 'lead-a', 'run-1'),
          Q('q-b', 'sub-b', 'lead-b', 'run-2'),
        ],
        [SUB_A, SUB_B]
      )
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result).toMatchObject({ attempted: 2, sent: 2, failed: 0 });
    const bySheet = new Map(
      h.appended.map((a) => [a.spreadsheetId, a.rows[0][0]])
    );
    expect(bySheet.get('sheet-1')).toBe('lead-a');
    expect(bySheet.get('sheet-2')).toBe('lead-b');
    expect(h.headersWritten.map((x) => x.spreadsheetId).sort()).toEqual([
      'sheet-1',
      'sheet-2',
    ]);
  });

  it('a missing table config parks the row; configuring resumes it', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db, data } = makeDb(
      tableTables([CFG(FSG)], [Q('q-b', 'sub-b', 'lead-b', 'run-2')], [SUB_B])
    );
    const parked = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(parked).toMatchObject({ sent: 0, skippedNoConfig: 1 });
    expect(h.appended).toHaveLength(0);

    // The table gets configured later (same form, own sheet).
    data.meta_lead_sheets_configs.push({ ...CFG(FOTHER, 'sheet-2', 'Tab B') });
    const resumed = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(resumed.sent).toBe(1);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      spreadsheetId: 'sheet-2',
      tab: 'Tab B',
    });
    expect(h.appended[0].rows[0][0]).toBe('lead-b');
  });

  it('onlyFormId narrows a table sync-now to that table', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db, data } = makeDb(
      tableTables(
        [CFG(FSG), CFG(FOTHER)],
        [
          Q('q-a', 'sub-a', 'lead-a', 'run-1'),
          Q('q-b', 'sub-b', 'lead-b', 'run-2'),
        ],
        [SUB_A, SUB_B]
      )
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      onlyFormId: FOTHER,
      force: true,
    });
    expect(result.sent).toBe(1);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe('lead-b');
    // The other table's row was never claimed.
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-a')!.status
    ).toBe('queued');
  });

  it('a row whose form config is disabled waits without consuming retries', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db, data } = makeDb(
      tableTables(
        [{ ...CFG(FSG), auto_sync: false }],
        [Q('q-a', 'sub-a', 'lead-a', 'run-1')],
        [SUB_A]
      )
    );
    const skipped = await drainSheetsQueue(db, { onlyAccountId: 'acct-1' });
    expect(skipped).toMatchObject({ sent: 0, skippedDisabled: 1, failed: 0 });
    expect(h.appended).toHaveLength(0);
    expect(data.meta_lead_sheets_queue[0].attempts).toBe(0);

    data.meta_lead_sheets_configs[0].auto_sync = true;
    const forced = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(forced.sent).toBe(1);
  });
});
describe('custom columns — drain rendering', () => {
  const COLS = [
    { key: 'name', label: 'Lead Name' },
    { key: 'answer:budget', label: 'Budget' },
    { key: 'answer:hotel_category', label: 'Hotel' },
  ];
  const SUB_C = {
    id: 'sub-c',
    account_id: 'acct-1',
    meta_lead_id: 'lead-c',
    flow_run_id: 'run-1',
    form_id: 'form-sg',
    form_name: 'Singapore Lead Ad',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha', budget: '5L' },
    meta_created_time: '2026-03-01T10:00:00.000Z',
    created_at: '2026-03-01T10:00:00.000Z',
    status: 'processed',
  };

  it('writes exactly the requested headers in order with mapped values', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db } = makeDb({
      meta_lead_sheets_configs: [
        { ...CONFIG, form_id: 'form-sg', column_config: COLS },
      ],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [SUB_C],
      meta_lead_sheets_queue: [
        {
          id: 'q-c',
          account_id: 'acct-1',
          submission_id: 'sub-c',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-c',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [{ id: 'run-1', account_id: 'acct-1', flow_id: 'flow-1' }],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    // Header row is exactly the requested layout (deselected ID
    // written last so matching keeps working).
    expect(h.headersWritten.at(-1)).toMatchObject({
      headers: ['Lead Name', 'Budget', 'Hotel', 'Meta Lead ID'],
    });
    // Dynamic answers map by key; the unprovided Hotel stays blank.
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows[0]).toEqual(['Asha', '5L', '', 'lead-c']);
  });

  it('matches rows through the configured ID column (last by default, first for legacy)', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    // The sheet's ID column carries "lead-c"; the stored mapping was
    // lost, so the drain must recover the row via a scan instead of
    // appending a duplicate.
    h.columnValues.set('sheet-1::Meta Leads', ['lead-c']);
    const { db } = makeDb({
      meta_lead_sheets_configs: [
        { ...CONFIG, form_id: 'form-sg', column_config: COLS },
      ],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [SUB_C],
      meta_lead_sheets_queue: [
        {
          id: 'q-c',
          account_id: 'acct-1',
          submission_id: 'sub-c',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-c',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [{ id: 'run-1', account_id: 'acct-1', flow_id: 'flow-1' }],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    // Found via scan — no duplicate appended — and the scan used the
    // trailing ID position (3 selected columns → index 3).
    expect(h.appended).toHaveLength(0);
    expect(h.updated).toHaveLength(1);
    expect(h.updated[0]).toMatchObject({
      row: 2,
      values: ['Asha', '5L', '', 'lead-c'],
    });
    expect(h.findCalls).toHaveLength(1);
    expect(h.findCalls[0]).toMatchObject({ idColumnIndex: 3 });
  });

  it('scans column A for legacy ID-first layouts', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.columnValues.set('sheet-1::Meta Leads', ['lead-c']);
    const { db } = makeDb({
      meta_lead_sheets_configs: [
        {
          ...CONFIG,
          form_id: 'form-sg',
          column_config: [
            { key: 'meta_lead_id', label: 'Meta Lead ID' },
            { key: 'name', label: 'Lead Name' },
          ],
        },
      ],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [SUB_C],
      meta_lead_sheets_queue: [
        {
          id: 'q-c',
          account_id: 'acct-1',
          submission_id: 'sub-c',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-c',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [{ id: 'run-1', account_id: 'acct-1', flow_id: 'flow-1' }],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    expect(h.appended).toHaveLength(0);
    expect(h.updated[0]).toMatchObject({
      row: 2,
      values: ['lead-c', 'Asha'],
    });
    expect(h.findCalls).toHaveLength(1);
    expect(h.findCalls[0]).toMatchObject({ idColumnIndex: 0 });
  });

  it('updates the live row when the ID column is hidden', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    // The trailing ID column still carries "lead-c" on the sheet,
    // but the ID is not a visible column. The stored number (5) is
    // stale — the live scan (row 2) wins, so the update lands on
    // the true row instead of overwriting an unrelated row 5.
    h.columnValues.set('sheet-1::Meta Leads', ['lead-c']);
    const { db } = makeDb({
      meta_lead_sheets_configs: [
        {
          ...CONFIG,
          form_id: 'form-sg',
          column_config: [{ key: 'phone', label: 'Phone' }],
        },
      ],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [
        { ...SUB_C, answers: { phone_number: '+911234567890' } },
      ],
      meta_lead_sheets_queue: [
        {
          id: 'q-c',
          account_id: 'acct-1',
          submission_id: 'sub-c',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-c',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: 5,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [{ id: 'run-1', account_id: 'acct-1', flow_id: 'flow-1' }],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    expect(h.updated).toHaveLength(1);
    expect(h.updated[0]).toMatchObject({
      row: 2,
      values: ['+911234567890', 'lead-c'],
    });
    expect(h.appended).toHaveLength(0);
    expect(h.headersWritten.at(-1)).toMatchObject({
      headers: ['Phone', 'Meta Lead ID'],
    });
  });
});

describe('layout remap', () => {
  const NEW_COLS = [
    { key: 'name', label: 'Lead Name' },
    { key: 'answer:budget', label: 'Budget' },
  ];
  const SUB_A = {
    id: 'sub-a',
    account_id: 'acct-1',
    meta_lead_id: 'lead-a',
    flow_run_id: 'run-1',
    form_id: 'form-sg',
    form_name: 'Singapore Lead Ad',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha', budget: '5L' },
    meta_created_time: '2026-03-01T10:00:00.000Z',
    created_at: '2026-03-01T10:00:00.000Z',
    status: 'processed',
  };
  const SUB_B = {
    ...SUB_A,
    id: 'sub-b',
    meta_lead_id: 'lead-b',
    flow_run_id: 'run-2',
    answers: { full_name: 'Ravi' },
  };
  function remapTables(cursor: number | null) {
    return {
      meta_lead_sheets_configs: [
        {
          ...CONFIG,
          form_id: 'form-sg',
          column_config: NEW_COLS,
          pending_remap: true,
          remap_cursor: cursor,
        },
      ],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [SUB_A, SUB_B],
      meta_lead_sheets_queue: [
        {
          id: 'q-a',
          account_id: 'acct-1',
          submission_id: 'sub-a',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-a',
          status: 'sent',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: 2,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: 'q-b',
          account_id: 'acct-1',
          submission_id: 'sub-b',
          flow_run_id: 'run-2',
          meta_lead_id: 'lead-b',
          status: 'sent',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: 3,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [
        { id: 'run-1', account_id: 'acct-1', flow_id: 'flow-1' },
        { id: 'run-2', account_id: 'acct-1', flow_id: 'flow-2' },
      ],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    };
  }

  it('rewrites managed rows in place without duplicating, then swaps the header', async () => {
    h.columnValues.set('sheet-1::Meta Leads', ['lead-a', 'lead-b']);
    const { db, data } = makeDb(remapTables(0));
    const first = await remapLayoutChunk(
      db,
      'token-1',
      {
        account_id: 'acct-1',
        form_id: 'form-sg',
        spreadsheet_id: 'sheet-1',
        sheet_tab: 'Meta Leads',
        column_config: NEW_COLS,
      },
      0
    );
    expect(first.done).toBe(false);
    expect(first.remapped).toBe(2);
    // Both managed rows rewritten in place with the new values
    // (ID last per the new layout).
    expect(h.rewritten).toHaveLength(1);
    expect(h.rewritten[0].rows).toEqual([
      { rowNumber: 2, values: ['Asha', '5L', 'lead-a'] },
      { rowNumber: 3, values: ['Ravi', '', 'lead-b'] },
    ]);
    expect(h.appended).toHaveLength(0);
    expect(data.meta_lead_sheets_configs[0].remap_cursor).toBe(3);

    const second = await remapLayoutChunk(
      db,
      'token-1',
      {
        account_id: 'acct-1',
        spreadsheet_id: 'sheet-1',
        form_id: 'form-sg',
        sheet_tab: 'Meta Leads',
        column_config: NEW_COLS,
      },
      3
    );
    expect(second.done).toBe(true);
    // Header swapped last; hidden ID column stays hidden at its
    // new trailing position (legacy column A unhidden first).
    expect(h.headersWritten.at(-1)).toMatchObject({
      headers: ['Lead Name', 'Budget', 'Meta Lead ID'],
    });
    expect(h.hidden.at(-1)).toMatchObject({ colIndex: 2, hidden: true });
    expect(data.meta_lead_sheets_configs[0].pending_remap).toBe(false);
  });

  it('a drain interleaves one remap chunk with live sync (no starvation)', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.columnValues.set('sheet-1::Meta Leads', ['lead-a', 'lead-b']);
    const { db, data } = makeDb(remapTables(0));
    // A due row is delivered in the SAME run that advances the
    // rollout: large remaps never block newly arriving leads.
    data.meta_lead_sheets_queue.push({
      id: 'q-new',
      account_id: 'acct-1',
      submission_id: 'sub-a',
      flow_run_id: 'run-1',
      meta_lead_id: 'lead-a',
      status: 'queued',
      attempts: 0,
      max_attempts: 8,
      sheet_row_number: null,
      next_retry_at: new Date(0).toISOString(),
    });
    const first = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(h.rewritten).toHaveLength(1);
    expect(first.sent).toBe(1);
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-new')?.status,
    ).toBe('sent');

    const second = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(second).toMatchObject({ attempted: 0, sent: 0 });
    expect(data.meta_lead_sheets_configs[0].pending_remap).toBe(false);
  });

  it("a table-scoped drain never runs another account's remap", async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.columnValues.set('sheet-2::Other', ['lead-x']);
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [
        {
          ...CONFIG,
          account_id: 'acct-2',
          form_id: 'form-remote',
          spreadsheet_id: 'sheet-2',
          sheet_tab: 'Other',
          column_config: NEW_COLS,
          pending_remap: true,
          remap_cursor: 0,
        },
      ],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-2',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [],
      meta_lead_sheets_queue: [],
      flow_runs: [],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      onlyFormId: 'form-sg',
      force: true,
    });
    // No cross-account remap writes, no quota consumed elsewhere.
    expect(h.rewritten).toHaveLength(0);
    expect(data.meta_lead_sheets_configs[0].pending_remap).toBe(true);
    expect(data.meta_lead_sheets_configs[0].remap_cursor).toBe(0);
    expect(result).toMatchObject({ attempted: 0, sent: 0 });
  });
});

describe("cleanup of this table's rows", () => {
  const SUB_A = {
    id: 'sub-a',
    account_id: 'acct-1',
    meta_lead_id: 'lead-a',
    flow_run_id: 'run-1',
    form_id: 'form-sg',
    form_name: 'Singapore Lead Ad',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha' },
    meta_created_time: '2026-03-01T10:00:00.000Z',
    created_at: '2026-03-01T10:00:00.000Z',
    status: 'processed',
  };
  const SUB_B = {
    ...SUB_A,
    id: 'sub-b',
    meta_lead_id: 'lead-b',
    form_id: 'form-other',
  };
  function cleanupTables() {
    return {
      meta_lead_sheets_configs: [
        { ...CONFIG, form_id: 'form-sg' },
        { ...CONFIG, form_id: 'form-other' },
      ],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [SUB_A, SUB_B],
      meta_lead_sheets_queue: [
        {
          id: 'q-a',
          account_id: 'acct-1',
          submission_id: 'sub-a',
          status: 'sent',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: 2,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: 'q-b',
          account_id: 'acct-1',
          submission_id: 'sub-b',
          status: 'sent',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: 3,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: 'q-orphan',
          account_id: 'acct-1',
          submission_id: 'sub-b',
          status: 'sent',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    };
  }

  it("deletes only this table's verified rows, fixes numbers, never touches the rest", async () => {
    h.columnValues.set('sheet-1::Meta Leads', ['lead-a', 'lead-b']);
    const { db, data } = makeDb(cleanupTables());
    const result = await cleanupTableRows(db, 'token-1', 'acct-1', 'form-sg');
    expect(result).toEqual({ removed: 1, skippedUnmapped: 1 });
    // Exactly this table's mapped row.
    expect(h.deleted).toEqual([
      { spreadsheetId: 'sheet-1', tab: 'Meta Leads', rows: [2] },
    ]);
    // Removed queue row is gone; the other table's row shifted up (3 → 2).
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-a')
    ).toBeUndefined();
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-b')!.sheet_row_number
    ).toBe(2);
    // The unmapped row is never touched.
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-orphan')
    ).toBeDefined();
  });

  it('is a no-op when this table has no mapped rows', async () => {
    h.columnValues.set('sheet-1::Meta Leads', ['lead-a']);
    const { db, data } = makeDb(cleanupTables());
    // Drop form-sg's mapping so only unmapped/other-form rows remain.
    const rows = data.meta_lead_sheets_queue;
    rows.find((r) => r.id === 'q-a')!.sheet_row_number = null;
    const result = await cleanupTableRows(db, 'token-1', 'acct-1', 'form-sg');
    expect(result).toEqual({ removed: 0, skippedUnmapped: 2 });
    expect(h.deleted).toHaveLength(0);
    expect(data.meta_lead_sheets_queue).toHaveLength(3);
  });

  it('refuses without a table config', async () => {
    const { db } = makeDb({
      meta_lead_sheets_configs: [{ ...CONFIG, form_id: 'form-sg' }],
      meta_lead_submissions: [],
      meta_lead_sheets_queue: [],
    });
    await expect(
      cleanupTableRows(db, 'token-1', 'acct-1', 'form-missing')
    ).rejects.toThrow(/not configured/);
  });
});

describe('missing worksheet tab - explicit error, never silent writes', () => {
  const SUB_X = {
    id: 'sub-x',
    account_id: 'acct-1',
    meta_lead_id: 'lead-x',
    flow_run_id: 'run-1',
    form_id: 'form-sg',
    form_name: 'Singapore Lead Ad',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha' },
    meta_created_time: '2026-03-01T10:00:00.000Z',
    created_at: '2026-03-01T10:00:00.000Z',
    status: 'processed',
  };
  function tabTables() {
    return {
      meta_lead_sheets_configs: [{ ...CONFIG, form_id: 'form-sg' }],
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          access_token: 'x',
          refresh_token: 'y',
          token_expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      meta_lead_submissions: [SUB_X],
      meta_lead_sheets_queue: [
        {
          id: 'q-x',
          account_id: 'acct-1',
          submission_id: 'sub-x',
          flow_run_id: 'run-1',
          meta_lead_id: 'lead-x',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [{ id: 'run-1', account_id: 'acct-1', flow_id: 'flow-1' }],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    };
  }

  it('fails a missing tab terminally and surfaces which tabs exist', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.missingTabs.add('sheet-1::Meta Leads');
    const { db, data } = makeDb(tabTables());
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result).toMatchObject({ sent: 0, failed: 1, retrying: 0 });
    expect(h.appended).toHaveLength(0);
    expect(h.updated).toHaveLength(0);
    const row = data.meta_lead_sheets_queue[0];
    expect(row.status).toBe('failed');
    // Terminal: budget spent at once so the row stops consuming
    // quota until a manual retry revives it.
    expect(row.attempts).toBe(row.max_attempts);
    expect(String(row.last_error)).toContain('Meta Leads');
    expect(String(row.last_error)).toContain('retry limit reached');
    // Parked far out (30 days), not hammered daily.
    expect(Date.parse(row.next_retry_at as string)).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60_000
    );
    // The table's config carries the actionable error (with tab list).
    expect(String(data.meta_lead_sheets_configs[0].last_error)).toContain(
      'Meta Leads'
    );
  });

  it('validates the tab before any write, on the configured tab only', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db } = makeDb(tabTables());
    await drainSheetsQueue(db, { onlyAccountId: 'acct-1', force: true });
    expect(h.tabsChecked).toEqual([
      { spreadsheetId: 'sheet-1', tab: 'Meta Leads' },
    ]);
  });
});

describe('getTableSheetsStatus - per-table counts and connection', () => {
  const SUB_A = {
    id: 'sub-a',
    account_id: 'acct-1',
    meta_lead_id: 'lead-a',
    flow_run_id: 'run-1',
    form_id: 'form-sg',
    form_name: 'Singapore Lead Ad',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha' },
    meta_created_time: '2026-03-01T10:00:00.000Z',
    created_at: '2026-03-01T10:00:00.000Z',
    status: 'processed',
  };
  const SUB_B = {
    ...SUB_A,
    id: 'sub-b',
    meta_lead_id: 'lead-b',
    form_id: 'form-other',
  };
  const SUB_C = { ...SUB_A, id: 'sub-c', meta_lead_id: 'lead-c' };
  function statusTables() {
    return {
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          google_email: 'owner@example.com',
          last_error: null,
        },
      ],
      meta_lead_sheets_configs: [
        {
          ...CONFIG,
          form_id: 'form-sg',
          spreadsheet_id: 'sheet-1',
          spreadsheet_url: 'https://docs/x',
          sheet_tab: 'Leads',
          column_config: [{ key: 'name', label: 'Name' }],
        },
      ],
      meta_lead_submissions: [SUB_A, SUB_B, SUB_C],
      meta_lead_sheets_queue: [
        {
          id: 'q-1',
          account_id: 'acct-1',
          submission_id: 'sub-a',
          status: 'sent',
          sheet_row_number: 2,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: 'q-2',
          account_id: 'acct-1',
          submission_id: 'sub-a',
          status: 'queued',
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: 'q-3',
          account_id: 'acct-1',
          submission_id: 'sub-b',
          status: 'failed',
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: 'q-4',
          account_id: 'acct-1',
          submission_id: 'sub-c',
          status: 'sent',
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    };
  }

  it("counts only this table's submissions and never returns tokens", async () => {
    const { db } = makeDb(statusTables());
    const sg = await getTableSheetsStatus(db, 'acct-1', 'form-sg');
    expect(sg.connected).toBe(true);
    expect(sg.email).toBe('owner@example.com');
    expect(sg.spreadsheetId).toBe('sheet-1');
    expect(sg.pending).toBe(1);
    expect(sg.failed).toBe(0);
    expect(sg.retrying).toBe(0);
    expect(sg.cleanupPreview).toEqual({ managedRows: 1 });
    expect(sg.columns).toEqual([{ key: 'name', label: 'Name' }]);
    const raw = JSON.stringify(sg);
    expect(raw).not.toContain('token');

    const other = await getTableSheetsStatus(db, 'acct-1', 'form-other');
    expect(other.pending).toBe(0);
    // q-3 failed but retains budget: scheduled for retry, not dead.
    expect(other.failed).toBe(0);
    expect(other.retrying).toBe(1);
    expect(other.cleanupPreview).toEqual({ managedRows: 0 });
    expect(other.spreadsheetId).toBeNull();
    expect(other.columns).toBeNull();
  });

  it('flags revoked credentials without exposing them', async () => {
    const { db } = makeDb({
      ...statusTables(),
      meta_lead_sheets_connections: [
        {
          account_id: 'acct-1',
          google_email: 'owner@example.com',
          last_error: 'revoked',
        },
      ],
    });
    const status = await getTableSheetsStatus(db, 'acct-1', 'form-sg');
    expect(status.needsReauth).toBe(true);
    expect(status.lastError).toBe('revoked');
  });
});

describe('importTableLeads — manual historical import', () => {
  const FORM = 'form-sg';
  function sub(
    id: string,
    opts: {
      runId?: string | null;
      metaCreated?: string | null;
      created?: string;
      form?: string;
      account?: string;
      lead?: string;
    } = {},
  ) {
    return {
      id,
      account_id: opts.account ?? 'acct-1',
      meta_lead_id: opts.lead ?? `lead-${id}`,
      flow_run_id: opts.runId === undefined ? `run-${id}` : opts.runId,
      form_id: opts.form ?? FORM,
      form_name: 'Singapore Lead Ad',
      campaign_name: 'Camp',
      ad_name: 'Ad',
      source: 'facebook',
      answers: { full_name: 'Asha' },
      meta_created_time: opts.metaCreated === undefined ? '2026-03-10T10:00:00.000Z' : opts.metaCreated,
      created_at: opts.created ?? '2026-03-10T10:00:00.000Z',
      status: 'processed',
    };
  }
  function run(id: string, startedAt: string | null) {
    return { id, account_id: 'acct-1', flow_id: 'flow-1', started_at: startedAt };
  }
  function queueRow(subId: string, opts: { status?: string; rowNumber?: number | null } = {}) {
    return {
      id: `q-${subId}`,
      account_id: 'acct-1',
      submission_id: subId,
      flow_run_id: `run-${subId}`,
      meta_lead_id: `lead-${subId}`,
      status: opts.status ?? 'queued',
      attempts: 0,
      max_attempts: 8,
      sheet_row_number: opts.rowNumber ?? null,
      next_retry_at: new Date(0).toISOString(),
    };
  }
  function importDb(extra: Record<string, Row[]>) {
    return makeDb({
      meta_lead_submissions: [],
      flow_runs: [],
      meta_lead_sheets_queue: [],
      workspace_fields: [],
      workspace_values: [{ field_id: 'f-1', value_text: 'keep-me' }],
      profiles: [],
      ...extra,
    });
  }

  it('imports everything in all-mode, classifying mapped rows as updates', async () => {
    const { db, data } = importDb({
      meta_lead_submissions: [sub('a'), sub('b'), sub('c', { runId: null })],
      flow_runs: [run('run-a', '2026-03-10T12:00:00.000Z'), run('run-b', '2026-03-11T12:00:00.000Z')],
      meta_lead_sheets_queue: [queueRow('a', { status: 'sent', rowNumber: 7 })],
    });
    const res = await importTableLeads(db, 'acct-1', FORM, null);
    expect(res).toEqual({
      total: 2,
      imported: 1,
      updated: 1,
      skipped: 1,
      failed: 0,
      truncated: false,
    });
    // Fresh lead queued; mapped lead reset to queued (not duplicated).
    expect(data.meta_lead_sheets_queue).toHaveLength(2);
    expect(
      data.meta_lead_sheets_queue.find((r) => r.submission_id === 'a')?.status,
    ).toBe('queued');
    // Workspace data untouched.
    expect(data.workspace_values).toEqual([{ field_id: 'f-1', value_text: 'keep-me' }]);
  });

  it('filters by inclusive Workspace submission-day range (run start wins)', async () => {
    const { db, data } = importDb({
      meta_lead_submissions: [
        sub('a', { metaCreated: '2026-03-10T10:00:00.000Z' }),
        // Meta time is outside the range but the run start is inside.
        sub('b', { metaCreated: '2026-01-01T00:00:00.000Z' }),
        // Exact to-boundary instant (end of day) is included.
        sub('e'),
        // Just before the from-boundary is excluded.
        sub('f'),
        sub('other', { form: 'form-other' }),
      ],
      flow_runs: [
        run('run-a', '2026-03-10T12:00:00.000Z'),
        run('run-b', '2026-03-15T00:00:00.000Z'),
        run('run-e', '2026-03-15T23:59:59.999Z'),
        run('run-f', '2026-02-28T23:59:59.999Z'),
        run('run-other', '2026-03-10T12:00:00.000Z'),
      ],
      meta_lead_sheets_queue: [],
    });
    const res = await importTableLeads(db, 'acct-1', FORM, {
      from: '2026-03-01',
      to: '2026-03-15',
    });
    expect(res.total).toBe(3);
    expect(res.imported).toBe(3);
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.failed).toBe(0);
    // Only the in-scope submissions of THIS form were queued.
    expect(
      data.meta_lead_sheets_queue.map((r) => r.submission_id).sort(),
    ).toEqual(['a', 'b', 'e']);
  });

  it('returns empty results when nothing falls in range', async () => {
    const { db, data } = importDb({
      meta_lead_submissions: [sub('a')],
      flow_runs: [run('run-a', '2026-03-10T12:00:00.000Z')],
      meta_lead_sheets_queue: [],
    });
    const res = await importTableLeads(db, 'acct-1', FORM, {
      from: '2026-04-01',
      to: '2026-04-30',
    });
    expect(res).toEqual({
      total: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      truncated: false,
    });
    expect(data.meta_lead_sheets_queue).toHaveLength(0);
  });

  it('never touches other forms or accounts', async () => {
    const { db, data } = importDb({
      meta_lead_submissions: [
        sub('a'),
        sub('x', { form: 'form-other' }),
        sub('y', { account: 'acct-2' }),
      ],
      flow_runs: [run('run-a', '2026-03-10T12:00:00.000Z')],
      meta_lead_sheets_queue: [],
    });
    const res = await importTableLeads(db, 'acct-1', FORM, null);
    expect(res.total).toBe(1);
    expect(
      data.meta_lead_sheets_queue.map((r) => r.submission_id),
    ).toEqual(['a']);
  });

  it('pages through the full set past the per-page bound (never truncated)', async () => {
    const { db, data } = importDb({
      meta_lead_submissions: [
        sub('a'),
        sub('b'),
        sub('c'),
        sub('d'),
        sub('e', { runId: null }),
      ],
      flow_runs: [
        run('run-a', '2026-03-10T12:00:00.000Z'),
        run('run-b', '2026-03-11T12:00:00.000Z'),
        run('run-c', '2026-03-12T12:00:00.000Z'),
        run('run-d', '2026-03-13T12:00:00.000Z'),
      ],
      meta_lead_sheets_queue: [],
    });
    // limit is now the per-page bound, not a total cap: all four
    // syncable leads classify (one run-less row skipped), and the
    // flag stays false so the UI never asks for a repeat that
    // could not advance pagination.
    const res = await importTableLeads(db, 'acct-1', FORM, null, 2);
    expect(res.truncated).toBe(false);
    expect(res.total).toBe(4);
    expect(res.imported).toBe(4);
    expect(res.skipped).toBe(1);
    expect(
      data.meta_lead_sheets_queue.map((r) => r.submission_id).sort(),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters a multi-page set by inclusive date range without gaps', async () => {
    const subs = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
      sub(id, {
        created: `2026-03-0${i + 1}T10:00:00.000Z`,
        metaCreated: `2026-03-0${i + 1}T10:00:00.000Z`,
      }),
    );
    const runs = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
      run(`run-${id}`, `2026-03-0${i + 1}T12:00:00.000Z`),
    );
    const { db } = importDb({
      meta_lead_submissions: subs,
      flow_runs: runs,
      meta_lead_sheets_queue: [],
    });
    const res = await importTableLeads(
      db,
      'acct-1',
      FORM,
      { from: '2026-03-02', to: '2026-03-04' },
      2,
    );
    expect(res.truncated).toBe(false);
    expect(res.total).toBe(3);
    expect(res.imported).toBe(3);
  });
});

describe('import range helpers', () => {
  it('prefers run start, then Meta time, then row creation', () => {
    expect(
      resolveImportSubmittedAt({
        runStartedAt: '2026-03-10T12:00:00.000Z',
        metaCreatedTime: '2026-03-09T00:00:00.000Z',
        createdAt: '2026-03-08T00:00:00.000Z',
      }),
    ).toBe('2026-03-10T12:00:00.000Z');
    expect(
      resolveImportSubmittedAt({
        runStartedAt: null,
        metaCreatedTime: '2026-03-09T00:00:00.000Z',
        createdAt: '2026-03-08T00:00:00.000Z',
      }),
    ).toBe('2026-03-09T00:00:00.000Z');
    expect(
      resolveImportSubmittedAt({ runStartedAt: null, metaCreatedTime: '  ', createdAt: null }),
    ).toBeNull();
  });

  it('treats both range ends as inclusive UTC days', () => {
    expect(isWithinImportRange('2026-03-01T00:00:00.000Z', '2026-03-01', '2026-03-31')).toBe(true);
    expect(isWithinImportRange('2026-03-31T23:59:59.999Z', '2026-03-01', '2026-03-31')).toBe(true);
    expect(isWithinImportRange('2026-02-28T23:59:59.999Z', '2026-03-01', '2026-03-31')).toBe(false);
    expect(isWithinImportRange('2026-04-01T00:00:00.000Z', '2026-03-01', '2026-03-31')).toBe(false);
    expect(isWithinImportRange(null, '2026-03-01', '2026-03-31')).toBe(false);
    expect(isWithinImportRange('2026-03-10T00:00:00.000Z', 'not-a-day', '2026-03-31')).toBe(false);
  });
});

describe('drainSheetsQueue — quota, batching, and safe retry', () => {
  const FSG = 'form-sg';
  const FOTHER = 'form-other';
  const CONN = (over: Row = {}) => ({
    account_id: 'acct-1',
    access_token: 'x',
    refresh_token: 'y',
    token_expiry: new Date(Date.now() + 3600_000).toISOString(),
    last_error: null,
    ...over,
  });
  const QR = (
    id: string,
    submissionId: string,
    metaLeadId: string,
    over: Row = {}
  ) => ({
    id,
    account_id: 'acct-1',
    submission_id: submissionId,
    flow_run_id: `run-${submissionId}`,
    meta_lead_id: metaLeadId,
    status: 'queued',
    attempts: 0,
    max_attempts: 8,
    sheet_row_number: null,
    next_retry_at: new Date(0).toISOString(),
    ...over,
  });
  const SUBQ = (id: string, formId: string, metaLeadId: string) => ({
    id,
    account_id: 'acct-1',
    meta_lead_id: metaLeadId,
    flow_run_id: `run-${id}`,
    form_id: formId,
    form_name: 'Form',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha' },
    meta_created_time: '2026-03-01T10:00:00.000Z',
    created_at: '2026-03-01T10:00:00.000Z',
    status: 'processed',
  });
  const CFGQ = (formId: string, spreadsheetId = 'sheet-1', tab = 'Meta Leads') => ({
    account_id: 'acct-1',
    form_id: formId,
    spreadsheet_id: spreadsheetId,
    spreadsheet_url: null,
    spreadsheet_title: null,
    sheet_tab: tab,
    auto_sync: true,
  });
  function quotaTables(queueRows: Row[], submissions: Row[], configs: Row[]) {
    return {
      meta_lead_sheets_configs: configs,
      meta_lead_sheets_connections: [CONN()],
      meta_lead_submissions: submissions,
      meta_lead_sheets_queue: queueRows,
      flow_runs: submissions.map((s) => ({
        id: s.flow_run_id,
        account_id: 'acct-1',
        flow_id: 'flow-1',
      })),
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    };
  }

  it('honors Retry-After on 429 and parks with a matching delay', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.failAppendWith = {
      status: 429,
      reason: 'rateLimitExceeded',
      retryAfterMs: 120_000,
    };
    const { db, data } = makeDb(
      quotaTables(
        [QR('q-1', 'sub-1', 'lead-1')],
        [SUBQ('sub-1', FSG, 'lead-1')],
        [CFGQ(FSG)]
      )
    );
    const before = Date.now();
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result).toMatchObject({ sent: 0, failed: 0, retrying: 1 });
    const row = data.meta_lead_sheets_queue[0];
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(String(row.last_error)).toContain('quota');
    // Retry-After (120s) wins over the jittered base (30–60s).
    const retryAt = Date.parse(row.next_retry_at as string);
    expect(retryAt).toBeGreaterThanOrEqual(before + 119_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 125_000);
  });

  it('treats 403 rateLimitExceeded as quota, never as reauth', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.failAppendWith = { status: 403, reason: 'rateLimitExceeded' };
    const { db, data } = makeDb(
      quotaTables(
        [QR('q-1', 'sub-1', 'lead-1')],
        [SUBQ('sub-1', FSG, 'lead-1')],
        [CFGQ(FSG)]
      )
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.needsReauth).toBe(0);
    expect(result).toMatchObject({ sent: 0, failed: 0, retrying: 1 });
    expect(data.meta_lead_sheets_queue[0].status).toBe('failed');
    expect(data.meta_lead_sheets_queue[0].attempts).toBe(1);
  });

  it('treats a throttled token refresh as quota without poisoning reauth', async () => {
    h.quotaRefreshFor.add('acct-1');
    const { db, data } = makeDb({
      ...quotaTables(
        [QR('q-1', 'sub-1', 'lead-1')],
        [SUBQ('sub-1', FSG, 'lead-1')],
        [CFGQ(FSG)]
      ),
      meta_lead_sheets_connections: [
        CONN({ token_expiry: new Date(0).toISOString(), last_error: null }),
      ],
    });
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.needsReauth).toBe(0);
    expect(result).toMatchObject({ sent: 0, failed: 0, retrying: 1 });
    // Parked untouched: no attempt burned, still queued, due later.
    const row = data.meta_lead_sheets_queue[0];
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(0);
    expect(Date.parse(row.next_retry_at as string)).toBeGreaterThan(Date.now());
    // The connection is not flagged for reconnect over a 429.
    expect(data.meta_lead_sheets_connections[0].last_error).toBeNull();
  });

  it('fails a permanent 400 terminally with a final error and long park', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.failAppendWith = { status: 400 };
    const { db, data } = makeDb(
      quotaTables(
        [QR('q-1', 'sub-1', 'lead-1')],
        [SUBQ('sub-1', FSG, 'lead-1')],
        [CFGQ(FSG)]
      )
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result).toMatchObject({ sent: 0, failed: 1, retrying: 0 });
    const row = data.meta_lead_sheets_queue[0];
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(row.max_attempts);
    expect(String(row.last_error)).toContain('retry limit reached');
    expect(Date.parse(row.next_retry_at as string)).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60_000
    );
  });

  it('batches new rows: one append + one re-scan per spreadsheet', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db, data } = makeDb(
      quotaTables(
        [
          QR('q-a', 'sub-a', 'lead-a'),
          QR('q-b', 'sub-b', 'lead-b'),
        ],
        [SUBQ('sub-a', FSG, 'lead-a'), SUBQ('sub-b', FSG, 'lead-b')],
        [CFGQ(FSG)]
      )
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result).toMatchObject({ sent: 2, failed: 0, retrying: 0 });
    // One batched append carrying both rows (was: one per row).
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows).toHaveLength(2);
    expect(h.appended[0].rows.map((r) => r[0]).sort()).toEqual([
      'lead-a',
      'lead-b',
    ]);
    // One group ID scan + one re-scan (was: two scans + two re-scans).
    expect(h.findCalls).toHaveLength(2);
    expect(h.findCalls[0].leadIds.sort()).toEqual(['lead-a', 'lead-b']);
    expect(h.findCalls[1].leadIds.sort()).toEqual(['lead-a', 'lead-b']);
    // One tab check + one header ensure per spreadsheet (was: per row).
    expect(h.tabsChecked).toEqual([{ spreadsheetId: 'sheet-1', tab: 'Meta Leads' }]);
    for (const row of data.meta_lead_sheets_queue as Row[]) {
      expect(row.status).toBe('sent');
    }
  });

  it('handles mixed update + create rows in one group without duplicating', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.columnValues.set('sheet-1::Meta Leads', ['lead-a']);
    const { db, data } = makeDb(
      quotaTables(
        [
          QR('q-a', 'sub-a', 'lead-a'),
          QR('q-b', 'sub-b', 'lead-b'),
        ],
        [SUBQ('sub-a', FSG, 'lead-a'), SUBQ('sub-b', FSG, 'lead-b')],
        [CFGQ(FSG)]
      )
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result).toMatchObject({ sent: 2, failed: 0 });
    // Existing row updated in place; only the new lead appended.
    expect(h.updated).toHaveLength(1);
    expect(h.updated[0]).toMatchObject({ row: 2 });
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows).toHaveLength(1);
    expect(h.appended[0].rows[0][0]).toBe('lead-b');
    const byId = Object.fromEntries(
      (data.meta_lead_sheets_queue as Row[]).map((r) => [r.id, r])
    );
    expect(byId['q-a'].sheet_row_number).toBe(2);
    expect(byId['q-b'].sheet_row_number).toBe(3);
  });

  it('quota trip parks later groups without burning attempts (cross-worker backoff)', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.failAppendWith = { status: 429, reason: 'rateLimitExceeded' };
    const { db, data } = makeDb(
      quotaTables(
        [
          QR('q-a', 'sub-a', 'lead-a'),
          { ...QR('q-b', 'sub-b', 'lead-b'), form_id: undefined },
        ],
        [SUBQ('sub-a', FSG, 'lead-a'), SUBQ('sub-b', FOTHER, 'lead-b')],
        [CFGQ(FSG, 'sheet-1', 'Meta Leads'), CFGQ(FOTHER, 'sheet-2', 'Tab B')]
      )
    );
    // form_id on the queue row is informational only; routing uses
    // the submission. Point the second row's submission at form-other.
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.attempted).toBe(2);
    expect(result).toMatchObject({ sent: 0, failed: 0, retrying: 2 });
    const byId = Object.fromEntries(
      (data.meta_lead_sheets_queue as Row[]).map((r) => [r.id, r])
    );
    // First group burned one attempt on the 429 and backs off.
    expect(byId['q-a'].status).toBe('failed');
    expect(byId['q-a'].attempts).toBe(1);
    // Second spreadsheet never touched: no attempt burned, claim restored.
    expect(byId['q-b'].status).toBe('queued');
    expect(byId['q-b'].attempts).toBe(0);
    expect(Date.parse(byId['q-b'].next_retry_at as string)).toBeGreaterThan(
      Date.now()
    );
    expect(h.tabsChecked).toEqual([
      { spreadsheetId: 'sheet-1', tab: 'Meta Leads' },
    ]);

    // A concurrent worker's drain immediately after picks up nothing:
    // every row's next_retry_at is in the future (shared DB backoff).
    h.failAppendWith = null;
    const second = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(second.attempted).toBe(0);
    expect(second.sent).toBe(0);
  });

  it('skips exhausted rows without touching them or the API', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    const { db, data } = makeDb(
      quotaTables(
        [
          QR('q-dead', 'sub-1', 'lead-1', {
            status: 'failed',
            attempts: 8,
            max_attempts: 8,
          }),
        ],
        [SUBQ('sub-1', FSG, 'lead-1')],
        [CFGQ(FSG)]
      )
    );
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.attempted).toBe(0);
    expect(result).toMatchObject({ sent: 0, failed: 0, retrying: 0 });
    expect(h.tabsChecked).toEqual([]);
    expect(h.appended).toHaveLength(0);
    // Untouched: the row waits for manual revive, not another loop.
    expect(data.meta_lead_sheets_queue[0].status).toBe('failed');
    expect(data.meta_lead_sheets_queue[0].attempts).toBe(8);
  });

  it('recovers a throttled re-scan by updating instead of re-appending', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    // Fail only the second ID-column read (the post-append re-scan).
    h.failFindWith = { status: 429, reason: 'rateLimitExceeded' };
    h.failFindOnCall = 1;
    const { db, data } = makeDb(
      quotaTables(
        [QR('q-1', 'sub-1', 'lead-1')],
        [SUBQ('sub-1', FSG, 'lead-1')],
        [CFGQ(FSG)]
      )
    );
    const first = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(first).toMatchObject({ sent: 0, failed: 0, retrying: 1 });
    expect(h.appended).toHaveLength(1);
    expect(data.meta_lead_sheets_queue[0].status).toBe('failed');

    // The append already landed; the retry matches by lead ID and
    // updates in place — never a second row.
    h.failFindWith = null;
    h.failFindOnCall = null;
    data.meta_lead_sheets_queue[0].next_retry_at = new Date(0).toISOString();
    const second = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(second.sent).toBe(1);
    expect(h.appended).toHaveLength(1);
    expect(h.updated).toHaveLength(1);
    expect(h.columnValues.get('sheet-1::Meta Leads')).toEqual(['lead-1']);
    expect(data.meta_lead_sheets_queue[0].status).toBe('sent');
  });

  it('exhausted rows stay queued-excluded until revived, then deliver', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.columnValues.set('sheet-1::Meta Leads', []);
    const { db, data } = makeDb(
      quotaTables(
        [
          QR('q-exhausted', 'sub-a', 'lead-a', {
            status: 'failed',
            attempts: 8,
          }),
        ],
        [SUBQ('sub-a', FSG, 'lead-a')],
        [CFGQ(FSG)]
      )
    );
    // Terminal rows never auto-retry and never stall the drain.
    const parked = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(parked).toMatchObject({ attempted: 0, sent: 0, failed: 0 });
    // Revival resets the FULL retry state (attempts, error, due-now).
    const { revived } = await reviveTableFailedRows(db, 'acct-1', FSG);
    expect(revived).toBe(1);
    const row = data.meta_lead_sheets_queue.find((r) => r.id === 'q-exhausted')!;
    expect(row).toMatchObject({ status: 'queued', attempts: 0, last_error: null });
    // And the revived row delivers on the next drain (no duplicate:
    // the scan finds nothing, one append carries the lead ID).
    const delivered = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(delivered.sent).toBe(1);
    expect(h.appended).toHaveLength(1);
  });

  it('reviveTableFailedRows revives one table only and never sent rows', async () => {
    const { db, data } = makeDb(
      quotaTables(
        [
          QR('q-exhausted', 'sub-a', 'lead-a', {
            status: 'failed',
            attempts: 8,
          }),
          QR('q-retry', 'sub-a', 'lead-a', {
            id: 'q-retry',
            status: 'failed',
            attempts: 3,
          }),
          QR('q-sent', 'sub-a', 'lead-a', {
            id: 'q-sent',
            status: 'sent',
            attempts: 1,
          }),
          QR('q-other', 'sub-b', 'lead-b', { id: 'q-other', status: 'failed' }),
        ],
        [SUBQ('sub-a', FSG, 'lead-a'), SUBQ('sub-b', FOTHER, 'lead-b')],
        [CFGQ(FSG), CFGQ(FOTHER)]
      )
    );
    const { revived } = await reviveTableFailedRows(db, 'acct-1', FSG);
    expect(revived).toBe(2);
    const byId = Object.fromEntries(
      (data.meta_lead_sheets_queue as Row[]).map((r) => [r.id, r])
    );
    for (const id of ['q-exhausted', 'q-retry']) {
      expect(byId[id].status).toBe('queued');
      expect(byId[id].attempts).toBe(0);
      expect(byId[id].last_error).toBeNull();
      expect(Date.parse(byId[id].next_retry_at as string)).toBeLessThanOrEqual(
        Date.now() + 5_000
      );
    }
    // Untouched: synced rows, other tables' rows.
    expect(byId['q-sent'].status).toBe('sent');
    expect(byId['q-other'].status).toBe('failed');
    expect(byId['q-other'].attempts).toBe(0);
  });
});

describe('audit remediation — data integrity, imports, cleanup, status', () => {
  const FSG = 'form-sg';
  const FOTHER = 'form-other';
  const sub = (id: string, form: string, day: string, lead?: string) => ({
    id,
    account_id: 'acct-1',
    meta_lead_id: lead ?? `lead-${id}`,
    flow_run_id: `run-${id}`,
    form_id: form,
    form_name: 'Form',
    campaign_name: 'Camp',
    ad_name: 'Ad',
    source: 'facebook',
    answers: { full_name: 'Asha' },
    meta_created_time: `${day}T10:00:00.000Z`,
    created_at: `${day}T10:00:00.000Z`,
    status: 'processed',
  });
  const cfg = (formId: string, over: Row = {}) => ({
    ...CONFIG,
    form_id: formId,
    ...over,
  });

  it('backfill pages the full history and scopes the config update to its form', async () => {
    const subs = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
      sub(`s-${id}`, FSG, `2026-03-0${i + 1}`),
    );
    subs.push(sub('s-x', FOTHER, '2026-03-01'));
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [
        cfg(FSG, { historical_import_status: 'idle', historical_imported_count: 0 }),
        cfg(FOTHER, {
          historical_import_status: 'done',
          historical_imported_count: 99,
        }),
      ],
      meta_lead_submissions: subs,
      meta_lead_sheets_queue: [],
    });
    // Page size 2 forces three pages for the five rows.
    const result = await backfillFormSheets(db, 'acct-1', FSG, 2);
    expect(result).toMatchObject({ enqueued: 5, alreadyQueued: 0, total: 5 });
    expect(data.meta_lead_sheets_queue).toHaveLength(5);
    const mine = data.meta_lead_sheets_configs.find((c) => c.form_id === FSG)!;
    expect(mine.historical_import_status).toBe('done');
    expect(mine.historical_imported_count).toBe(5);
    // The sibling table's import status and counts are untouched.
    const sibling = data.meta_lead_sheets_configs.find(
      (c) => c.form_id === FOTHER
    )!;
    expect(sibling.historical_import_status).toBe('done');
    expect(sibling.historical_imported_count).toBe(99);
  });

  it('backfill is resumable: a second run only counts alreadyQueued', async () => {
    const { db } = makeDb({
      meta_lead_sheets_configs: [cfg(FSG)],
      meta_lead_submissions: [sub('s-a', FSG, '2026-03-01'), sub('s-b', FSG, '2026-03-02')],
      meta_lead_sheets_queue: [],
    });
    const first = await backfillFormSheets(db, 'acct-1', FSG, 2);
    expect(first).toMatchObject({ enqueued: 2, total: 2 });
    const second = await backfillFormSheets(db, 'acct-1', FSG, 2);
    expect(second).toMatchObject({ enqueued: 0, alreadyQueued: 2, total: 2 });
  });

  it('enqueueFormsDelta pages the full history without duplicates', async () => {
    const { db, data } = makeDb({
      meta_lead_submissions: ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
        sub(`s-${id}`, FSG, `2026-03-0${i + 1}`),
      ),
      meta_lead_sheets_queue: [],
    });
    const result = await enqueueFormsDelta(db, 'acct-1', [FSG], 2);
    expect(result).toMatchObject({ enqueued: 5, total: 5 });
    expect(data.meta_lead_sheets_queue).toHaveLength(5);
    const again = await enqueueFormsDelta(db, 'acct-1', [FSG], 2);
    expect(again).toMatchObject({ enqueued: 0, alreadyQueued: 5, total: 5 });
  });

  it('invalidateTableRowMappings clears only this table’s stale numbers', async () => {
    const { db, data } = makeDb({
      meta_lead_submissions: [sub('s-a', FSG, '2026-03-01'), sub('s-b', FOTHER, '2026-03-01')],
      meta_lead_sheets_queue: [
        {
          id: 'q-a',
          account_id: 'acct-1',
          submission_id: 's-a',
          flow_run_id: 'run-s-a',
          meta_lead_id: 'lead-s-a',
          status: 'sent',
          attempts: 1,
          max_attempts: 8,
          sheet_row_number: 7,
          next_retry_at: new Date(0).toISOString(),
        },
        {
          id: 'q-b',
          account_id: 'acct-1',
          submission_id: 's-b',
          flow_run_id: 'run-s-b',
          meta_lead_id: 'lead-s-b',
          status: 'sent',
          attempts: 1,
          max_attempts: 8,
          sheet_row_number: 9,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
    });
    const { invalidated } = await invalidateTableRowMappings(db, 'acct-1', FSG);
    expect(invalidated).toBe(1);
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-a')?.sheet_row_number,
    ).toBeNull();
    // History preserved (row kept, sent status kept), sibling untouched.
    expect(data.meta_lead_sheets_queue.find((r) => r.id === 'q-a')?.status).toBe('sent');
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-b')?.sheet_row_number,
    ).toBe(9);
  });

  it('planImportScope covers 5,000+ scale tables without truncation', async () => {
    const subs = Array.from({ length: 12 }, (_, i) =>
      sub(`big-${i}`, FSG, '2026-03-01', `lead-big-${i}`),
    );
    const { db } = makeDb({
      meta_lead_submissions: subs,
      flow_runs: subs.map((s) => ({
        id: s.flow_run_id,
        account_id: 'acct-1',
        flow_id: 'flow-1',
        started_at: '2026-03-01T12:00:00.000Z',
      })),
      meta_lead_sheets_queue: [],
    });
    const scope = await planImportScope(db, 'acct-1', FSG, null, 5);
    expect(scope.total).toBe(12);
    expect(scope.candidates).toHaveLength(12);
    expect(scope.truncated).toBe(false);
  });

  it('cleanup verifies live identity: shifted rows are skipped, never deleted', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    // The sheet shifted: row 2 now holds lead-b, not lead-a.
    h.columnValues.set('sheet-1::Meta Leads', ['lead-b', 'lead-c']);
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [cfg(FSG)],
      meta_lead_submissions: [sub('s-a', FSG, '2026-03-01', 'lead-a')],
      meta_lead_sheets_queue: [
        {
          id: 'q-a',
          account_id: 'acct-1',
          submission_id: 's-a',
          flow_run_id: 'run-s-a',
          meta_lead_id: 'lead-a',
          status: 'sent',
          attempts: 1,
          max_attempts: 8,
          sheet_row_number: 2,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const pure = verifyCleanupBatch(
      [{ queueId: 'q-a', rowNumber: 2, metaLeadId: 'lead-a' }],
      new Map([['lead-a', 5]])
    );
    expect(pure).toEqual({ verified: [], skippedStale: 1 });
    // End-to-end: nothing is deleted on a guess, the stale mapping
    // is unmapped (sent history preserved), and a retry stays safe.
    const result = await cleanupTableRows(db, 'token-1', 'acct-1', FSG);
    expect(result).toMatchObject({ removed: 0 });
    expect(h.deleted).toHaveLength(0);
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-a')?.sheet_row_number,
    ).toBeNull();
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-a')?.status,
    ).toBe('sent');
  });

  it('cleanup retries after a partial sheet delete stay safe (no double delete)', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    h.columnValues.set('sheet-1::Meta Leads', ['lead-a']);
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [cfg(FSG)],
      meta_lead_submissions: [sub('s-a', FSG, '2026-03-01', 'lead-a')],
      meta_lead_sheets_queue: [
        {
          id: 'q-a',
          account_id: 'acct-1',
          submission_id: 's-a',
          flow_run_id: 'run-s-a',
          meta_lead_id: 'lead-a',
          status: 'sent',
          attempts: 1,
          max_attempts: 8,
          sheet_row_number: 2,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const result = await cleanupTableRows(db, 'token-1', 'acct-1', FSG);
    expect(result.removed).toBe(1);
    expect(h.deleted).toHaveLength(1);
    expect(h.deleted[0]).toMatchObject({ rows: [2] });
    // Re-running after the delete finds nothing live: no second
    // delete of a shifted position, no duplicate removal.
    const again = await cleanupTableRows(db, 'token-1', 'acct-1', FSG);
    expect(again.removed).toBe(0);
    expect(h.deleted).toHaveLength(1);
    expect(data.meta_lead_sheets_queue).toHaveLength(0);
  });

  it('status badge: sharing/quota errors never raise reconnect, auth errors do', async () => {
    const base = {
      meta_lead_submissions: [sub('s-a', FSG, '2026-03-01')],
      meta_lead_sheets_queue: [],
    };
    for (const [error, expected] of [
      ['Google Sheets API quota exceeded — backing off', false],
      [
        'The connected Google account cannot access that spreadsheet (sharing required)',
        false,
      ],
      ['Worksheet "Old" was not found. Select a replacement tab', false],
      [null, false],
      ['Google authorization expired or was revoked. Reconnect Google Sheets.', true],
      ['The stored Google credentials are corrupt or unreadable. Reconnect Google Sheets.', true],
      ['revoked', true],
    ] as Array<[string | null, boolean]>) {
      const { db } = makeDb({
        ...base,
        meta_lead_submissions: [sub('s-a', FSG, '2026-03-01')],
        meta_lead_sheets_connections: [
          { account_id: 'acct-1', google_email: 'g@x.com', last_error: error },
        ],
        meta_lead_sheets_configs: [cfg(FSG, { last_error: null })],
      });
      const status = await getTableSheetsStatus(db, 'acct-1', FSG);
      expect(status.needsReauth).toBe(expected);
    }
  });

  it('drain prefers the live scan over a stale stored row number', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    // Sheet shifted: lead-a actually lives at row 4 now.
    h.columnValues.set('sheet-1::Meta Leads', ['x', 'y', 'lead-a']);
    const { db } = makeDb({
      meta_lead_sheets_configs: [cfg(FSG)],
      meta_lead_submissions: [sub('s-a', FSG, '2026-03-01', 'lead-a')],
      meta_lead_sheets_queue: [
        {
          id: 'q-a',
          account_id: 'acct-1',
          submission_id: 's-a',
          flow_run_id: 'run-s-a',
          meta_lead_id: 'lead-a',
          status: 'queued',
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: 2,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [
        { id: 'run-s-a', account_id: 'acct-1', flow_id: 'flow-1' },
      ],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    // Updated at the TRUE row (4), not the stale stored row (2).
    expect(h.updated).toHaveLength(1);
    expect(h.updated[0].row).toBe(4);
    expect(h.appended).toHaveLength(0);
  });

  it('a worker crash after a Google write resumes without duplicating', async () => {
    h.accessTokenFor.set('acct-1', 'token-1');
    // The append already landed (visible in the ID scan) but the
    // worker crashed before recording the mapping: stale `sending`
    // claim, no stored row number.
    h.columnValues.set('sheet-1::Meta Leads', ['lead-a']);
    const { db, data } = makeDb({
      meta_lead_sheets_configs: [cfg(FSG)],
      meta_lead_submissions: [sub('s-a', FSG, '2026-03-01', 'lead-a')],
      meta_lead_sheets_queue: [
        {
          id: 'q-a',
          account_id: 'acct-1',
          submission_id: 's-a',
          flow_run_id: 'run-s-a',
          meta_lead_id: 'lead-a',
          status: 'sending',
          claimed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          attempts: 0,
          max_attempts: 8,
          sheet_row_number: null,
          next_retry_at: new Date(0).toISOString(),
        },
      ],
      flow_runs: [
        { id: 'run-s-a', account_id: 'acct-1', flow_id: 'flow-1' },
      ],
      workspace_fields: [],
      workspace_values: [],
      profiles: [],
    });
    const result = await drainSheetsQueue(db, {
      onlyAccountId: 'acct-1',
      force: true,
    });
    expect(result.sent).toBe(1);
    // No duplicate append: the scan found the crashed write and the
    // drain updated it in place.
    expect(h.appended).toHaveLength(0);
    expect(h.updated).toHaveLength(1);
    expect(
      data.meta_lead_sheets_queue.find((r) => r.id === 'q-a')?.status,
    ).toBe('sent');
  });
});
