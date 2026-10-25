// Regression: WhatsApp auto-send resolution refuses Flow Tables.
//
// resolveTableForm (the same gate the auto-send config/retry APIs
// use) must return null for `whatsapp_flow` flows, so no auto-send
// setting, pause, enqueue, or drain can ever attach to — or change
// — a Flow Table. Meta tables keep resolving.

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';

type Row = Record<string, unknown>;

function makeDb(flows: Row[], forms: Row[]) {
  const data: Record<string, Row[]> = { flows, meta_lead_forms: forms };
  function builder(table: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    const b: Record<string, (...args: never[]) => unknown> = {
      select: (() => b) as never,
      eq: ((col: string, val: unknown) => {
        filters.push({ col, val });
        return b;
      }) as never,
      maybeSingle: (async () => {
        const rows = (data[table] ?? []).filter((r) =>
          filters.every((f) => r[f.col] === f.val)
        );
        return { data: rows[0] ?? null, error: null };
      }) as never,
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const META_FLOW = {
  id: 'flow-meta',
  account_id: 'acct-1',
  name: 'Singapore',
  kind: 'meta_lead_ads',
  meta_form_id: 'form-db-1',
};
const FLOW_TABLE = {
  id: 'flow-wa',
  account_id: 'acct-1',
  name: 'Nurture',
  kind: 'whatsapp_flow',
  meta_form_id: null,
};
const FORM = {
  id: 'form-db-1',
  account_id: 'acct-1',
  form_id: 'meta-form-1',
  form_name: 'Singapore Form',
  enabled: true,
};

describe('Flow Tables are unaffected by WhatsApp auto-send', () => {
  it('resolves Meta tables to their form', async () => {
    const db = makeDb([META_FLOW], [FORM]);
    const table = await resolveTableForm(db, 'acct-1', 'flow-meta');
    expect(table?.formId).toBe('meta-form-1');
  });

  it('refuses conversational (Flow Table) flows with the same 404 as unknown tables', async () => {
    const db = makeDb([FLOW_TABLE], [FORM]);
    expect(await resolveTableForm(db, 'acct-1', 'flow-wa')).toBeNull();
  });

  it('refuses unknown tables and other accounts’ tables', async () => {
    const db = makeDb([META_FLOW], [FORM]);
    expect(await resolveTableForm(db, 'acct-1', 'nope')).toBeNull();
    // META_FLOW belongs to a different account in this fixture's
    // eyes: the account filter never matches.
    const other = makeDb(
      [{ ...META_FLOW, account_id: 'acct-2' }],
      [{ ...FORM, account_id: 'acct-2' }]
    );
    expect(await resolveTableForm(other, 'acct-1', 'flow-meta')).toBeNull();
  });
});
