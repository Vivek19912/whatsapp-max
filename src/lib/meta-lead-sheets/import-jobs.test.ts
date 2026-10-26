// Meta Sheets import jobs — durable manual imports: partial
// completion, timeout recovery, duplicate prevention, restarts,
// concurrent jobs, date ranges, quota backoff. Google API calls
// are mocked with an in-memory sheet; no production spreadsheets
// are touched.

import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  return {
    accessTokenFor: new Map<string, string>(),
    failAppendWith: null as {
      status: number;
      reason?: string;
      retryAfterMs?: number | null;
    } | null,
    columnValues: new Map<string, string[]>(),
    appended: [] as Array<{ spreadsheetId: string; tab: string; rows: string[][] }>,
    updated: [] as Array<{ spreadsheetId: string; tab: string; row: number }>,
    headersEnsured: [] as Array<{ spreadsheetId: string; tab: string }>,
  };
});

vi.mock('./oauth', () => ({
  SheetsAuthError: class SheetsAuthError extends Error {
    readonly code = 'needs_reauth' as const;
  },
  getSheetsAccessToken: async (_db: unknown, accountId: string) => {
    if (!h.accessTokenFor.has(accountId)) {
      const err = new Error('No Google account is connected.') as Error & {
        code: string;
      };
      err.code = 'needs_reauth';
      throw err;
    }
    return h.accessTokenFor.get(accountId)!;
  },
}));

vi.mock('./sheets-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sheets-client')>();
  return {
    ...actual,
    assertWorksheetTabExists: async () => undefined,
    ensureSheetsHeader: async (
      _t: string,
      spreadsheetId: string,
      tab: string
    ) => {
      h.headersEnsured.push({ spreadsheetId, tab });
      return { updated: false };
    },
    appendSheetsRows: async (
      _t: string,
      spreadsheetId: string,
      tab: string,
      rows: string[][],
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
      const key = `${spreadsheetId}::${tab}`;
      const existing = h.columnValues.get(key) ?? [];
      for (const r of rows) existing.push(String(r[0]));
      h.columnValues.set(key, existing);
    },
    updateSheetsRow: async (
      _t: string,
      spreadsheetId: string,
      tab: string,
      rowNumber: number
    ) => {
      h.updated.push({ spreadsheetId, tab, row: rowNumber });
    },
    findSheetsRowsByLeadId: async (
      _t: string,
      spreadsheetId: string,
      _tab: string,
      leadIds: string[]
    ) => {
      const key = `${spreadsheetId}::${_tab}`;
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
  ActiveImportJobError,
  cancelImportJob,
  createImportJob,
  getImportJobProgress,
  pumpActiveImportJobs,
  pumpImportJob,
  reviveImportJobFailures,
  type ImportJobRow,
} from './import-jobs';

type Row = Record<string, unknown>;

function makeDb(initial: Record<string, Row[]>) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }
  let idCounter = 1000;

  function matches(
    row: Row,
    filters: Array<{ op: string; col: string; val: unknown }>
  ): boolean {
    for (const f of filters) {
      // Missing keys read as null (real rows always carry null).
      if (f.op === 'eq' && (row[f.col] ?? null) !== (f.val ?? null))
        return false;
      if (f.op === 'in' && !(f.val as unknown[]).includes(row[f.col] ?? null))
        return false;
      if (f.op === 'lte' && String(row[f.col] ?? '') > String(f.val))
        return false;
      if (f.op === 'neq' && row[f.col] === f.val) return false;
    }
    return true;
  }

  function builder(table: string) {
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let patch: Row = {};
    let insertRows: Row[] = [];
    const filters: Array<{ op: string; col: string; val: unknown }> = [];
    let limitN: number | null = null;
    const orders: string[] = [];

    const matched = () =>
      (data[table] ?? []).filter((r) => matches(r, filters));

    function applyInsert(): { rows: Row[]; error: { code: string; message: string } | null } {
      const inserted: Row[] = [];
      for (const r of insertRows) {
        if (table === 'meta_lead_sheets_queue') {
          const dup = (data[table] ?? []).some(
            (existing) =>
              existing.account_id === r.account_id &&
              existing.submission_id === r.submission_id
          );
          if (dup) return { rows: [], error: { code: '23505', message: 'duplicate' } };
        }
        if (table === 'meta_lead_sheets_import_jobs') {
          const dup = (data[table] ?? []).some(
            (existing) =>
              existing.account_id === r.account_id &&
              existing.form_id === r.form_id &&
              (existing.status === 'queued' || existing.status === 'running')
          );
          if (dup) return { rows: [], error: { code: '23505', message: 'one active job' } };
        }
        const row: Row = {
          id: (r as Row).id ?? `gen-${idCounter++}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          // Mirror the DB defaults for queue rows so drains and
          // progress accounting behave like production.
          ...(table === 'meta_lead_sheets_queue'
            ? {
                status: 'queued',
                attempts: 0,
                max_attempts: 8,
                next_retry_at: new Date(0).toISOString(),
                claimed_at: null,
                sheet_row_number: null,
              }
            : {}),
          ...r,
        };
        (data[table] ??= []).push(row);
        inserted.push(row);
      }
      return { rows: inserted, error: null };
    }

    const b: Record<string, (...args: never[]) => unknown> = {
      select: (() => b) as never,
      insert: ((rows: Row | Row[]) => {
        op = 'insert';
        insertRows = Array.isArray(rows) ? rows : [rows];
        return b;
      }) as never,
      update: ((p: Row) => {
        op = 'update';
        patch = p;
        return b;
      }) as never,
      delete: (() => {
        op = 'delete';
        data[table] = (data[table] ?? []).filter((r) => !matches(r, filters));
        return Promise.resolve({ data: null, error: null });
      }) as never,
      eq: ((col: string, val: unknown) => {
        filters.push({ op: 'eq', col, val });
        return b;
      }) as never,
      neq: ((col: string, val: unknown) => {
        filters.push({ op: 'neq', col, val });
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
      order: ((col: string) => {
        orders.push(col);
        return b;
      }) as never,
      limit: ((n: number) => {
        limitN = n;
        return b;
      }) as never,
      single: (async () => {
        if (op === 'update') {
          const targets = matched();
          for (const row of targets) Object.assign(row, patch);
          return { data: targets[0] ?? null, error: null };
        }
        if (op === 'insert') {
          const { rows, error } = applyInsert();
          return { data: rows[0] ?? null, error };
        }
        const rows = matched();
        return { data: rows[0] ?? null, error: null };
      }) as never,
      maybeSingle: (async () => {
        if (op === 'update') {
          const targets = matched();
          for (const row of targets) Object.assign(row, patch);
          return { data: targets[0] ?? null, error: null };
        }
        if (op === 'insert') {
          const { rows, error } = applyInsert();
          return { data: rows[0] ?? null, error };
        }
        let rows = matched();
        if (limitN !== null) rows = rows.slice(0, limitN);
        return { data: rows[0] ?? null, error: null };
      }) as never,
      then: ((res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === 'update') {
          const targets = matched();
          for (const row of targets) Object.assign(row, patch);
          return Promise.resolve({ data: targets, error: null }).then(res, rej);
        }
        if (op === 'insert') {
          const { rows, error } = applyInsert();
          return Promise.resolve({ data: rows, error }).then(res, rej);
        }
        let rows = matched();
        if (limitN !== null) rows = rows.slice(0, limitN);
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

function sub(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    account_id: 'acct-1',
    meta_lead_id: `lead-${id}`,
    flow_run_id: `run-${id}`,
    form_id: 'form-1',
    status: 'processed',
    created_at: '2026-03-10T12:00:00.000Z',
    ...over,
  };
}

function baseFixture(submissions: Row[], queueRows: Row[] = []) {
  return {
    meta_lead_sheets_configs: [
      {
        account_id: 'acct-1',
        form_id: 'form-1',
        spreadsheet_id: 'sheet-1',
        sheet_tab: 'Meta Leads',
        auto_sync: true,
      },
    ],
    meta_lead_sheets_import_jobs: [] as Row[],
    meta_lead_submissions: submissions,
    flow_runs: submissions
      .filter((s) => s.flow_run_id)
      .map((s) => ({
        id: s.flow_run_id,
        account_id: 'acct-1',
        flow_id: 'flow-1',
        started_at:
          typeof s.runStartedAt === 'string'
            ? s.runStartedAt
            : '2026-03-10T12:00:00.000Z',
      })),
    meta_lead_sheets_queue: queueRows,
  };
}

beforeEach(() => {
  h.accessTokenFor = new Map([['acct-1', 'tok']]);
  h.failAppendWith = null;
  h.columnValues = new Map();
  h.appended = [];
  h.updated = [];
  h.headersEnsured = [];
});

const ARGS = {
  accountId: 'acct-1',
  formId: 'form-1',
  flowId: 'flow-1',
  createdBy: 'user-1',
} as const;

describe('import jobs — 81-lead partial import, recovery, no duplicates', () => {
  it('completes 81 leads across bounded pumps with a quota failure mid-way', async () => {
    const submissions = Array.from({ length: 81 }, (_, i) =>
      sub(`sub-${i}`, { created_at: `2026-03-10T12:${String(i % 60).padStart(2, '0')}:00.000Z` })
    );
    const { db, data } = makeDb(baseFixture(submissions));

    const job = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    expect(job.total).toBe(81);
    expect(job.status).toBe('queued');
    // All 81 enqueued in one bulk pass (idempotent by unique key).
    expect(
      (data.meta_lead_sheets_queue as Row[]).filter((r) => r.status === 'queued')
    ).toHaveLength(81);

    // Pump 1: first 32 land, then the pump budget ends the pass.
    const first = await pumpImportJob(db, job.id, { rowBudget: 32 });
    expect(first.claimed).toBe(true);
    expect(first.progress!.done).toBe(false);
    expect(first.progress!.sent).toBe(32);
    expect(h.columnValues.get('sheet-1::Meta Leads')).toHaveLength(32);

    // Quota storm hits mid-import: the rest park/fail-retryable, nothing appends twice.
    h.failAppendWith = { status: 429 };
    const second = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(second.claimed).toBe(true);
    expect(second.progress!.done).toBe(false);
    expect(second.progress!.sent).toBe(32);
    expect(second.progress!.retrying).toBeGreaterThan(0);
    expect(h.columnValues.get('sheet-1::Meta Leads')).toHaveLength(32);

    // Recovery: quota clears, the next pump finishes all 81 exactly once.
    h.failAppendWith = null;
    for (const row of data.meta_lead_sheets_queue as Row[]) {
      if (row.status === 'failed' || row.status === 'queued') {
        row.next_retry_at = new Date(0).toISOString();
      }
    }
    const third = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(third.progress!.done).toBe(true);
    expect(third.progress!.sent).toBe(81);
    expect(third.progress!.failed).toBe(0);
    const cells = h.columnValues.get('sheet-1::Meta Leads') ?? [];
    expect(cells).toHaveLength(81);
    expect(new Set(cells).size).toBe(81);

    const finalJob = (
      data.meta_lead_sheets_import_jobs as Row[]
    ).find((r) => r.id === job.id)!;
    expect(finalJob.status).toBe('completed');
  });

  it('refreshes already-imported rows in place instead of duplicating', async () => {
    const submissions = Array.from({ length: 10 }, (_, i) => sub(`sub-${i}`));
    // 4 leads already synced (mapped rows with sheet numbers + sheet content).
    h.columnValues.set(
      'sheet-1::Meta Leads',
      ['lead-sub-0', 'lead-sub-1', 'lead-sub-2', 'lead-sub-3']
    );
    const queueRows = ['sub-0', 'sub-1', 'sub-2', 'sub-3'].map((id, i) => ({
      id: `q-${id}`,
      account_id: 'acct-1',
      submission_id: id,
      flow_run_id: `run-${id}`,
      meta_lead_id: `lead-${id}`,
      status: 'sent',
      attempts: 1,
      max_attempts: 8,
      sheet_row_number: i + 2,
      next_retry_at: new Date(0).toISOString(),
    }));
    const { db } = makeDb(baseFixture(submissions, queueRows));

    const job = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    expect(job.updated_total).toBe(4);
    expect(job.inserted_total).toBe(6);

    const pump = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(pump.progress!.done).toBe(true);
    expect(pump.progress!.sent).toBe(10);
    // 4 updates in place, 6 appends — no duplicate rows.
    expect(h.updated).toHaveLength(4);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].rows).toHaveLength(6);
    expect(h.columnValues.get('sheet-1::Meta Leads')).toHaveLength(10);
  });
});

describe('import jobs — concurrency and lifecycle', () => {
  it('rejects a second active job for the same table (409 path)', async () => {
    const { db } = makeDb(baseFixture([sub('sub-1')]));
    const first = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    expect(first.status).toBe('queued');
    const err = await createImportJob(db, {
      ...ARGS,
      mode: 'all',
      range: null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActiveImportJobError);
    expect((err as ActiveImportJobError).jobId).toBe(first.id);
  });

  it('allows a new import after the previous one completes or is cancelled', async () => {
    const { db } = makeDb(baseFixture([sub('sub-1')]));
    const first = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    await pumpImportJob(db, first.id, { rowBudget: 100 });
    const second = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    expect(second.id).not.toBe(first.id);

    await cancelImportJob(db, second);
    const third = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    expect(third.id).not.toBe(second.id);
  });

  it('only the claim holder pumps; a stale claim is reclaimable', async () => {
    const { db, data } = makeDb(baseFixture([sub('sub-1')]));
    const job = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    // Simulate a worker holding the claim right now.
    const stored = (data.meta_lead_sheets_import_jobs as Row[]).find(
      (r) => r.id === job.id
    )!;
    stored.claimed_at = new Date().toISOString();
    stored.status = 'running';
    const blocked = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(blocked.claimed).toBe(false);
    expect(blocked.progress!.sent).toBe(0);

    // After 5 minutes the claim is stale and another worker resumes.
    stored.claimed_at = new Date(Date.now() - 6 * 60_000).toISOString();
    const resumed = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(resumed.claimed).toBe(true);
    expect(resumed.progress!.done).toBe(true);
    expect(resumed.progress!.sent).toBe(1);
  });

  it('cancel stops pumping; terminal jobs are untouched', async () => {
    const { db } = makeDb(baseFixture([sub('sub-1')]));
    const job = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    const cancelled = await cancelImportJob(db, job);
    expect(cancelled!.status).toBe('cancelled');
    const pump = await pumpImportJob(db, job.id);
    expect(pump.claimed).toBe(false);
    // Cancelling twice is a no-op returning the stored row.
    const again = await cancelImportJob(db, { ...job, status: 'completed' });
    expect(again!.status).toBe('completed');
  });
});

describe('import jobs — scope, ranges, and failures', () => {
  it('imports only the inclusive date range', async () => {
    const subs = [
      sub('in-1', { runStartedAt: '2026-03-01T00:00:00.000Z' }),
      sub('in-2', { runStartedAt: '2026-03-31T23:59:59.999Z' }),
      sub('out-before', { runStartedAt: '2026-02-28T23:59:59.999Z' }),
      sub('out-after', { runStartedAt: '2026-04-01T00:00:00.000Z' }),
    ];
    const { db } = makeDb(baseFixture(subs));
    const job = await createImportJob(db, {
      ...ARGS,
      mode: 'range',
      range: { from: '2026-03-01', to: '2026-03-31' },
    });
    expect(job.total).toBe(2);
    expect(job.submission_ids.sort()).toEqual(['in-1', 'in-2']);
    const pump = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(pump.progress!.done).toBe(true);
    expect(pump.progress!.sent).toBe(2);
    expect(h.columnValues.get('sheet-1::Meta Leads')!.sort()).toEqual([
      'lead-in-1',
      'lead-in-2',
    ]);
  });

  it('completes immediately when nothing is in scope', async () => {
    const { db } = makeDb(baseFixture([sub('sub-1')]));
    const job = await createImportJob(db, {
      ...ARGS,
      mode: 'range',
      range: { from: '2026-04-01', to: '2026-04-30' },
    });
    expect(job.total).toBe(0);
    const pump = await pumpImportJob(db, job.id);
    expect(pump.claimed).toBe(true);
    expect(pump.progress!.done).toBe(true);
    expect(pump.progress!.sent).toBe(0);
  });

  it('marks terminal failures with a final error and revives them on resume', async () => {
    const { db, data } = makeDb(baseFixture([sub('sub-1'), sub('sub-2')]));
    const job = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    h.failAppendWith = { status: 400 };
    const first = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(first.progress!.done).toBe(true);
    expect(first.progress!.failed).toBe(2);
    expect(first.progress!.sent).toBe(0);
    for (const row of data.meta_lead_sheets_queue as Row[]) {
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(row.max_attempts);
    }

    // Resume without revive: terminal rows stay parked.
    h.failAppendWith = null;
    const resume = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(resume.claimed).toBe(false);

    // Resume with revive: fresh budget, all 2 sync exactly once.
    const stored = (
      data.meta_lead_sheets_import_jobs as unknown as ImportJobRow[]
    ).find((r) => r.id === job.id)!;
    const rev = await reviveImportJobFailures(db, stored);
    expect(rev.revived).toBe(2);
    const retry = await pumpImportJob(db, job.id, { rowBudget: 100 });
    expect(retry.progress!.done).toBe(true);
    expect(retry.progress!.sent).toBe(2);
    expect(h.columnValues.get('sheet-1::Meta Leads')).toHaveLength(2);
  });

  it('pumpActiveImportJobs pumps each active job once, bounded', async () => {
    const subs = [sub('sub-1'), sub('sub-2')];
    const { db, data } = makeDb(baseFixture(subs));
    const a = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    // A second table's job pumps independently.
    const otherSubs = [sub('sub-x', { form_id: 'form-2' })];
    for (const s of otherSubs) {
      (data.meta_lead_submissions as Row[]).push(s);
      (data.flow_runs as Row[]).push({
        id: s.flow_run_id,
        account_id: 'acct-1',
        flow_id: 'flow-1',
        started_at: '2026-03-10T12:00:00.000Z',
      });
    }
    (data.meta_lead_sheets_configs as Row[]).push({
      account_id: 'acct-1',
      form_id: 'form-2',
      spreadsheet_id: 'sheet-2',
      sheet_tab: 'Tab B',
      auto_sync: true,
    });
    const b = await createImportJob(db, {
      ...ARGS,
      formId: 'form-2',
      flowId: 'flow-2',
      mode: 'all',
      range: null,
    });
    const sweep = await pumpActiveImportJobs(db, { maxJobs: 2, rowBudget: 100 });
    expect(sweep).toEqual({ jobs: 2, pumped: 2 });
    expect(
      (data.meta_lead_sheets_import_jobs as Row[]).find((r) => r.id === a.id)?.status
    ).toBe('completed');
    expect(
      (data.meta_lead_sheets_import_jobs as Row[]).find((r) => r.id === b.id)?.status
    ).toBe('completed');
    // Both tables' leads landed in their own sheets.
    expect(h.columnValues.get('sheet-1::Meta Leads')).toHaveLength(2);
    expect(h.columnValues.get('sheet-2::Tab B')).toHaveLength(1);
  });

  it('progress reads are side-effect free (poll-safe)', async () => {
    const { db, data } = makeDb(baseFixture([sub('sub-1')]));
    const job = await createImportJob(db, { ...ARGS, mode: 'all', range: null });
    const before = JSON.stringify(data.meta_lead_sheets_queue);
    const progress = await getImportJobProgress(db, job);
    expect(progress.sent).toBe(0);
    expect(progress.pending).toBe(1);
    expect(progress.done).toBe(false);
    expect(JSON.stringify(data.meta_lead_sheets_queue)).toBe(before);
  });
});
