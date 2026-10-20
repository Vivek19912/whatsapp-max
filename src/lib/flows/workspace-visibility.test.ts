import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowTableColumn } from './flow-tables';
import type { WorkspaceField } from './workspace-fields';
import {
  ROW_VIS_ID,
  applyVisibility,
  customFieldVisId,
  describeVisibilityMenu,
  filterVisibilityMenu,
  flattenVisibilityMenu,
  flowColumnVisId,
  hasStoredVisibility,
  loadHiddenIds,
  saveHiddenIds,
  selectInitialHiddenIds,
  toggleHiddenId,
  visibilityStorageKey,
} from './workspace-visibility';

const FLOW_COLUMNS: FlowTableColumn[] = [
  { key: 'submission_time', label: 'Submission Time', system: true },
  { key: 'name', label: 'Name', system: true },
  { key: 'phone', label: 'Phone Number', system: true },
  { key: 'hotel_category', label: 'Hotel Category', system: false },
  { key: 'travel_month', label: 'Travel Month', system: false },
  { key: 'status', label: 'Status', system: true },
];

function field(id: string, name: string): WorkspaceField {
  return {
    id,
    account_id: 'acct-1',
    flow_id: 'flow-1',
    name,
    field_type: 'text',
    position: 0,
    options: null,
    default_value: null,
    currency_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const CUSTOM_FIELDS = [
  field('f-budget', 'Budget'),
  field('f-status', 'Status'),
];

// localStorage stub (vitest runs in node: no DOM storage by default).
const backing = new Map<string, string>();
function stubStorage(throwOnWrite = false) {
  backing.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (throwOnWrite) throw new Error('quota exceeded');
      backing.set(k, String(v));
    },
    removeItem: (k: string) => {
      backing.delete(k);
    },
  });
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('describeVisibilityMenu', () => {
  it('lists Row, Submission Time, Name, Phone Number — none locked', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(model.core).toEqual([
      { id: ROW_VIS_ID, label: 'Row' },
    ]);
    const ids = [...model.core, ...model.flow].map((i) => i.id);
    for (const key of ['submission_time', 'name', 'phone']) {
      expect(ids).toContain(flowColumnVisId(key));
    }
    // No item anywhere carries a lock.
    for (const item of flattenVisibilityMenu(model)) {
      expect(item).not.toHaveProperty('locked');
    }
  });

  it('lists dynamic flow columns as hideable and never hardcodes them', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(model.flow).toEqual([
      {
        id: flowColumnVisId('submission_time'),
        label: 'Submission Time',
      },
      { id: flowColumnVisId('name'), label: 'Name' },
      { id: flowColumnVisId('phone'), label: 'Phone Number' },
      {
        id: flowColumnVisId('hotel_category'),
        label: 'Hotel Category',
      },
      {
        id: flowColumnVisId('travel_month'),
        label: 'Travel Month',
      },
    ]);
  });

  it('never offers the Status system column (tabs already classify)', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    const ids = [...model.core, ...model.flow].map((i) => i.id);
    expect(ids).not.toContain(flowColumnVisId('status'));
  });

  it('keys custom columns by stable field id (never by name)', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(model.custom).toEqual([
      { id: 'custom:f-budget', label: 'Budget' },
      { id: 'custom:f-status', label: 'Status' },
    ]);
  });

  it('exposes no lead pseudo-column (custom fields only)', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(model).not.toHaveProperty('leadSource');
  });
});

describe('flattenVisibilityMenu (one unified manager list)', () => {
  it('lists every column once, row entry first, order preserved', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    expect(flattenVisibilityMenu(model).map((i) => i.label)).toEqual([
      'Row',
      'Submission Time',
      'Name',
      'Phone Number',
      'Hotel Category',
      'Travel Month',
      'Budget',
      'Status',
    ]);
  });

  it('marks nothing locked — every entry is hideable', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    const items = flattenVisibilityMenu(model);
    expect(items).toHaveLength(8);
    for (const label of ['Row', 'Submission Time', 'Name', 'Phone Number']) {
      expect(items.map((i) => i.label)).toContain(label);
    }
    for (const item of items) {
      expect(item).not.toHaveProperty('locked');
    }
  });

  it('omits a filtered-out Lead Source and nothing else', () => {
    const model = filterVisibilityMenu(
      describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS),
      'lead xyz-no-match'
    );
    // 'lead xyz-no-match' matches nothing: the flattened list is empty
    // but the call must not throw and must stay an array.
    expect(flattenVisibilityMenu(model)).toEqual([]);
    const filtered = filterVisibilityMenu(
      describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS),
      'hotel'
    );
    expect(flattenVisibilityMenu(filtered).map((i) => i.label)).toEqual([
      'Hotel Category',
    ]);
  });
});

describe('applyVisibility', () => {
  it('hides flow and custom columns', () => {
    const applied = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, [
      flowColumnVisId('hotel_category'),
      customFieldVisId('f-budget'),
    ]);
    expect(applied.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'travel_month',
    ]);
    expect(applied.customFields.map((f) => f.id)).toEqual(['f-status']);
  });

  it('hides Row, Submission Time, Name, and Phone Number like any column', () => {
    const applied = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, [
      ROW_VIS_ID,
      flowColumnVisId('submission_time'),
      flowColumnVisId('name'),
      flowColumnVisId('phone'),
    ]);
    expect(applied.flowColumns.map((c) => c.key)).toEqual([
      'hotel_category',
      'travel_month',
    ]);
  });

  it('hides each system column independently', () => {
    for (const key of ['submission_time', 'name', 'phone'] as const) {
      const applied = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, [
        flowColumnVisId(key),
      ]);
      expect(applied.flowColumns.map((c) => c.key)).not.toContain(key);
      // Everything else stays.
      expect(applied.flowColumns).toHaveLength(4);
    }
  });

  it('never reorders: a restored column returns to its original position', () => {
    const hidden = [flowColumnVisId('hotel_category')];
    const narrowed = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, hidden);
    expect(narrowed.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'travel_month',
    ]);
    const restored = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, []);
    expect(restored.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'hotel_category',
      'travel_month',
    ]);
  });

  it('show-all/reset (empty set) restores every hideable column', () => {
    const applied = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, []);
    expect(applied.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'hotel_category',
      'travel_month',
    ]);
    expect(applied.customFields.map((f) => f.id)).toEqual([
      'f-budget',
      'f-status',
    ]);
  });

  it('never deletes or mutates definitions: inputs come back intact', () => {
    const before = JSON.stringify({ FLOW_COLUMNS, CUSTOM_FIELDS });
    applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, [
      flowColumnVisId('hotel_category'),
      customFieldVisId('f-budget'),
    ]);
    expect(JSON.stringify({ FLOW_COLUMNS, CUSTOM_FIELDS })).toBe(before);
    expect(FLOW_COLUMNS).toHaveLength(6);
    expect(CUSTOM_FIELDS).toHaveLength(2);
  });
});

describe('custom columns render after flow columns', () => {
  function flowKeys(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      key: `q${i}`,
      label: `Question ${i}`,
      system: false,
    }));
  }

  /** Render order the table + manager compose: flow, then custom. */
  function renderOrder(
    flowColumns: Array<{ key: string; label: string; system: boolean }>,
    hidden: string[] = []
  ): string[] {
    const applied = applyVisibility(flowColumns, CUSTOM_FIELDS, hidden);
    return [
      ...applied.flowColumns.map((c) => `flow:${c.key}`),
      ...applied.customFields.map((f) => `custom:${f.id}`),
    ];
  }

  it('1. custom entries close the list', () => {
    const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);
    const flat = flattenVisibilityMenu(model).map((i) => i.id);
    expect(flat[flat.length - 1]).toBe(customFieldVisId('f-status'));
  });

  it('2. order holds across flows with different column counts', () => {
    for (const n of [0, 1, 5]) {
      const order = renderOrder(flowKeys(n));
      const customs = CUSTOM_FIELDS.map((f) => customFieldVisId(f.id));
      for (const c of customs) {
        expect(order.slice(-customs.length)).toContain(c);
      }
      for (let i = 0; i < n; i++) {
        expect(order.indexOf(`flow:q${i}`)).toBeLessThan(order.indexOf(customs[0]));
      }
    }
  });

  it('3. hiding/showing preserves flow-then-custom order', () => {
    const cols = flowKeys(3);
    // Hide a middle chunk: custom entries still close the list.
    const order = renderOrder(cols, ['flow:q1', customFieldVisId('f-budget')]);
    expect(order).toEqual([
      'flow:q0',
      'flow:q2',
      'custom:f-status',
    ]);
  });

  it('4. the manager list keeps custom entries last (incl. search)', () => {
    const model = describeVisibilityMenu(flowKeys(3).map((c) => ({
      key: c.key,
      label: c.label,
      system: c.system,
    })), CUSTOM_FIELDS);
    const flat = flattenVisibilityMenu(model).map((i) => i.id);
    expect(flat[flat.length - 1]).toBe(customFieldVisId('f-status'));
    // Search narrows but never reorders.
    const filtered = filterVisibilityMenu(model, 'status');
    const flatFiltered = flattenVisibilityMenu(filtered).map((i) => i.id);
    expect(flatFiltered).toEqual([customFieldVisId('f-status')]);
  });

  it('5. reset/show-all (empty set) restore full order, custom final', () => {
    const order = renderOrder(flowKeys(2), []);
    expect(order[order.length - 1]).toBe(customFieldVisId('f-status'));
    expect(order.slice(0, 2)).toEqual(['flow:q0', 'flow:q1']);
  });
});

describe('toggleHiddenId', () => {  it('adds and removes ids with stable sorted output', () => {
    expect(toggleHiddenId([], 'custom:b')).toEqual(['custom:b']);
    expect(toggleHiddenId(['custom:b'], 'custom:a')).toEqual([
      'custom:a',
      'custom:b',
    ]);
    expect(toggleHiddenId(['custom:a', 'custom:b'], 'custom:a')).toEqual([
      'custom:b',
    ]);
  });
});

describe('filterVisibilityMenu (manager search only)', () => {
  const model = describeVisibilityMenu(FLOW_COLUMNS, CUSTOM_FIELDS);

  it('matches labels case-insensitively across sections', () => {
    const filtered = filterVisibilityMenu(model, 'hotel');
    expect(filtered.flow.map((i) => i.label)).toEqual(['Hotel Category']);
    expect(filtered.core).toEqual([]);
    expect(filtered.custom).toEqual([]);
  });

  it('empty query returns the full model', () => {
    expect(filterVisibilityMenu(model, '  ')).toEqual(model);
  });

  it('no match empties every section without touching rows', () => {
    const filtered = filterVisibilityMenu(model, 'zzz-no-such-column');
    expect(filtered.core).toEqual([]);
    expect(filtered.flow).toEqual([]);
    expect(filtered.custom).toEqual([]);
    // The source model (and therefore the table) is untouched.
    expect(model.flow).toHaveLength(5);
  });

  it('finds custom columns by name', () => {
    const filtered = filterVisibilityMenu(model, 'budget');
    expect(filtered.custom).toEqual([{ id: 'custom:f-budget', label: 'Budget' }]);
  });
});

describe('visibility persistence (localStorage, per account + flow)', () => {
  it('round-trips a hidden set and survives a reload', () => {
    saveHiddenIds('acct-1', 'flow-1', ['custom:f-budget', 'flow:phone']);
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([
      'custom:f-budget',
      'flow:phone',
    ]);
  });

  it('scopes by flow: one flow never affects another', () => {
    saveHiddenIds('acct-1', 'flow-a', ['flow:phone']);
    expect(loadHiddenIds('acct-1', 'flow-b')).toEqual([]);
    expect(loadHiddenIds('acct-1', 'flow-a')).toEqual(['flow:phone']);
  });

  it('scopes by account', () => {
    saveHiddenIds('acct-1', 'flow-1', ['flow:phone']);
    expect(loadHiddenIds('acct-2', 'flow-1')).toEqual([]);
  });

  it('Completed/Incomplete share one configuration (key ignores view)', () => {
    expect(visibilityStorageKey('acct-1', 'flow-1')).toBe(
      'wacrm:ws-cols:v1:acct-1:flow-1'
    );
  });

  it('saving an empty set removes the key (default = all visible)', () => {
    saveHiddenIds('acct-1', 'flow-1', ['flow:phone']);
    expect(backing.has('wacrm:ws-cols:v1:acct-1:flow-1')).toBe(true);
    saveHiddenIds('acct-1', 'flow-1', []);
    expect(backing.has('wacrm:ws-cols:v1:acct-1:flow-1')).toBe(false);
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([]);
  });

  it('corrupt or foreign stored values fall back to all visible', () => {
    backing.set('wacrm:ws-cols:v1:acct-1:flow-1', 'not-json{{{');
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([]);
    backing.set(
      'wacrm:ws-cols:v1:acct-1:flow-1',
      JSON.stringify({ hidden: ['flow:phone'] })
    );
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([]);
    backing.set(
      'wacrm:ws-cols:v1:acct-1:flow-1',
      JSON.stringify(['flow:phone', 42, null])
    );
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual(['flow:phone']);
  });

  it('persists system-column hides and restores them via show-all/reset', () => {
    saveHiddenIds('acct-1', 'flow-1', [
      ROW_VIS_ID,
      flowColumnVisId('name'),
      flowColumnVisId('phone'),
    ]);
    const hidden = loadHiddenIds('acct-1', 'flow-1');
    const applied = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, hidden);
    expect(applied.flowColumns.map((c) => c.key)).not.toContain('name');
    expect(applied.flowColumns.map((c) => c.key)).not.toContain('phone');
    // Reset (empty set) restores everything — nothing is forced.
    const reset = applyVisibility(FLOW_COLUMNS, CUSTOM_FIELDS, []);
    expect(reset.flowColumns.map((c) => c.key)).toEqual([
      'submission_time',
      'name',
      'phone',
      'hotel_category',
      'travel_month',
    ]);
  });

  it('never throws when storage is unavailable (private mode)', () => {
    stubStorage(true);
    expect(() =>
      saveHiddenIds('acct-1', 'flow-1', ['flow:phone'])
    ).not.toThrow();
    vi.unstubAllGlobals();
    expect(loadHiddenIds('acct-1', 'flow-1')).toEqual([]);
  });

  it('distinguishes never-customized scopes from stored sets', () => {
    expect(hasStoredVisibility('acct-1', 'flow-1')).toBe(false);
    saveHiddenIds('acct-1', 'flow-1', ['flow:phone']);
    expect(hasStoredVisibility('acct-1', 'flow-1')).toBe(true);
    // Empty sets remove the key (legacy storage contract), so a
    // reset returns the scope to "no stored preference".
    saveHiddenIds('acct-1', 'flow-1', []);
    expect(hasStoredVisibility('acct-1', 'flow-1')).toBe(false);
  });

  it('selectInitialHiddenIds prefers stored sets and falls back to defaults', () => {
    // No stored preference → caller-supplied defaults apply.
    expect(selectInitialHiddenIds(null, ['flow:full_name'])).toEqual([
      'flow:full_name',
    ]);
    // An explicit stored set always wins — even an empty one, so a
    // deliberate "show all" is never overridden by defaults.
    expect(selectInitialHiddenIds([], ['flow:full_name'])).toEqual([]);
    expect(selectInitialHiddenIds(['flow:phone'], ['flow:full_name'])).toEqual([
      'flow:phone',
    ]);
    // No defaults → legacy behaviour (all visible) everywhere.
    expect(selectInitialHiddenIds(null)).toEqual([]);
  });
});
