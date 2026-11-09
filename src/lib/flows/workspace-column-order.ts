// ============================================================
// Workspace column order — one shared stable-ID model for header
// AND body rendering.
//
// Previously the header row and body rows iterated three parallel
// arrays (flow columns, business columns, result numbers) with
// separately maintained positional paint math, so any reorder
// could silently misalign paint from values. This module is the
// single source of truth: one canonical ordered id list drives
// both loops; every column resolves by stable id (never by array
// index, label, or screen position).
//
// Stable order identities (presentation-order independent):
//   row actions  → `core:actions` (structural, leading, pinned)
//   No.          → `core:row` (ROW_VIS_ID, reused)
//   flow column  → flowColumnRenderKey(c) (`sys:<key>|flow:<key>`)
//   custom field → customFieldVisId(f.id) (`custom:<uuid>`)
// Saved preferences holding retired ids (e.g. the removed
// sequential `followup-result:N` columns) are safely ignored by
// mergeColumnOrder: unknown ids drop, the rest of the saved
// arrangement is preserved — preferences are never reset.
// Dial helpers are attached to their phone entry (never
// independent order entries): moving Phone moves Dial with it.
// `dialOrderId()` derives their stable React keys + test identity.
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import { flowColumnRenderKey, type FlowTableColumn } from './flow-tables';
import type { WorkspaceField } from './workspace-fields';
import { ROW_VIS_ID } from './workspace-visibility';

/** Structural leading column (writers only). Never draggable. */
export const ACTIONS_ORDER_ID = 'core:actions';

/** Order id for a flow column (stable, unique per render key). */
export function flowOrderId(column: Pick<FlowTableColumn, 'key' | 'system'>): string {
  return flowColumnRenderKey(column);
}

/**
 * Stable Dial helper identifier, derived from its Phone column's
 * order id. Used as the Dial cells' React keys (so a Dial never
 * shares identity with data) and in tests pinning the attachment
 * rule. Dials never appear in saved orders — they re-attach to
 * their phone on every merge.
 */
export function dialOrderId(phoneOrderId: string): string {
  return `dial:${phoneOrderId}`;
}

export function isDialOrderId(id: string): boolean {
  return id.startsWith('dial:');
}

/**
 * One column in the canonical display order. Discriminated union
 * so render branches narrow without assertions: headers and body
 * cells resolve everything — paint, widths, values — from the
 * stable id. `paintIndex` is the position in the header-paint
 * sequence (actions consume none; Dial cells paint from hardcoded
 * geometry).
 */
export type ColumnOrderEntry =
  | { id: string; kind: 'actions'; paintIndex: null }
  | { id: string; kind: 'row'; paintIndex: number }
  | {
      id: string;
      kind: 'flow';
      col: FlowTableColumn;
      dialAfter: boolean;
      paintIndex: number;
    }
  | { id: string; kind: 'custom'; field: WorkspaceField; paintIndex: number };

/**
 * Canonical DEFAULT order (today's exact sequence): actions, No.,
 * flow columns in payload order, then business columns.
 * Inputs are FULL (visibility-independent) lists so
 * hiding/unhiding never moves a column's default slot.
 */
export function buildDefaultOrderIds(args: {
  includeActions: boolean;
  includeRow: boolean;
  flowColumns: FlowTableColumn[];
  /** Business-ordered custom visIds (FULL list, hidden included). */
  customIds: string[];
}): string[] {
  const ids: string[] = [];
  if (args.includeActions) ids.push(ACTIONS_ORDER_ID);
  if (args.includeRow) ids.push(ROW_VIS_ID);
  for (const c of args.flowColumns) ids.push(flowOrderId(c));
  ids.push(...args.customIds);
  return ids;
}

/**
 * Merge a saved order onto the default: keep the saved relative
 * order of known ids, drop unknown/stale ids (and any stray dial
 * ids — those re-derive), append newly available ids in default
 * order, and force pinned ids first. Pure — safe to unit test.
 */
export function mergeColumnOrder(args: {
  defaultIds: string[];
  savedIds: string[] | null;
  pinnedIds: string[];
}): string[] {
  const available = new Set(args.defaultIds);
  const clean = (args.savedIds ?? []).filter(
    (id) => available.has(id) && !isDialOrderId(id)
  );
  const cleanSet = new Set(clean);
  const pinned = args.pinnedIds.filter((id) => available.has(id));
  const pinnedSet = new Set(pinned);
  const rest = clean.filter((id) => !pinnedSet.has(id));
  const fresh = args.defaultIds.filter(
    (id) => !cleanSet.has(id) && !pinnedSet.has(id)
  );
  return [...pinned, ...rest, ...fresh];
}

/**
 * Validate a server/client order payload: array of non-empty
 * strings within sane bounds, else null (caller falls back to
 * default). Never throws.
 */
export function normalizeSavedOrder(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > 500) return null;
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    if (id === '' || id.length > 120) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface WorkspaceColumnOrder {
  /** Last persisted order (null = default, never customized). */
  savedOrder: string[] | null;
  /** True once the initial fetch has settled (renders default meanwhile). */
  loaded: boolean;
  /** Persist a complete order (optimistic + rollback on failure). */
  saveOrder: (ids: string[]) => Promise<void>;
  /** Clear the preference (back to default, persisted). */
  resetOrder: () => Promise<void>;
}

/**
 * Per-user, per-table column order, following the widths/colors
 * fetch + optimistic-commit conventions. GET is member-readable;
 * PUT/DELETE are agent+ server-side. The table re-renders from the
 * merged order immediately; a failed save rolls back to the
 * previous saved value (the caller toasts).
 */
export function useWorkspaceColumnOrder(
  accountId: string | null,
  flowId: string | null
): WorkspaceColumnOrder {
  const [savedOrder, setSavedOrder] = useState<string[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (accountId === null || flowId === null) {
      setSavedOrder(null);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    fetch(`/api/flows/${flowId}/column-orders`, { cache: 'no-store' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          ordered_ids?: unknown;
        } | null;
        if (cancelled) return;
        setSavedOrder(normalizeSavedOrder(json?.ordered_ids ?? null));
      })
      .catch(() => {
        // Best-effort: default order on any failure.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, flowId]);

  const saveOrder = useCallback(
    async (ids: string[]) => {
      if (accountId === null || flowId === null) return;
      const previous = savedOrder;
      setSavedOrder(ids);
      try {
        const res = await fetch(`/api/flows/${flowId}/column-orders`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ordered_ids: ids }),
        });
        if (!res.ok) throw new Error('save failed');
      } catch (err) {
        setSavedOrder(previous);
        throw err;
      }
    },
    [accountId, flowId, savedOrder]
  );

  const resetOrder = useCallback(async () => {
    if (accountId === null || flowId === null) {
      setSavedOrder(null);
      return;
    }
    const previous = savedOrder;
    setSavedOrder(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/column-orders`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('reset failed');
    } catch (err) {
      setSavedOrder(previous);
      throw err;
    }
  }, [accountId, flowId, savedOrder]);

  return { savedOrder, loaded, saveOrder, resetOrder };
}
