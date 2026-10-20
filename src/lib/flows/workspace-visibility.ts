// ============================================================
// Workspace column visibility — presentation-layer only.
//
// Hiding a column NEVER deletes data, definitions, or values: it
// only filters what the table renders. Order is always derived
// from the payload, so restoring a column returns it to its
// original position (never appended).
//
// Identity (never display names):
//   flow answer column → `flow:<column.key>` (stable var/node key)
//   custom field       → `custom:<field.id>` (stable UUID)
//   row number         → `core:row` (constant)
//
// Nothing is locked: EVERY column — Row, Submission Time, Name,
// Phone Number included — is hideable exactly like the rest. The
// `status` system column is excluded from the table AND the
// menu by design (the Completed/Incomplete tabs already
// communicate classification).
//
// Persistence is localStorage, scoped `account:flow` — Completed
// and Incomplete deliberately share one configuration per flow,
// and one flow's state can never leak into another's. No API, no
// migration, no effect on Google Sheets (which never reads this).
// ============================================================

import { useCallback, useMemo, useState } from 'react';

import type { FlowTableColumn } from './flow-tables';
import type { WorkspaceField } from './workspace-fields';

export const ROW_VIS_ID = 'core:row';

/**
 * Display-excluded regardless of visibility state. The Status
 * column stays in the payload (drawer badges, types, API) but is
 * not a table column and is not offered in the menu.
 */
const DISPLAY_EXCLUDED_COLUMN_KEYS: ReadonlySet<string> = new Set(['status']);

export function flowColumnVisId(key: string): string {
  return `flow:${key}`;
}

export function customFieldVisId(id: string): string {
  return `custom:${id}`;
}

export interface VisibilityMenuItem {
  /** Stable visibility id (see above). */
  id: string;
  label: string;
}

export interface VisibilityMenuModel {
  /** Row-number entry, first in the manager (hideable like the rest). */
  core: VisibilityMenuItem[];
  /** Hideable flow answer columns (dynamic per flow, never hardcoded). */
  flow: VisibilityMenuItem[];
  /** Hideable custom Workspace columns (incl. business columns). */
  custom: VisibilityMenuItem[];
}

/**
 * Build the menu model from the live payload. Pure view over the
 * given columns/fields — never mutates, never reorders.
 */
export function describeVisibilityMenu(
  flowColumns: FlowTableColumn[],
  customFields: WorkspaceField[]
): VisibilityMenuModel {
  const core: VisibilityMenuItem[] = [
    { id: ROW_VIS_ID, label: 'Row' },
  ];
  const flow: VisibilityMenuItem[] = [];
  for (const c of flowColumns) {
    if (DISPLAY_EXCLUDED_COLUMN_KEYS.has(c.key)) continue;
    flow.push({ id: flowColumnVisId(c.key), label: c.label });
  }
  return {
    core,
    flow,
    custom: customFields.map((f) => ({
      id: customFieldVisId(f.id),
      label: f.name,
    })),
  };
}

/**
 * Flatten a (possibly search-filtered) menu model into ONE unified
 * column list for the manager: row-number entry first, then flow
 * columns, then custom columns. Order is preserved.
 * The manager renders no section groupings — one clean
 * list with search + checkboxes. Nothing is locked: every entry
 * is hideable.
 */
export function flattenVisibilityMenu(
  model: VisibilityMenuModel,
): VisibilityMenuItem[] {
  return [...model.core, ...model.flow, ...model.custom];
}

/**
 * Filter a menu model by the manager search query (case-insensitive
 * substring on labels). Filters the manager list ONLY — table rows
 * are never touched.
 */
export function filterVisibilityMenu(
  model: VisibilityMenuModel,
  query: string
): VisibilityMenuModel {
  const q = query.trim().toLowerCase();
  if (!q) return model;
  const match = (item: VisibilityMenuItem) =>
    item.label.toLowerCase().includes(q);
  return {
    core: model.core.filter(match),
    flow: model.flow.filter(match),
    custom: model.custom.filter(match),
  };
}

export interface AppliedVisibility {
  /** Flow columns to render (status excluded, order preserved). */
  flowColumns: FlowTableColumn[];
  /** Custom fields to render (order preserved). */
  customFields: WorkspaceField[];
}

/**
 * Apply a hidden-id set to the live payload. Pure filter — input
 * arrays are never mutated and order is never changed, so an
 * unhidden column automatically returns to its original position.
 * Every column is hideable, including Row, Submission Time, Name,
 * and Phone Number: a hidden id always wins, with no locked
 * exceptions.
 */
export function applyVisibility(
  flowColumns: FlowTableColumn[],
  customFields: WorkspaceField[],
  hiddenIds: readonly string[]
): AppliedVisibility {
  const hidden = new Set(hiddenIds);
  return {
    flowColumns: flowColumns.filter(
      (c) =>
        !DISPLAY_EXCLUDED_COLUMN_KEYS.has(c.key) &&
        !hidden.has(flowColumnVisId(c.key))
    ),
    customFields: customFields.filter(
      (f) => !hidden.has(customFieldVisId(f.id))
    ),
  };
}

/** Toggle one id in a hidden set. Pure; output sorted for stable storage. */
export function toggleHiddenId(
  hiddenIds: readonly string[],
  id: string
): string[] {
  const next = new Set(hiddenIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return [...next].sort();
}

// ------------------------------------------------------------
// Persistence (localStorage, per account + flow).
// ------------------------------------------------------------

const STORAGE_PREFIX = 'wacrm:ws-cols:v1';

export function visibilityStorageKey(
  accountId: string,
  flowId: string
): string {
  return `${STORAGE_PREFIX}:${accountId}:${flowId}`;
}

function storage(): Storage | null {
  try {
    // `typeof` guard: SSR prerender and bare-node have no localStorage.
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * True when this scope has a stored preference (even an explicitly
 * empty one). Lets callers distinguish "never customized" from
 * "user chose show-all" when applying per-table default hides.
 */
export function hasStoredVisibility(accountId: string, flowId: string): boolean {
  try {
    const store = storage();
    if (!store) return false;
    return store.getItem(visibilityStorageKey(accountId, flowId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Pure default resolution (no storage access): an explicit stored set
 * — including an explicitly empty one — always wins; defaults apply
 * only when there is no stored preference (null).
 */
export function selectInitialHiddenIds(
  stored: readonly string[] | null,
  defaults: readonly string[] = [],
): string[] {
  if (stored !== null) return [...stored];
  return [...defaults].sort();
}

/** Hidden ids for this scope. Corrupt/foreign values → default (all visible). */
export function loadHiddenIds(accountId: string, flowId: string): string[] {
  try {
    const raw = storage()?.getItem(visibilityStorageKey(accountId, flowId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').sort();
  } catch {
    return [];
  }
}

/**
 * Persist a hidden set. Empty sets remove the key (default state =
 * key absent). Never throws — private-mode quota errors degrade to
 * session-only visibility.
 */
export function saveHiddenIds(
  accountId: string,
  flowId: string,
  hiddenIds: readonly string[]
): void {
  try {
    const store = storage();
    if (!store) return;
    const key = visibilityStorageKey(accountId, flowId);
    if (hiddenIds.length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify([...hiddenIds].sort()));
  } catch {
    // Session-only fallback: state still lives in React.
  }
}

export interface WorkspaceVisibility {
  /** Currently hidden visibility ids for the active scope. */
  hiddenIds: string[];
  toggle: (id: string) => void;
  /** Make every column visible, Row included. */
  showAll: () => void;
  /** Restore the default configuration (all visible; definitions/data intact). */
  reset: () => void;
}

/**
 * Effect-free visibility state for the Workspace page. The active
 * scope derives from (accountId, flowId) every render, so switching
 * flows, views, pages, or searches never needs a synchronizing
 * effect — each scope simply reads its own stored set, with
 * in-session overrides layered on top.
 *
 * `defaultHiddenIds` is an opt-in per-table default applied ONLY
 * when the scope has no stored preference yet (first visit, or
 * after a reset cleared storage). Once the user customizes
 * visibility (or explicitly shows everything), the stored set
 * wins and defaults never re-apply. Defaults to [] so existing
 * callers (all Flow Tables) behave exactly as before.
 */
export function useWorkspaceVisibility(
  accountId: string | null,
  flowId: string | null,
  defaultHiddenIds: readonly string[] = []
): WorkspaceVisibility {
  const [overrides, setOverrides] = useState<Record<string, string[]>>({});
  const scoped = accountId !== null && flowId !== null;
  const scopeKey = scoped ? visibilityStorageKey(accountId, flowId) : null;
  const hiddenIds = useMemo(() => {
    if (scopeKey === null || accountId === null || flowId === null) return [];
    const stored = overrides[scopeKey] ?? (hasStoredVisibility(accountId, flowId)
      ? loadHiddenIds(accountId, flowId)
      : null);
    return selectInitialHiddenIds(stored, defaultHiddenIds);
  }, [scopeKey, accountId, flowId, overrides, defaultHiddenIds]);

  const commit = useCallback(
    (next: string[]) => {
      if (
        !scoped ||
        accountId === null ||
        flowId === null ||
        scopeKey === null
      ) {
        return;
      }
      saveHiddenIds(accountId, flowId, next);
      setOverrides((prev) => ({ ...prev, [scopeKey]: next }));
    },
    [scoped, accountId, flowId, scopeKey]
  );

  const toggle = useCallback(
    (id: string) => {
      commit(toggleHiddenId(hiddenIds, id));
    },
    [commit, hiddenIds]
  );

  const showAll = useCallback(() => {
    commit([]);
  }, [commit]);

  const reset = useCallback(() => {
    commit([]);
  }, [commit]);

  return { hiddenIds, toggle, showAll, reset };
}
