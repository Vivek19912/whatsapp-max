import { describe, expect, it } from 'vitest';

import {
  applyGroupMaster,
  deselectAllColumns,
  filterColumnsByQuery,
  groupExportColumnKey,
  groupSelectionState,
  orderedSelectedKeys,
  selectAllColumns,
  toggleColumnKey,
  type SelectableExportColumn,
} from './column-selection';

const COLUMNS: SelectableExportColumn[] = [
  { key: '__row', header: 'No.', group: 'basic' },
  { key: 'submission_time', header: 'Submission Time', group: 'basic' },
  { key: 'name', header: 'Name', group: 'basic' },
  { key: 'phone', header: 'Phone Number', group: 'basic' },
  { key: 'answer:city', header: 'City', group: 'basic' },
  { key: 'answer:trip_date', header: 'Trip Date', group: 'basic' },
  { key: 'assigned_to', header: 'Assigned To', group: 'management' },
  { key: 'stage', header: 'Stage', group: 'management' },
];

const basicKeys = COLUMNS.filter((c) => c.group === 'basic').map((c) => c.key);
const mgmtKeys = COLUMNS.filter((c) => c.group === 'management').map(
  (c) => c.key
);

describe('groupExportColumnKey', () => {
  it('routes identity + question columns to basic, business fields to management', () => {
    for (const k of [
      '__row',
      'submission_time',
      'name',
      'phone',
      'answer:city',
      'meta_table',
      'source',
      'form_answers',
    ]) {
      expect(groupExportColumnKey(k)).toBe('basic');
    }
    for (const k of [
      'assigned_to',
      'lead_type',
      'stage',
      'call_status',
      'follow_up',
      'field:abc',
      'union:xyz',
    ]) {
      expect(groupExportColumnKey(k)).toBe('management');
    }
  });

  it('never leaves an unknown key ungrouped', () => {
    expect(groupExportColumnKey('something-brand-new')).toBe('management');
    expect(groupExportColumnKey('')).toBe('management');
  });
});

describe('column selection state (key-based, order-independent)', () => {
  it('toggles one column without touching the others', () => {
    const start = new Set(['name']);
    const added = toggleColumnKey(start, 'phone');
    expect([...added].sort()).toEqual(['name', 'phone']);
    // Input set is never mutated.
    expect(start.has('phone')).toBe(false);
    expect([...toggleColumnKey(added, 'name')]).toEqual(['phone']);
  });

  it('reports group tri-state: unchecked, checked, indeterminate', () => {
    expect(groupSelectionState(mgmtKeys, new Set())).toBe('unchecked');
    expect(groupSelectionState([], new Set(['a']))).toBe('unchecked');
    expect(groupSelectionState(mgmtKeys, new Set(mgmtKeys))).toBe('checked');
    expect(groupSelectionState(mgmtKeys, new Set([mgmtKeys[0]]))).toBe(
      'indeterminate'
    );
  });

  it('master checkbox selects all when partial, clears when all set', () => {
    const partial = new Set([mgmtKeys[0]]);
    expect([...applyGroupMaster(partial, mgmtKeys)].sort()).toEqual(
      [...mgmtKeys].sort()
    );
    // Clearing one group leaves the other group untouched.
    const mixed = new Set([...basicKeys, ...mgmtKeys]);
    const cleared = applyGroupMaster(mixed, mgmtKeys);
    expect([...cleared].sort()).toEqual([...basicKeys].sort());
    // Empty group is a no-op, never throws.
    expect(applyGroupMaster(new Set(['a']), [])).toEqual(new Set(['a']));
  });

  it('select all / deselect all cover every column regardless of search', () => {
    expect(selectAllColumns(COLUMNS).size).toBe(COLUMNS.length);
    expect(deselectAllColumns().size).toBe(0);
    const filtered = filterColumnsByQuery(COLUMNS, 'stage');
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(COLUMNS.length);
  });
});

describe('column search', () => {
  it('matches headers case-insensitively, including dynamic questions', () => {
    expect(filterColumnsByQuery(COLUMNS, 'STAGE').map((c) => c.key)).toEqual([
      'stage',
    ]);
    expect(
      filterColumnsByQuery(COLUMNS, 'trip date').map((c) => c.key)
    ).toEqual(['answer:trip_date']);
    // Empty query returns everything (new array, same order).
    const all = filterColumnsByQuery(COLUMNS, '   ');
    expect(all.map((c) => c.key)).toEqual(COLUMNS.map((c) => c.key));
    expect(all).not.toBe(COLUMNS);
    expect(filterColumnsByQuery(COLUMNS, 'zzz-no-match')).toEqual([]);
  });

  it('preserves group membership of matches', () => {
    const hits = filterColumnsByQuery(COLUMNS, 'phone');
    expect(hits.map((c) => c.key)).toEqual(['phone']);
    expect(hits[0].group).toBe('basic');
  });
});

describe('orderedSelectedKeys', () => {
  it('follows canonical column order, never tick order, without duplicates', () => {
    // Tick order: stage first, then name — output stays canonical.
    const selected = new Set(['stage', 'name', 'stage', '__row']);
    expect(orderedSelectedKeys(COLUMNS, selected)).toEqual([
      '__row',
      'name',
      'stage',
    ]);
  });

  it('drops keys absent from the canonical list', () => {
    expect(orderedSelectedKeys(COLUMNS, new Set(['name', 'meta_ad']))).toEqual([
      'name',
    ]);
    expect(orderedSelectedKeys([], new Set(['name']))).toEqual([]);
  });
});
