// ============================================================
// Meta Leads Export — column groups + Step-2 selection state.
//
// Step 2 of the export dialog ("Select Columns") groups the actual
// export columns into two fixed sections:
//
//   basic      — "Basic Details & Form Answers" (no group checkbox)
//   management — "Lead Management & Follow-up" (tri-state master)
//
// Group membership derives from the stable column *keys* produced
// by the column builders (columns.ts), never from display labels:
// dynamic Instant Form questions (`answer:*`) and the system
// identity columns are basic; every business/workspace field is
// management. Selection state is a set of column keys, so header
// renames, search filtering, expand/collapse, and Back/Next
// navigation can never disturb it, and the workbook keeps the
// builders' canonical column order regardless of tick order.
// ============================================================

import type { ExportColumn } from './workbook';

export type ExportColumnGroup = 'basic' | 'management';

export interface ExportColumnGroupMeta {
  id: ExportColumnGroup;
  title: string;
  description: string;
}

export const EXPORT_COLUMN_GROUPS: readonly ExportColumnGroupMeta[] = [
  {
    id: 'basic',
    title: 'Basic Details & Form Answers',
    description:
      'Lead basic information and all Instant Form question answers.',
  },
  {
    id: 'management',
    title: 'Lead Management & Follow-up',
    description: 'Assignment, stage, call and follow-up related details.',
  },
] as const;

/**
 * Group one export column by its stable key. Dynamic form-question
 * columns (`answer:*`) and the system identity columns are basic;
 * everything else (business/workspace fields, union columns) is
 * management. Total — unknown keys default to management so a
 * future column is never left ungrouped (and never silently
 * dropped: see resolveSelectedColumns).
 */
export function groupExportColumnKey(key: string): ExportColumnGroup {
  if (
    key === '__row' ||
    key === 'submission_time' ||
    key === 'name' ||
    key === 'phone' ||
    key.startsWith('answer:') ||
    key === 'meta_table' ||
    key === 'source' ||
    key === 'form_answers'
  ) {
    return 'basic';
  }
  return 'management';
}

export interface SelectableExportColumn {
  key: ExportColumn['key'];
  header: ExportColumn['header'];
  group: ExportColumnGroup;
}

export type GroupSelectionState = 'checked' | 'unchecked' | 'indeterminate';

/** Tri-state of one group's master checkbox from the selection set. */
export function groupSelectionState(
  groupKeys: readonly string[],
  selected: ReadonlySet<string>
): GroupSelectionState {
  if (groupKeys.length === 0) return 'unchecked';
  let count = 0;
  for (const k of groupKeys) if (selected.has(k)) count += 1;
  if (count === 0) return 'unchecked';
  if (count === groupKeys.length) return 'checked';
  return 'indeterminate';
}

/** Toggle one column, returning a new set (React-state friendly). */
export function toggleColumnKey(
  selected: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Master-checkbox action: all-selected → clear the group, else select it. */
export function applyGroupMaster(
  selected: ReadonlySet<string>,
  groupKeys: readonly string[]
): Set<string> {
  const next = new Set(selected);
  const allOn = groupKeys.every((k) => next.has(k));
  if (allOn) {
    for (const k of groupKeys) next.delete(k);
  } else {
    for (const k of groupKeys) next.add(k);
  }
  return next;
}

/** Select / clear every available column (ignores any search query). */
export function selectAllColumns(
  columns: readonly SelectableExportColumn[]
): Set<string> {
  return new Set(columns.map((c) => c.key));
}

/** Clear every available column (ignores any search query). */
export function deselectAllColumns(): Set<string> {
  return new Set<string>();
}

/** Case-insensitive substring match on the display header. Never mutates. */
export function filterColumnsByQuery(
  columns: readonly SelectableExportColumn[],
  query: string
): SelectableExportColumn[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...columns];
  return columns.filter((c) => c.header.toLowerCase().includes(q));
}

/**
 * Selected keys in the builders' canonical column order (NOT tick
 * order), deduplicated. The workbook receives exactly this list.
 */
export function orderedSelectedKeys(
  allColumns: readonly SelectableExportColumn[],
  selected: ReadonlySet<string>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of allColumns) {
    if (selected.has(c.key) && !seen.has(c.key)) {
      seen.add(c.key);
      out.push(c.key);
    }
  }
  return out;
}

/** "N of M selected" counts for one group. */
export function groupSelectionCount(
  groupKeys: readonly string[],
  selected: ReadonlySet<string>
): { selected: number; total: number } {
  let count = 0;
  for (const k of groupKeys) if (selected.has(k)) count += 1;
  return { selected: count, total: groupKeys.length };
}
