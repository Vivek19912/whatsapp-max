// System-wide regression: salesperson-specific customer sequences must send
// WITHOUT a global meta_lead_whatsapp_configs row. Covers Mukesh, Aman,
// Rohit, Utkarsh across tables/keys. Mock DB only; Meta API never touched.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { salespersonKeyFor } from './assignee-sequences';
import { drainWhatsappQueue, maybeEnqueueAssigneeSequence } from './queue';

type Row = Record<string, unknown>;
const PAST = new Date(Date.now() - 60_000).toISOString();

function makeDb(initial: Record<string, Row[]>) {
  const data: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(initial)) data[t] = rows.map((r) => ({ ...r }));
  let n = 500;
  function isDup(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
  }
  void isDup;
  function matches(row: Row, fs: Array<{ op: string; col: string; val: unknown }>): boolean {
    for (const f of fs) {
      if (f.op === 'eq' && row[f.col] !== f.val) return false;
      if (f.op === 'neq' && row[f.col] === f.val) return false;
      if (f.op === 'is' && f.val === null && row[f.col] != null) return false;
      if (f.op === 'is' && f.val !== null && row[f.col] !== f.val) return false;
      if (f.op === 'in' && !(f.val as unknown[]).includes(row[f.col])) return false;
      if (f.op === 'lte' && String(row[f.col] ?? '') > String(f.val)) return false;
      if (f.op === 'lt' && String(row[f.col] ?? '') >= String(f.val)) return false;
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
    const matched = () => (data[table] ?? []).filter((r) => matches(r, filters));
    const ordered = (rows: Row[]) =>
      orders.length === 0 ? rows : [...rows].sort((a, b) => {
        for (const col of orders) {
          const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    const b: Record<string, (...a: never[]) => unknown> = {
      select: (() => b) as never,
      is: ((c: string, v: unknown) => { filters.push({ op: 'is', col: c, val: v }); return b; }) as never,
      eq: ((c: string, v: unknown) => { filters.push({ op: 'eq', col: c, val: v }); return b; }) as never,
      neq: ((c: string, v: unknown) => { filters.push({ op: 'neq', col: c, val: v }); return b; }) as never,
      in: ((c: string, v: unknown[]) => { filters.push({ op: 'in', col: c, val: v }); return b; }) as never,
      lte: ((c: string, v: unknown) => { filters.push({ op: 'lte', col: c, val: v }); return b; }) as never,
      lt: ((c: string, v: unknown) => { filters.push({ op: 'lt', col: c, val: v }); return b; }) as never,
      not: ((c: string, _o: string, v: unknown) => { if (v === null) filters.push({ op: 'not-null', col: c, val: v }); return b; }) as never,
      order: ((c: string) => { orders.push(c); return b; }) as never,
      limit: ((x: number) => { limitN = x; return b; }) as never,
      insert: ((rows: Row | Row[]) => {
        op = 'insert';
        for (const r of Array.isArray(rows) ? rows : [rows]) {
          if (table === 'meta_lead_whatsapp_queue') {
            const dup = (data[table] ?? []).some(
              (e) => e.account_id === r.account_id && e.submission_id === r.submission_id &&
                e.template_name === r.template_name &&
                (e.template_language ?? 'en_US') === (r.template_language ?? 'en_US'),
            );
            if (dup) return Promise.resolve({ data: null, error: { code: '23505', message: 'dup' } });
          }
          (data[table] ??= []).push({ id: `q-${n++}`, status: 'pending', attempts: 0, max_attempts: 8, next_retry_at: new Date(0).toISOString(), scheduled_for: new Date(0).toISOString(), claimed_at: null, provider_message_id: null, created_at: PAST, updated_at: PAST, ...r });
        }
        return Promise.resolve({ data: null, error: null });
      }) as never,
      upsert: ((rows: Row | Row[]) => {
        for (const r of Array.isArray(rows) ? rows : [rows]) (data[table] ??= []).push({ id: `q-${n++}`, created_at: PAST, updated_at: PAST, ...r });
        return Promise.resolve({ data: null, error: null });
      }) as never,
      update: ((p: Row) => { op = 'update'; patch = p; return b; }) as never,
      delete: (() => { op = 'delete'; return b; }) as never,
      single: (async () => ({ data: ordered(matched())[0] ?? null, error: null })) as never,
      maybeSingle: (async () => {
        if (op === 'update') { const t = matched(); for (const r of t) Object.assign(r, patch); return { data: t[0] ?? null, error: null }; }
        if (op === 'delete') { data[table] = (data[table] ?? []).filter((r) => !matches(r, filters)); return { data: null, error: null }; }
        let rows = ordered(matched());
        if (limitN !== null) rows = rows.slice(0, limitN);
        return { data: rows[0] ?? null, error: null };
      }) as never,
      then: ((res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === 'update') { const t = matched(); for (const r of t) Object.assign(r, patch); return Promise.resolve({ data: t, error: null }).then(res, rej); }
        if (op === 'delete') { data[table] = (data[table] ?? []).filter((r) => !matches(r, filters)); return Promise.resolve({ data: null, error: null }).then(res, rej); }
        let rows = ordered(matched());
        if (limitN !== null) rows = rows.slice(0, limitN);
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      }) as never,
    };
    return b;
  }
  return { db: { from: (t: string) => builder(t) } as unknown as SupabaseClient, data };
}

const sub = (over: Partial<Row> = {}): Row => ({ id: 'sub-1', account_id: 'acct-1', meta_lead_id: 'l1', flow_run_id: 'run-1', form_id: 'form-1', contact_id: 'contact-1', ...over });
const seq = (key: string, over: Partial<Row> = {}): Row => ({ id: `seq-${key}`, account_id: 'acct-1', form_id: 'form-1', salesperson_key: key, delay_seconds: 0, ...over });
const item = (seqId: string, name: string, pos: number, over: Partial<Row> = {}): Row => ({ id: `ai-${seqId}-${name}`, sequence_id: seqId, template_name: name, template_language: 'en_US', position: pos, variable_mappings: {}, ...over });
const qrow = (over: Partial<Row> = {}): Row => ({ id: `qr-${Math.random().toString(36).slice(2)}`, account_id: 'acct-1', submission_id: 'sub-1', flow_run_id: 'run-1', form_id: 'form-1', template_name: 'tpl', template_language: 'en_US', position: 0, status: 'pending', attempts: 0, max_attempts: 8, scheduled_for: PAST, next_retry_at: PAST, provider_message_id: null, created_at: PAST, updated_at: PAST, ...over });
const approved = (name: string, over: Partial<Row> = {}): Row => ({ id: `mt-${name}`, account_id: 'acct-1', name, language: 'en_US', status: 'APPROVED', header_type: null, header_content: null, header_media_url: null, body_text: 'Hello', buttons: [], ...over });
const baseExtra = (): Record<string, Row[]> => ({
  meta_lead_forms: [{ id: 'fdb', account_id: 'acct-1', form_id: 'form-1', form_name: 'Form 1', questions: [] }],
  flow_runs: [{ id: 'run-1', account_id: 'acct-1', user_id: 'u-1', flow_id: 'flow-1', vars: { full_name: 'Lead Singh' }, started_at: PAST, contact_id: 'contact-1' }],
  contacts: [{ id: 'contact-1', account_id: 'acct-1', name: 'Lead Singh', phone: '+911234567890' }],
  profiles: [{ user_id: 'u-1', account_id: 'acct-1' }],
});
function sender(calls: Array<{ templateName: string; contactId: string; params?: unknown }>) {
  let i = 0;
  const sendImpl = (async (_d: unknown, a: { templateName: string; contactId: string; params?: unknown }) => {
    i += 1; calls.push({ templateName: a.templateName, contactId: a.contactId, params: a.params });
    return { providerMessageId: `wamid-${i}`, conversationId: 'conv-1', inboxMessageId: `msg-${i}` };
  }) as never;
  return sendImpl;
}

describe('system-wide: assignee sequences need no global config', () => {
  const people = [
    { label: 'Mukesh', key: 'user:u-mukesh', tpl: 'mukesh_tpl' },
    { label: 'Aman', key: 'user:u-aman', tpl: 'aman_tpl' },
    { label: 'Rohit', key: 'email:rohit@example.com', tpl: 'rohit_tpl' },
    { label: 'Utkarsh', key: 'user:u-utkarsh', tpl: 'utkarsh_kashi_notice_2026' },
  ];
  it.each(people)('$label drains without any meta_lead_whatsapp_configs row', async ({ key, tpl }) => {
    const calls: Array<{ templateName: string; contactId: string; params?: unknown }> = [];
    const { db, data } = makeDb({
      meta_lead_submissions: [sub()],
      // NOTE: no meta_lead_whatsapp_configs at all.
      meta_lead_assignee_sequences: [seq(key)],
      meta_lead_assignee_sequence_items: [item(`seq-${key}`, tpl, 0)],
      meta_lead_whatsapp_queue: [qrow({ template_name: tpl, assignee_key: key })],
      message_templates: [approved(tpl)],
      ...baseExtra(),
    });
    const out = await drainWhatsappQueue(db, { sendImpl: sender(calls) });
    expect(out).toMatchObject({ sent: 1, failed: 0, skippedNoConfig: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ templateName: tpl, contactId: 'contact-1' });
    // Recipient is the lead contact, provider IDs persisted for Inbox/webhooks.
    expect(data.meta_lead_whatsapp_queue[0].status).toBe('sent');
    expect(data.meta_lead_whatsapp_queue[0].provider_message_id).toBe('wamid-1');
    expect(data.meta_lead_whatsapp_queue[0].inbox_message_id).toBe('msg-1');
  });

  it('different tables resolve their own salesperson sequence', async () => {
    const calls: Array<{ templateName: string; contactId: string; params?: unknown }> = [];
    const key = 'user:u-aman';
    const { db } = makeDb({
      meta_lead_submissions: [sub({ form_id: 'form-B' })],
      meta_lead_assignee_sequences: [
        { ...seq(key), id: 'seq-A', form_id: 'form-A' },
        { ...seq(key), id: 'seq-B', form_id: 'form-B' },
      ],
      meta_lead_assignee_sequence_items: [
        { ...item('seq-A', 'aman_tpl_A', 0), sequence_id: 'seq-A' },
        { ...item('seq-B', 'aman_tpl_B', 0), sequence_id: 'seq-B' },
      ],
      meta_lead_whatsapp_queue: [qrow({ form_id: 'form-B', template_name: 'aman_tpl_B', assignee_key: key })],
      message_templates: [approved('aman_tpl_A'), approved('aman_tpl_B')],
      ...baseExtra(),
    });
    const out = await drainWhatsappQueue(db, { sendImpl: sender(calls) });
    expect(out.sent).toBe(1);
    expect(calls[0].templateName).toBe('aman_tpl_B');
  });

  it('stable salesperson keys: user/email/phone resolve identically at save and enqueue time', () => {
    expect(salespersonKeyFor({ user_id: ' u-1 ' })).toBe('user:u-1');
    expect(salespersonKeyFor({ user_id: 'u-1', email: 'OTHER@x.com' })).toBe('user:u-1');
    expect(salespersonKeyFor({ email: 'Asha@Example.COM ' })).toBe('email:asha@example.com');
    expect(salespersonKeyFor({ phone: '+91 98-765 43210' })).toBe('phone:919876543210');
    expect(salespersonKeyFor({})).toBeNull();
  });

  it('enqueue + drain round-trip without global config, in order with delay', async () => {
    const calls: Array<{ templateName: string; contactId: string; params?: unknown }> = [];
    const key = 'user:u-mukesh';
    const { db, data } = makeDb({
      meta_lead_submissions: [sub()],
      meta_lead_assignee_sequences: [{ ...seq(key), id: 'seq-m', delay_seconds: 0 }],
      meta_lead_assignee_sequence_items: [item('seq-m', 'm_one', 0), item('seq-m', 'm_two', 1)],
      message_templates: [approved('m_one'), approved('m_two')],
      ...baseExtra(),
    });
    const enq = await maybeEnqueueAssigneeSequence(db as never, { accountId: 'acct-1', formId: 'form-1', submissionId: 'sub-1', assigneeKey: key });
    expect(enq).toMatchObject({ enqueued: 2, skipped: false });
    const rows = data.meta_lead_whatsapp_queue as Row[];
    expect(rows.every((r) => r.assignee_key === key)).toBe(true);
    const out = await drainWhatsappQueue(db, { sendImpl: sender(calls) });
    expect(out.sent).toBe(2);
    expect(calls.map((c) => c.templateName)).toEqual(['m_one', 'm_two']);
  });

  it('variables resolve from the lead row; missing mappings fail actionably without placeholders', async () => {
    const calls: Array<{ templateName: string; contactId: string; params?: unknown }> = [];
    const key = 'user:u-rohit';
    const { db, data } = makeDb({
      meta_lead_submissions: [sub()],
      meta_lead_assignee_sequences: [seq(key)],
      meta_lead_assignee_sequence_items: [item(`seq-${key}`, 'var_tpl', 0, { variable_mappings: { 'body:1': 'name' } })],
      meta_lead_whatsapp_queue: [qrow({ template_name: 'var_tpl', assignee_key: key })],
      message_templates: [approved('var_tpl', { body_text: 'Hi {{1}}' })],
      ...baseExtra(),
    });
    const ok = await drainWhatsappQueue(db, { sendImpl: sender(calls) });
    expect(ok.sent).toBe(1);
    expect(calls[0].params).toEqual({ body: ['Lead Singh'] });
    // Missing mapping: retryable failure, never a fabricated value.
    const bad = makeDb({
      meta_lead_submissions: [sub()],
      meta_lead_assignee_sequences: [seq(key)],
      meta_lead_assignee_sequence_items: [item(`seq-${key}`, 'var_tpl', 0, { variable_mappings: {} })],
      meta_lead_whatsapp_queue: [qrow({ template_name: 'var_tpl', assignee_key: key })],
      message_templates: [approved('var_tpl', { body_text: 'Hi {{1}}' })],
      ...baseExtra(),
    });
    const calls2: Array<{ templateName: string; contactId: string; params?: unknown }> = [];
    const out2 = await drainWhatsappQueue(bad.db, { sendImpl: sender(calls2) });
    expect(out2).toMatchObject({ sent: 0, failed: 1 });
    expect(calls2).toHaveLength(0);
    expect(String((bad.data.meta_lead_whatsapp_queue[0] as Row).last_error ?? '')).toMatch(/mapping|needs a value/i);
    expect(data).toBeDefined();
  });

  it('global rows still require config; assignee rows are unaffected by the global gate', async () => {
    const calls: Array<{ templateName: string; contactId: string; params?: unknown }> = [];
    const key = 'user:u-aman';
    const { db, data } = makeDb({
      meta_lead_submissions: [sub()],
      meta_lead_assignee_sequences: [seq(key)],
      meta_lead_assignee_sequence_items: [item(`seq-${key}`, 'aman_tpl', 0)],
      meta_lead_whatsapp_queue: [
        qrow({ id: 'q-g', template_name: 'global_tpl', assignee_key: null }),
        qrow({ id: 'q-a', template_name: 'aman_tpl', assignee_key: key }),
      ],
      message_templates: [approved('global_tpl'), approved('aman_tpl')],
      ...baseExtra(),
    });
    const out = await drainWhatsappQueue(db, { sendImpl: sender(calls) });
    // Assignee sends; global parks without its config row.
    expect(calls.map((c) => c.templateName)).toEqual(['aman_tpl']);
    expect(out.sent).toBe(1);
    expect((data.meta_lead_whatsapp_queue as Row[]).find((r) => r.id === 'q-g')!.status).toBe('pending');
  });

  it('paused global config still pauses assignee rows; retries do not duplicate', async () => {
    const calls: Array<{ templateName: string; contactId: string; params?: unknown }> = [];
    const key = 'user:u-aman';
    const ctx = makeDb({
      meta_lead_submissions: [sub()],
      meta_lead_whatsapp_configs: [{ account_id: 'acct-1', form_id: 'form-1', paused: true, delay_seconds: 0 }],
      meta_lead_whatsapp_templates: [{ id: 'gt', account_id: 'acct-1', form_id: 'form-1', template_name: 'g', template_language: 'en_US', position: 0, variable_mappings: {} }],
      meta_lead_assignee_sequences: [seq(key)],
      meta_lead_assignee_sequence_items: [item(`seq-${key}`, 'aman_tpl', 0)],
      meta_lead_whatsapp_queue: [qrow({ template_name: 'aman_tpl', assignee_key: key })],
      message_templates: [approved('aman_tpl')],
      ...baseExtra(),
    });
    const parked = await drainWhatsappQueue(ctx.db, { sendImpl: sender(calls) });
    expect(parked).toMatchObject({ skippedPaused: 1, sent: 0 });
    // Unpause resumes same row; re-drain sends once, re-enqueue dedupes.
    ((ctx.data.meta_lead_whatsapp_configs as Row[])[0] as Row).paused = false;
    const sent = await drainWhatsappQueue(ctx.db, { sendImpl: sender(calls) });
    expect(sent.sent).toBe(1);
    const again = await maybeEnqueueAssigneeSequence(ctx.db as never, { accountId: 'acct-1', formId: 'form-1', submissionId: 'sub-1', assigneeKey: key });
    expect(again).toMatchObject({ enqueued: 0, alreadyQueued: 1, skipped: false });
    expect(calls).toHaveLength(1);
    expect(vi).toBeDefined();
  });
});
