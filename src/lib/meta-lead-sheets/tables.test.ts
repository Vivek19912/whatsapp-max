// Meta Sheets table resolution + tab selection — pure unit tests
// (resolveTableForm uses a minimal stub Supabase client).
//
// Verifies: a table resolves to its form only for Meta Lead Ads
// tables owned by the account; Flow Tables, foreign accounts, and
// dangling links resolve to null. Worksheet choice prefers the
// explicit pick, then the saved tab, then the first existing tab,
// and never silently substitutes another tab.

import { describe, expect, it } from 'vitest';

import { chooseWorksheetTab, resolveTableForm } from './tables';

type Row = Record<string, unknown>;

function stubDb(tables: Record<string, Row[]>) {
  return {
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return builder;
        },
        maybeSingle: async () => {
          const rows = (tables[table] ?? []).filter((r) =>
            filters.every(([c, v]) => r[c as string] === v)
          );
          return { data: rows[0] ?? null, error: null };
        },
      };
      return builder;
    },
  } as never;
}

const FLOW = {
  id: 'flow-1',
  name: 'Singapore Lead Ad',
  kind: 'meta_lead_ads',
  account_id: 'acct-1',
  meta_form_id: 'mf-1',
};
const FORM = {
  id: 'mf-1',
  account_id: 'acct-1',
  form_id: 'form-sg',
  form_name: 'Singapore Lead Ad',
  enabled: true,
};

describe('resolveTableForm', () => {
  it('resolves a Meta table to its stable form id', async () => {
    const db = stubDb({ flows: [FLOW], meta_lead_forms: [FORM] });
    await expect(resolveTableForm(db, 'acct-1', 'flow-1')).resolves.toEqual({
      flowId: 'flow-1',
      flowName: 'Singapore Lead Ad',
      formDbId: 'mf-1',
      formId: 'form-sg',
      formName: 'Singapore Lead Ad',
      formEnabled: true,
    });
  });

  it('rejects Flow Tables outright (same as unknown)', async () => {
    const db = stubDb({
      flows: [{ ...FLOW, kind: 'whatsapp_flow' }],
      meta_lead_forms: [FORM],
    });
    await expect(resolveTableForm(db, 'acct-1', 'flow-1')).resolves.toBeNull();
  });

  it("rejects other accounts' tables and unknown flows", async () => {
    const db = stubDb({ flows: [FLOW], meta_lead_forms: [FORM] });
    await expect(resolveTableForm(db, 'acct-2', 'flow-1')).resolves.toBeNull();
    await expect(resolveTableForm(db, 'acct-1', 'nope')).resolves.toBeNull();
  });

  it('rejects tables whose form row is gone or belongs elsewhere', async () => {
    const dbGone = stubDb({ flows: [FLOW], meta_lead_forms: [] });
    await expect(
      resolveTableForm(dbGone, 'acct-1', 'flow-1')
    ).resolves.toBeNull();

    const dbForeign = stubDb({
      flows: [FLOW],
      meta_lead_forms: [{ ...FORM, account_id: 'acct-2' }],
    });
    await expect(
      resolveTableForm(dbForeign, 'acct-1', 'flow-1')
    ).resolves.toBeNull();
  });

  it('rejects tables with no linked form', async () => {
    const db = stubDb({
      flows: [{ ...FLOW, meta_form_id: null }],
      meta_lead_forms: [FORM],
    });
    await expect(resolveTableForm(db, 'acct-1', 'flow-1')).resolves.toBeNull();
  });

  it('propagates database errors instead of misrouting', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                throw new Error('db down');
              },
            }),
          }),
        }),
      }),
    } as never;
    await expect(resolveTableForm(db, 'acct-1', 'flow-1')).rejects.toThrow(
      'db down'
    );
  });
});

describe('chooseWorksheetTab', () => {
  it('defaults to the first existing (leftmost) tab', () => {
    expect(
      chooseWorksheetTab({
        requestedTab: null,
        savedTab: null,
        availableTabs: ['Sheet1', 'Leads', 'Archive'],
        createTab: false,
      })
    ).toEqual({ ok: true, tab: 'Sheet1', needsCreate: false });
  });

  it('prefers an explicit pick, then the saved tab', () => {
    expect(
      chooseWorksheetTab({
        requestedTab: 'Leads',
        savedTab: 'Sheet1',
        availableTabs: ['Sheet1', 'Leads'],
        createTab: false,
      })
    ).toEqual({ ok: true, tab: 'Leads', needsCreate: false });
    expect(
      chooseWorksheetTab({
        requestedTab: null,
        savedTab: 'Leads',
        availableTabs: ['Sheet1', 'Leads'],
        createTab: false,
      })
    ).toEqual({ ok: true, tab: 'Leads', needsCreate: false });
  });

  it('refuses a renamed/deleted tab with the available tabs listed', () => {
    const result = chooseWorksheetTab({
      requestedTab: null,
      savedTab: 'Gone',
      availableTabs: ['Sheet1', 'Leads'],
      createTab: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.availableTabs).toEqual(['Sheet1', 'Leads']);
      expect(result.error).toMatch(/was not found/);
    }
  });

  it('errors explicitly when the spreadsheet has no usable tab', () => {
    const result = chooseWorksheetTab({
      requestedTab: null,
      savedTab: null,
      availableTabs: [],
      createTab: false,
    });
    expect(result).toMatchObject({ ok: false, availableTabs: [] });
  });

  it('creates only when explicitly requested', () => {
    expect(
      chooseWorksheetTab({
        requestedTab: 'New Tab',
        savedTab: null,
        availableTabs: ['Sheet1'],
        createTab: true,
      })
    ).toEqual({ ok: true, tab: 'New Tab', needsCreate: true });
    expect(
      chooseWorksheetTab({
        requestedTab: 'New Tab',
        savedTab: null,
        availableTabs: ['Sheet1'],
        createTab: false,
      }).ok
    ).toBe(false);
  });
});
