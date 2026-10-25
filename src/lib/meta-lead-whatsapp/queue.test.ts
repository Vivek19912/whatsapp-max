// Meta Lead Ads → WhatsApp auto-send — enqueue idempotency,
// order, delay, pause/resume, retries, tenant isolation. The Meta
// API is never touched: drains run with an injected send fn. No
// production tables are touched.

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  drainWhatsappQueue,
  getTableWhatsappStatus,
  maybeEnqueueWhatsappAutoreplies,
  retryTableWhatsappQueue,
  templateSendBlockers,
  TerminalSendError,
} from './queue';

type Row = Record<string, unknown>;

function isDup(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === '23505'
  );
}

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
      if (f.op === 'neq' && row[f.col] === f.val) return false;
      if (f.op === 'in' && !(f.val as unknown[]).includes(row[f.col]))
        return false;
      if (f.op === 'lte' && String(row[f.col] ?? '') > String(f.val))
        return false;
      if (f.op === 'lt' && String(row[f.col] ?? '') >= String(f.val))
        return false;
      if (f.op === 'not-null' && row[f.col] === null) return false;
    }
    return true;
  }

  function builder(table: string) {
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let patch: Row = {};
    const filters: Array<{ op: string; col: string; val: unknown }> = [];
    const orders: string[] = [];
    let limitN: number | null = null;

    const matched = () =>
      (data[table] ?? []).filter((r) => matches(r, filters));

    const ordered = (rows: Row[]) =>
      orders.length === 0
        ? rows
        : [...rows].sort((a, b) => {
            for (const col of orders) {
              const cmp = String(a[col] ?? '').localeCompare(
                String(b[col] ?? '')
              );
              if (cmp !== 0) return cmp;
            }
            return 0;
          });

    const b: Record<string, (...args: never[]) => unknown> = {
      select: (() => b) as never,
      insert: ((rows: Row | Row[]) => {
        op = 'insert';
        const list = Array.isArray(rows) ? rows : [rows];
        for (const r of list) {
          if (table === 'meta_lead_whatsapp_queue') {
            const dup = (data[table] ?? []).some(
              (existing) =>
                existing.account_id === r.account_id &&
                existing.submission_id === r.submission_id &&
                existing.template_name === r.template_name &&
                (existing.template_language ?? 'en_US') ===
                  (r.template_language ?? 'en_US')
            );
            if (dup) {
              return Promise.resolve({
                data: null,
                error: { code: '23505', message: 'duplicate' },
              });
            }
          }
          (data[table] ??= []).push({
            id: `q-${idCounter++}`,
            status: 'pending',
            attempts: 0,
            max_attempts: 8,
            next_retry_at: new Date(0).toISOString(),
            scheduled_for: new Date(0).toISOString(),
            claimed_at: null,
            provider_message_id: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...r,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }) as never,
      upsert: ((rows: Row | Row[]) => {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const r of list) {
          (data[table] ??= []).push({
            id: `q-${idCounter++}`,
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
      lt: ((col: string, val: unknown) => {
        filters.push({ op: 'lt', col, val });
        return b;
      }) as never,
      not: ((col: string, _op: string, val: unknown) => {
        if (val === null) filters.push({ op: 'not-null', col, val });
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
        const rows = ordered(matched());
        return { data: rows[0] ?? null, error: null };
      }) as never,
      maybeSingle: (async () => {
        if (op === 'update') {
          const targets = matched();
          for (const row of targets) Object.assign(row, patch);
          return { data: targets[0] ?? null, error: null };
        }
        if (op === 'delete') {
          data[table] = (data[table] ?? []).filter(
            (r) => !matches(r, filters)
          );
          return { data: null, error: null };
        }
        let rows = ordered(matched());
        if (limitN !== null) rows = rows.slice(0, limitN);
        return { data: rows[0] ?? null, error: null };
      }) as never,
      then: ((res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === 'update') {
          const targets = matched();
          for (const row of targets) Object.assign(row, patch);
          return Promise.resolve({ data: targets, error: null }).then(
            res,
            rej
          );
        }
        if (op === 'delete') {
          data[table] = (data[table] ?? []).filter(
            (r) => !matches(r, filters)
          );
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        let rows = ordered(matched());
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

const PAST = new Date(Date.now() - 60_000).toISOString();

function submission(over: Partial<Row> = {}): Row {
  return {
    id: 'sub-1',
    account_id: 'acct-1',
    meta_lead_id: 'lead-1',
    flow_run_id: 'run-1',
    form_id: 'form-1',
    contact_id: 'contact-1',
    ...over,
  };
}

function tableConfig(over: Partial<Row> = {}): Row {
  return {
    account_id: 'acct-1',
    form_id: 'form-1',
    paused: false,
    delay_seconds: 0,
    ...over,
  };
}

function templateItem(name: string, position: number, over: Partial<Row> = {}): Row {
  return {
    id: `tpl-${name}-${position}`,
    account_id: 'acct-1',
    form_id: 'form-1',
    template_name: name,
    template_language: 'en_US',
    position,
    variable_mappings: {},
    ...over,
  };
}

/** Approved template catalog row (only the columns the drain reads). */
function approvedTemplate(name: string, over: Partial<Row> = {}): Row {
  return {
    id: `mt-${name}`,
    account_id: 'acct-1',
    name,
    language: 'en_US',
    status: 'APPROVED',
    header_type: null,
    header_content: null,
    header_media_url: null,
    body_text: 'Thanks for reaching out!',
    buttons: [],
    ...over,
  };
}

function metaForm(over: Partial<Row> = {}): Row {
  return {
    id: 'form-db-1',
    account_id: 'acct-1',
    form_id: 'form-1',
    form_name: 'Form A',
    questions: [],
    ...over,
  };
}

function queueRow(over: Partial<Row> = {}): Row {
  return {
    id: `qr-${Math.random().toString(36).slice(2)}`,
    account_id: 'acct-1',
    submission_id: 'sub-1',
    flow_run_id: 'run-1',
    form_id: 'form-1',
    template_name: 'welcome',
    template_language: 'en_US',
    position: 0,
    status: 'pending',
    attempts: 0,
    max_attempts: 8,
    scheduled_for: PAST,
    next_retry_at: PAST,
    provider_message_id: null,
    created_at: PAST,
    updated_at: PAST,
    ...over,
  };
}

describe('maybeEnqueueWhatsappAutoreplies', () => {
  it('enqueues one row per template, staggered by the table delay', async () => {
    const { db, data } = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig({ delay_seconds: 60 })],
      meta_lead_whatsapp_templates: [
        templateItem('t1', 0),
        templateItem('t2', 1),
        templateItem('t3', 2),
      ],
    });

    const out = await maybeEnqueueWhatsappAutoreplies(db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    expect(out).toMatchObject({ enqueued: 3, skipped: false });
    const rows = data.meta_lead_whatsapp_queue;
    expect(rows).toHaveLength(3);
    const times = rows
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((r) => Date.parse(r.scheduled_for as string));
    expect(times[1] - times[0]).toBe(60_000);
    expect(times[2] - times[1]).toBe(60_000);
  });

  it('reprocessing the same lead is a no-op (already queued, no duplicates)', async () => {
    const ctx = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig()],
      meta_lead_whatsapp_templates: [templateItem('t1', 0)],
    });
    const first = await maybeEnqueueWhatsappAutoreplies(ctx.db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    const second = await maybeEnqueueWhatsappAutoreplies(ctx.db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    expect(first.enqueued).toBe(1);
    expect(second).toMatchObject({ enqueued: 0, alreadyQueued: 1 });
    expect(ctx.data.meta_lead_whatsapp_queue).toHaveLength(1);
  });

  it('skips leads whose table has no configured templates', async () => {
    const { db } = makeDb({ meta_lead_submissions: [submission()] });
    const out = await maybeEnqueueWhatsappAutoreplies(db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    expect(out.skipped).toBe(true);
  });

  it('enqueues while paused (rows park in the drain; resume sends them)', async () => {
    const { db, data } = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig({ paused: true })],
      meta_lead_whatsapp_templates: [templateItem('t1', 0)],
    });
    const out = await maybeEnqueueWhatsappAutoreplies(db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    expect(out.enqueued).toBe(1);
    expect(data.meta_lead_whatsapp_queue).toHaveLength(1);
  });
});

describe('drainWhatsappQueue', () => {
  function baseDb(rows: Row[], over: Record<string, Row[]> = {}) {
    return makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig()],
      meta_lead_whatsapp_templates: [templateItem('welcome', 0)],
      meta_lead_whatsapp_queue: rows,
      message_templates: [approvedTemplate('welcome')],
      meta_lead_forms: [metaForm()],
      flow_runs: [{ id: 'run-1', user_id: 'user-1' }],
      profiles: [{ user_id: 'user-1', account_id: 'acct-1' }],
      ...over,
    });
  }

  it('sends due rows in order and records provider + inbox ids', async () => {
    const sent: string[] = [];
    const seen: Array<{ params: unknown; variableValues: unknown }> = [];
    const { db, data } = baseDb([queueRow()]);
    const out = await drainWhatsappQueue(db, {
      sendImpl: (async (
        _d: unknown,
        a: { templateName: string; params: unknown; variableValues: unknown }
      ) => {
        sent.push(a.templateName);
        seen.push({ params: a.params, variableValues: a.variableValues });
        return {
          providerMessageId: `wamid-${a.templateName}`,
          conversationId: 'conv-1',
          inboxMessageId: 'msg-1',
        };
      }) as never,
    });
    expect(out).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
    expect(sent).toEqual(['welcome']);
    // Static template: no params, no resolved values.
    expect(seen).toEqual([{ params: {}, variableValues: {} }]);
    const row = data.meta_lead_whatsapp_queue[0];
    expect(row.status).toBe('sent');
    expect(row.provider_message_id).toBe('wamid-welcome');
    expect(row.inbox_message_id).toBe('msg-1');
  });

  it('sends a zero-delay sequence in order within one sweep', async () => {
    const sent: string[] = [];
    const { db, data } = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig({ delay_seconds: 0 })],
      meta_lead_whatsapp_templates: [
        templateItem('t1', 0),
        templateItem('t2', 1),
      ],
      meta_lead_whatsapp_queue: [
        queueRow({ id: 'q1', template_name: 't1', position: 0 }),
        queueRow({ id: 'q2', template_name: 't2', position: 1 }),
      ],
      message_templates: [approvedTemplate('t1'), approvedTemplate('t2')],
      meta_lead_forms: [metaForm()],
      flow_runs: [{ id: 'run-1', user_id: 'user-1' }],
      profiles: [{ user_id: 'user-1', account_id: 'acct-1' }],
    });
    const sendImpl = (async (_d: unknown, a: { templateName: string }) => {
      sent.push(a.templateName);
      return {
        providerMessageId: `wamid-${a.templateName}`,
        conversationId: 'conv-1',
        inboxMessageId: `msg-${a.templateName}`,
      };
    }) as never;
    const out = await drainWhatsappQueue(db, { sendImpl });
    // Immediate AND ordered: t1 completes before t2 is attempted.
    expect(sent).toEqual(['t1', 't2']);
    expect(out).toMatchObject({ sent: 2, failed: 0 });
    for (const r of data.meta_lead_whatsapp_queue as Row[]) {
      expect(r.status).toBe('sent');
    }
  });

  it('holds later items until their delay elapses, then sends in order', async () => {
    const sent: string[] = [];
    const future = new Date(Date.now() + 60_000).toISOString();
    const { db, data } = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig({ delay_seconds: 60 })],
      meta_lead_whatsapp_templates: [
        templateItem('t1', 0),
        templateItem('t2', 1),
      ],
      meta_lead_whatsapp_queue: [
        queueRow({ id: 'q1', template_name: 't1', position: 0 }),
        queueRow({
          id: 'q2',
          template_name: 't2',
          position: 1,
          scheduled_for: future,
          next_retry_at: future,
        }),
      ],
      message_templates: [approvedTemplate('t1'), approvedTemplate('t2')],
      meta_lead_forms: [metaForm()],
      flow_runs: [{ id: 'run-1', user_id: 'user-1' }],
      profiles: [{ user_id: 'user-1', account_id: 'acct-1' }],
    });
    const sendImpl = (async (_d: unknown, a: { templateName: string }) => {
      sent.push(a.templateName);
      return {
        providerMessageId: `wamid-${a.templateName}`,
        conversationId: 'conv-1',
        inboxMessageId: `msg-${a.templateName}`,
      };
    }) as never;
    const first = await drainWhatsappQueue(db, { sendImpl });
    expect(sent).toEqual(['t1']);
    expect(first.sent).toBe(1);
    // The delayed item becomes due: it sends next, preserving order.
    (data.meta_lead_whatsapp_queue as Row[]).find(
      (r) => r.id === 'q2'
    )!.scheduled_for = PAST;
    (data.meta_lead_whatsapp_queue as Row[]).find(
      (r) => r.id === 'q2'
    )!.next_retry_at = PAST;
    const second = await drainWhatsappQueue(db, { sendImpl });
    expect(sent).toEqual(['t1', 't2']);
    expect(second.sent).toBe(1);
  });

  it('never sends an item while an earlier item is claimed elsewhere (concurrency)', async () => {
    const sendImpl = vi.fn();
    const { db, data } = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig()],
      meta_lead_whatsapp_templates: [
        templateItem('t1', 0),
        templateItem('t2', 1),
      ],
      meta_lead_whatsapp_queue: [
        // t1 claimed moments ago by a concurrent worker.
        queueRow({
          id: 'q1',
          template_name: 't1',
          position: 0,
          status: 'sending',
          claimed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        queueRow({ id: 'q2', template_name: 't2', position: 1 }),
      ],
      flow_runs: [{ id: 'run-1', user_id: 'user-1' }],
      profiles: [{ user_id: 'user-1', account_id: 'acct-1' }],
    });
    const out = await drainWhatsappQueue(db, { sendImpl: sendImpl as never });
    expect(sendImpl).not.toHaveBeenCalled();
    expect(out.skippedOutOfOrder).toBe(1);
    expect(
      (data.meta_lead_whatsapp_queue as Row[]).find((r) => r.id === 'q2')
        ?.status
    ).toBe('pending');
  });

  it('parks rows for paused tables without sending (resume continues)', async () => {
    const sendImpl = vi.fn();
    const { db, data } = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig({ paused: true })],
      meta_lead_whatsapp_templates: [templateItem('welcome', 0)],
      meta_lead_whatsapp_queue: [queueRow()],
      message_templates: [approvedTemplate('welcome')],
      meta_lead_forms: [metaForm()],
    });
    const out = await drainWhatsappQueue(db, { sendImpl: sendImpl as never });
    expect(sendImpl).not.toHaveBeenCalled();
    expect(out.skippedPaused).toBe(1);
    expect(data.meta_lead_whatsapp_queue[0].status).toBe('pending');

    // Resume: the same row sends without re-enqueue.
    (data.meta_lead_whatsapp_configs[0] as Row).paused = false;
    const out2 = await drainWhatsappQueue(db, {
      sendImpl: (async () => ({
        providerMessageId: 'wamid-1',
        conversationId: 'conv-1',
        inboxMessageId: 'msg-1',
      })) as never,
    });
    expect(out2.sent).toBe(1);
  });

  it('fails terminally with a clear message when the lead has no phone', async () => {
    const sendImpl = vi.fn();
    const { db, data } = makeDb({
      meta_lead_submissions: [submission({ contact_id: null })],
      meta_lead_whatsapp_configs: [tableConfig()],
      meta_lead_whatsapp_templates: [templateItem('welcome', 0)],
      meta_lead_whatsapp_queue: [queueRow()],
    });
    const out = await drainWhatsappQueue(db, { sendImpl: sendImpl as never });
    expect(sendImpl).not.toHaveBeenCalled();
    expect(out.failed).toBe(1);
    const row = data.meta_lead_whatsapp_queue[0];
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(row.max_attempts);
    expect(String(row.last_error)).toMatch(/no phone/i);
  });

  it('retries transient failures without resending successes', async () => {
    let calls = 0;
    const { db, data } = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig()],
      meta_lead_whatsapp_templates: [templateItem('welcome', 0)],
      meta_lead_whatsapp_queue: [queueRow()],
      message_templates: [approvedTemplate('welcome')],
      meta_lead_forms: [metaForm()],
      flow_runs: [{ id: 'run-1', user_id: 'user-1' }],
      profiles: [{ user_id: 'user-1', account_id: 'acct-1' }],
    });
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('rate limited (429), try later');
      return {
        providerMessageId: 'wamid-1',
        conversationId: 'conv-1',
        inboxMessageId: 'msg-1',
      };
    }) as never;
    const first = await drainWhatsappQueue(db, { sendImpl: flaky });
    expect(first.failed).toBe(1);
    const row = data.meta_lead_whatsapp_queue[0];
    expect(row.status).toBe('failed');
    expect(Number(row.attempts)).toBe(1);
    // Not yet due (backoff) — a second sweep leaves it alone.
    const idle = await drainWhatsappQueue(db, { sendImpl: flaky });
    expect(idle.attempted).toBe(0);
    // After the backoff elapses the retry succeeds exactly once.
    (data.meta_lead_whatsapp_queue[0] as Row).next_retry_at = PAST;
    const retry = await drainWhatsappQueue(db, { sendImpl: flaky });
    expect(retry.sent).toBe(1);
    expect(calls).toBe(2);
  });

  it('terminal transport errors fail fast and unblock later items', async () => {
    const { db, data } = makeDb({
      meta_lead_submissions: [submission()],
      meta_lead_whatsapp_configs: [tableConfig()],
      meta_lead_whatsapp_templates: [
        templateItem('t1', 0),
        templateItem('t2', 1),
      ],
      meta_lead_whatsapp_queue: [
        queueRow({ id: 'q1', template_name: 't1', position: 0 }),
        queueRow({ id: 'q2', template_name: 't2', position: 1 }),
      ],
      message_templates: [approvedTemplate('t1'), approvedTemplate('t2')],
      meta_lead_forms: [metaForm()],
      flow_runs: [{ id: 'run-1', user_id: 'user-1' }],
      profiles: [{ user_id: 'user-1', account_id: 'acct-1' }],
    });
    const sendImpl = (async (_d: unknown, a: { templateName: string }) => {
      if (a.templateName === 't1') {
        throw new TerminalSendError('template deleted');
      }
      return {
        providerMessageId: 'wamid-t2',
        conversationId: 'conv-1',
        inboxMessageId: 'msg-t2',
      };
    }) as never;
    await drainWhatsappQueue(db, { sendImpl });
    await drainWhatsappQueue(db, { sendImpl });
    const byId = Object.fromEntries(
      (data.meta_lead_whatsapp_queue as Row[]).map((r) => [r.id, r])
    );
    expect(byId.q1.status).toBe('failed');
    expect(byId.q1.attempts).toBe(byId.q1.max_attempts);
    expect(byId.q2.status).toBe('sent');
  });

  it('onlyAccountId scopes the drain (tenant isolation)', async () => {
    const sent: string[] = [];
    const { db } = makeDb({
      meta_lead_submissions: [
        submission(),
        submission({ id: 'sub-2', account_id: 'acct-2', contact_id: 'c2' }),
      ],
      meta_lead_whatsapp_configs: [
        tableConfig(),
        tableConfig({ account_id: 'acct-2', form_id: 'form-1' }),
      ],
      meta_lead_whatsapp_templates: [
        templateItem('welcome', 0),
        templateItem('welcome', 0, {
          id: 'tpl-b',
          account_id: 'acct-2',
        }),
      ],
      meta_lead_whatsapp_queue: [
        queueRow(),
        queueRow({
          id: 'qb',
          account_id: 'acct-2',
          submission_id: 'sub-2',
        }),
      ],
      message_templates: [
        approvedTemplate('welcome'),
        approvedTemplate('welcome', { id: 'mt-b', account_id: 'acct-2' }),
      ],
      meta_lead_forms: [metaForm()],
      flow_runs: [{ id: 'run-1', user_id: 'user-1' }],
      profiles: [{ user_id: 'user-1', account_id: 'acct-1' }],
    });
    const out = await drainWhatsappQueue(db, {
      onlyAccountId: 'acct-1',
      sendImpl: (async (
        _d: unknown,
        a: { accountId: string; templateName: string }
      ) => {
        sent.push(`${a.accountId}:${a.templateName}`);
        return {
          providerMessageId: 'wamid-x',
          conversationId: 'conv-1',
          inboxMessageId: 'msg-1',
        };
      }) as never,
    });
    expect(out.sent).toBe(1);
    expect(sent).toEqual(['acct-1:welcome']);
  });

  it('revives failed rows for retry without touching sent rows', async () => {
    const { db, data } = makeDb({
      meta_lead_whatsapp_queue: [
        queueRow({ id: 'qf', status: 'failed', attempts: 8 }),
        queueRow({ id: 'qs', status: 'sent', attempts: 1 }),
      ],
    });
    const out = await retryTableWhatsappQueue(db, 'acct-1', 'form-1');
    expect(out.revived).toBe(1);
    const byId = Object.fromEntries(
      (data.meta_lead_whatsapp_queue as Row[]).map((r) => [r.id, r])
    );
    expect(byId.qf.status).toBe('pending');
    expect(byId.qf.attempts).toBe(0);
    expect(byId.qs.status).toBe('sent');
  });

  it('getTableWhatsappStatus reports config + history counts', async () => {
    const { db } = makeDb({
      meta_lead_whatsapp_configs: [tableConfig({ delay_seconds: 30 })],
      meta_lead_whatsapp_templates: [templateItem('welcome', 0)],
      meta_lead_whatsapp_queue: [
        queueRow({ id: 'a', status: 'sent' }),
        queueRow({ id: 'b', status: 'failed', template_name: 'other' }),
      ],
    });
    const status = await getTableWhatsappStatus(db, 'acct-1', 'form-1');
    expect(status).toMatchObject({
      configured: true,
      paused: false,
      delay_seconds: 30,
    });
    expect(status.items).toHaveLength(1);
    expect(status.counts).toMatchObject({ sent: 1, failed: 1 });
  });
});

describe('drainWhatsappQueue with template variables', () => {
  const FORM_QUESTIONS = [
    { key: 'full_name', label: 'Full name', type: 'text' },
    { key: 'city', label: 'City', type: 'text' },
  ];

  function varTemplate(name: string, body: string, over: Partial<Row> = {}): Row {
    return approvedTemplate(name, { body_text: body, ...over });
  }

  function leadDb(over: Record<string, Row[]> = {}) {
    return makeDb({
      meta_lead_submissions: [
        submission({
          form_name: 'Form A',
          campaign_name: 'Camp',
          ad_name: 'Ad',
          source: 'facebook',
          created_at: PAST,
        }),
      ],
      meta_lead_whatsapp_configs: [tableConfig()],
      meta_lead_whatsapp_templates: [
        templateItem('hello_lead', 0, {
          variable_mappings: { 'body:1': 'name' },
        }),
      ],
      meta_lead_whatsapp_queue: [
        queueRow({ template_name: 'hello_lead' }),
      ],
      message_templates: [
        varTemplate('hello_lead', 'Hello {{1}}, thanks for your enquiry!'),
      ],
      meta_lead_forms: [metaForm({ questions: FORM_QUESTIONS })],
      flow_runs: [
        {
          id: 'run-1',
          account_id: 'acct-1',
          user_id: 'user-1',
          flow_id: 'flow-1',
          vars: { full_name: 'Asha', city: 'Goa' },
          started_at: PAST,
          contact_id: 'contact-1',
        },
      ],
      contacts: [
        {
          id: 'contact-1',
          account_id: 'acct-1',
          name: 'Asha Sharma',
          phone: '+911234567890',
        },
      ],
      profiles: [{ user_id: 'user-1', account_id: 'acct-1' }],
      ...over,
    });
  }

  function capture() {
    const calls: Array<{
      templateName: string;
      params: { body?: string[]; headerText?: string; buttonParams?: Record<number, string> };
      variableValues: Record<string, string>;
    }> = [];
    const sendImpl = (async (
      _d: unknown,
      a: {
        templateName: string;
        params: { body?: string[]; headerText?: string; buttonParams?: Record<number, string> };
        variableValues: Record<string, string>;
      }
    ) => {
      calls.push({
        templateName: a.templateName,
        params: a.params,
        variableValues: { ...a.variableValues },
      });
      return {
        providerMessageId: `wamid-${calls.length}`,
        conversationId: 'conv-1',
        inboxMessageId: `msg-${calls.length}`,
      };
    }) as never;
    return { calls, sendImpl };
  }

  it('maps {{1}} to Name only, preferring the contact row', async () => {
    const { db, data } = leadDb();
    const { calls, sendImpl } = capture();
    const out = await drainWhatsappQueue(db, { sendImpl });
    expect(out).toMatchObject({ sent: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    // Contact row wins over the raw answer for Name.
    expect(calls[0].params.body).toEqual(['Asha Sharma']);
    expect(calls[0].variableValues).toEqual({ 'body:1': 'Asha Sharma' });
    expect(data.meta_lead_whatsapp_queue[0].status).toBe('sent');
  });

  it('maps multiple variables to different Workspace fields in order', async () => {
    const { db } = leadDb({
      message_templates: [
        varTemplate('hello_lead', 'Hi {{1}} from {{2}}, welcome!'),
      ],
      meta_lead_whatsapp_templates: [
        templateItem('hello_lead', 0, {
          variable_mappings: { 'body:1': 'name', 'body:2': 'answer:city' },
        }),
      ],
    });
    const { calls, sendImpl } = capture();
    const out = await drainWhatsappQueue(db, { sendImpl });
    expect(out.sent).toBe(1);
    expect(calls[0].params.body).toEqual(['Asha Sharma', 'Goa']);
  });

  it('sends URL-button variables through the button component', async () => {
    const { db } = leadDb({
      message_templates: [
        varTemplate('track_lead', 'Track your request:', {
          body_text: 'Track your request:',
          buttons: [
            { type: 'URL', text: 'Track', url: 'https://x.test/t/{{1}}' },
          ],
        }),
      ],
      meta_lead_whatsapp_templates: [
        templateItem('track_lead', 0, {
          variable_mappings: { 'button:0:1': 'meta_lead_id' },
        }),
      ],
      meta_lead_whatsapp_queue: [queueRow({ template_name: 'track_lead' })],
    });
    const { calls, sendImpl } = capture();
    const out = await drainWhatsappQueue(db, { sendImpl });
    expect(out.sent).toBe(1);
    expect(calls[0].params.body).toBeUndefined();
    expect(calls[0].params.buttonParams).toEqual({ 0: 'lead-1' });
  });

  it('fails retryably with a clear reason when a value is missing — no send, no placeholder', async () => {
    const { db, data } = leadDb({
      flow_runs: [
        {
          id: 'run-1',
          account_id: 'acct-1',
          user_id: 'user-1',
          flow_id: 'flow-1',
          // City answer missing for this lead.
          vars: { full_name: 'Asha' },
          started_at: PAST,
          contact_id: 'contact-1',
        },
      ],
      meta_lead_whatsapp_templates: [
        templateItem('hello_lead', 0, {
          variable_mappings: { 'body:1': 'name', 'body:2': 'answer:city' },
        }),
      ],
      message_templates: [
        varTemplate('hello_lead', 'Hi {{1}} from {{2}}!'),
      ],
    });
    const { calls, sendImpl } = capture();
    const out = await drainWhatsappQueue(db, { sendImpl });
    expect(calls).toHaveLength(0);
    expect(out).toMatchObject({ sent: 0, failed: 1 });
    const row = data.meta_lead_whatsapp_queue[0];
    expect(row.status).toBe('failed');
    expect(Number(row.attempts)).toBe(1);
    expect(String(row.last_error)).toMatch(/answer:city/);

    // The agent fills the missing answer; the retry then sends.
    ((data.flow_runs as Row[])[0] as Row).vars = {
      full_name: 'Asha',
      city: 'Goa',
    };
    (row as Row).next_retry_at = PAST;
    const retry = await drainWhatsappQueue(db, { sendImpl });
    expect(retry.sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].params.body).toEqual(['Asha Sharma', 'Goa']);
    for (const v of Object.values(calls[0].variableValues)) {
      expect(v).not.toContain('{{');
    }
  });

  it('keeps mappings independent across tables for the same template', async () => {
    const { db } = leadDb({
      meta_lead_submissions: [
        submission({
          id: 'sub-1',
          form_id: 'form-1',
          flow_run_id: 'run-1',
          contact_id: 'contact-1',
          created_at: PAST,
        }),
        submission({
          id: 'sub-2',
          form_id: 'form-2',
          flow_run_id: 'run-2',
          contact_id: 'contact-2',
          created_at: PAST,
        }),
      ],
      meta_lead_whatsapp_configs: [
        tableConfig(),
        tableConfig({ form_id: 'form-2' }),
      ],
      meta_lead_whatsapp_templates: [
        templateItem('hello_lead', 0, {
          variable_mappings: { 'body:1': 'name' },
        }),
        templateItem('hello_lead', 0, {
          id: 'tpl-form-2',
          form_id: 'form-2',
          variable_mappings: { 'body:1': 'answer:city' },
        }),
      ],
      meta_lead_whatsapp_queue: [
        queueRow({ id: 'qa', template_name: 'hello_lead' }),
        queueRow({
          id: 'qb',
          submission_id: 'sub-2',
          flow_run_id: 'run-2',
          form_id: 'form-2',
          template_name: 'hello_lead',
        }),
      ],
      message_templates: [
        varTemplate('hello_lead', 'Hello {{1}}!'),
      ],
      meta_lead_forms: [
        metaForm({ questions: FORM_QUESTIONS }),
        metaForm({ id: 'form-db-2', form_id: 'form-2', questions: FORM_QUESTIONS }),
      ],
      flow_runs: [
        {
          id: 'run-1',
          account_id: 'acct-1',
          user_id: 'user-1',
          flow_id: 'flow-1',
          vars: { full_name: 'Asha', city: 'Goa' },
          started_at: PAST,
          contact_id: 'contact-1',
        },
        {
          id: 'run-2',
          account_id: 'acct-1',
          user_id: 'user-1',
          flow_id: 'flow-2',
          vars: { full_name: 'Ravi', city: 'Jaipur' },
          started_at: PAST,
          contact_id: 'contact-2',
        },
      ],
      contacts: [
        { id: 'contact-1', account_id: 'acct-1', name: 'Asha Sharma', phone: '+911234567890' },
        { id: 'contact-2', account_id: 'acct-1', name: 'Ravi Kumar', phone: '+911234567891' },
      ],
    });
    const { calls, sendImpl } = capture();
    const out = await drainWhatsappQueue(db, { sendImpl });
    expect(out).toMatchObject({ sent: 2, failed: 0 });
    const bodies = calls.map((c) => c.params.body?.[0]);
    // Form 1 maps Name, form 2 maps City — never shared.
    expect(bodies).toEqual(['Asha Sharma', 'Jaipur']);
  });

  it('fails retryably when the mapping is incomplete, and recovers after mapping fix', async () => {
    const { db, data } = leadDb({
      meta_lead_whatsapp_templates: [templateItem('hello_lead', 0)],
    });
    const { calls, sendImpl } = capture();
    const out = await drainWhatsappQueue(db, { sendImpl });
    expect(calls).toHaveLength(0);
    expect(out.failed).toBe(1);
    expect(String(data.meta_lead_whatsapp_queue[0].last_error)).toMatch(
      /missing a variable mapping/i
    );
    expect(Number(data.meta_lead_whatsapp_queue[0].attempts)).toBe(1);

    // Admin fixes the mapping; the retry sends without re-enqueue.
    (data.meta_lead_whatsapp_templates as Row[])[0].variable_mappings = {
      'body:1': 'name',
    };
    (data.meta_lead_whatsapp_queue[0] as Row).next_retry_at = PAST;
    const retry = await drainWhatsappQueue(db, { sendImpl });
    expect(retry.sent).toBe(1);
    expect(calls[0].params.body).toEqual(['Asha Sharma']);
  });

  it('fails terminally for a deleted template and unblocks later items', async () => {
    const { db, data } = leadDb({
      meta_lead_whatsapp_templates: [
        templateItem('gone', 0),
        templateItem('hello_lead', 1, {
          variable_mappings: { 'body:1': 'name' },
        }),
      ],
      meta_lead_whatsapp_queue: [
        queueRow({ id: 'q1', template_name: 'gone', position: 0 }),
        queueRow({ id: 'q2', template_name: 'hello_lead', position: 1 }),
      ],
    });
    const { calls, sendImpl } = capture();
    await drainWhatsappQueue(db, { sendImpl });
    await drainWhatsappQueue(db, { sendImpl });
    const byId = Object.fromEntries(
      (data.meta_lead_whatsapp_queue as Row[]).map((r) => [r.id, r])
    );
    expect(byId.q1.status).toBe('failed');
    expect(byId.q1.attempts).toBe(byId.q1.max_attempts);
    expect(String(byId.q1.last_error)).toMatch(/no longer exists/);
    expect(byId.q2.status).toBe('sent');
    expect(calls).toHaveLength(1);
  });

  it('reprocessing a variable template lead is a no-op (no duplicate send)', async () => {
    const ctx = leadDb({ meta_lead_whatsapp_queue: [] });
    const { calls, sendImpl } = capture();
    const first = await maybeEnqueueWhatsappAutoreplies(ctx.db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    // A second ingestion pass for the same lead collapses.
    const second = await maybeEnqueueWhatsappAutoreplies(ctx.db, {
      accountId: 'acct-1',
      submissionId: 'sub-1',
    });
    expect(first.enqueued).toBe(1);
    expect(second.alreadyQueued).toBe(1);
    await drainWhatsappQueue(ctx.db, { sendImpl });
    await drainWhatsappQueue(ctx.db, { sendImpl });
    expect(calls).toHaveLength(1);
  });
});

describe('templateSendBlockers', () => {
  it('allows static templates and templates with variables (mapped per table)', () => {
    expect(
      templateSendBlockers({
        header_type: undefined,
        header_content: undefined,
        body_text: 'Thanks! We will call you soon.',
        buttons: [],
      })
    ).toEqual([]);
    // Variables are no longer structural blockers — mappings
    // stored per table/template satisfy them at send time.
    expect(
      templateSendBlockers({
        header_type: 'text',
        header_content: 'Hi {{1}}',
        body_text: 'Hello {{1}}, code {{2}}',
        buttons: [{ type: 'URL', text: 'Track', url: 'https://x.test/{{1}}' }],
      })
    ).toEqual([]);
  });

  it('still blocks media headers with no stored file', () => {
    expect(
      templateSendBlockers({
        header_type: 'image',
        header_content: undefined,
        body_text: 'Static',
        buttons: [],
      }).length
    ).toBeGreaterThan(0);
  });

  it('isUniqueViolation treats 23505 as a duplicate enqueue', () => {
    expect(isDup({ code: '23505' })).toBe(true);
    expect(isDup({ code: '42501' })).toBe(false);
  });
});
