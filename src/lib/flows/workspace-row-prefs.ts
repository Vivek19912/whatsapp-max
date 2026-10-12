// ============================================================
// Workspace row pin/hide — pure model (no React, no I/O).
//
// Pin and hide are PER USER per flow (see migration 117): the
// server persists them in `workspace_row_prefs` keyed by the
// STABLE row identity (`flow_runs.id`, exposed as runId) — never
// an array index, display position, or lead name — and the table
// RPC excludes hidden rows and sorts pinned rows first for the
// calling user. These helpers implement the client-side mirror of
// those rules so the UI stays consistent (and degrades gracefully
// when the server already applied them — both operations below
// are no-ops on server-ordered input):
//   - hidden rows are filtered out of the rendered list;
//   - pinned rows partition stably to the top, preserving the
//     server's relative order within each group.
//
// Hiding is visibility-only: it never deletes, archives,
// completes, or modifies any lead or flow-run record. Pinning
// never changes lead data, statuses, or completion state.
// ============================================================

/** One row preference as returned by GET /api/flows/[id]/row-prefs. */
export interface WorkspaceRowPref {
  flow_run_id: string;
  is_pinned: boolean;
  is_hidden: boolean;
}

/** A hidden row listed in the "Show hidden rows" panel. */
export interface HiddenRowInfo {
  /** Stable row identity (`flow_runs.id`). */
  flow_run_id: string;
  name: string | null;
  phone: string | null;
}

/**
 * Display label identifying a hidden row (lead name and/or phone).
 * Falls back to "Lead" when neither is known — never leaks ids.
 */
export function hiddenRowLabel(info: HiddenRowInfo): string {
  const name = info.name?.trim() ? info.name.trim() : null;
  const phone = info.phone?.trim() ? info.phone.trim() : null;
  if (name && phone) return `${name} · ${phone}`;
  return name ?? phone ?? "Lead";
}

/**
 * Partition rows into pinned-first order: pinned rows (in their
 * incoming relative order) before every other row (in its incoming
 * relative order). Stable and pure — the input array is never
 * mutated, unknown ids never match, and already-ordered input is
 * returned unchanged in content (a new array either way).
 */
export function orderPinnedFirst<T extends { runId: string }>(
  rows: readonly T[],
  pinnedIds: ReadonlySet<string>,
): T[] {
  if (pinnedIds.size === 0) return [...rows];
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    if (pinnedIds.has(row.runId)) pinned.push(row);
    else rest.push(row);
  }
  return [...pinned, ...rest];
}

/**
 * Remove hidden rows from the rendered list. Pure: the input array
 * is never mutated. An empty hidden set returns a copy unchanged.
 */
export function excludeHiddenRows<T extends { runId: string }>(
  rows: readonly T[],
  hiddenIds: ReadonlySet<string>,
): T[] {
  if (hiddenIds.size === 0) return [...rows];
  return rows.filter((row) => !hiddenIds.has(row.runId));
}

/**
 * Visible table rows for the current prefs: hidden rows removed,
 * pinned rows first (stable). Combines the two rules above in the
 * order the server applies them (filter, then pin-partition).
 */
export function visibleWorkspaceRows<T extends { runId: string }>(
  rows: readonly T[],
  pinnedIds: ReadonlySet<string>,
  hiddenIds: ReadonlySet<string>,
): T[] {
  return orderPinnedFirst(excludeHiddenRows(rows, hiddenIds), pinnedIds);
}
