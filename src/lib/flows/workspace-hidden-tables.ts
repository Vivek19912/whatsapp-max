// ============================================================
// Workspace table hide/restore — pure model (no React, no I/O).
//
// Hiding is visibility-only: it never deletes, disables, or
// modifies any flow, form, lead, or ingestion state. The server
// persists one row per hidden table keyed by the STABLE flow_id
// (never the display name — renames must not orphan a
// preference); these helpers implement the client-side mirror so
// the UI stays consistent.
//
// A hidden table keeps receiving and storing new leads normally
// — the selector simply filters it out until restored.
// ============================================================

/** Flow ids that are currently hidden from the selector. */
export type HiddenTableIds = ReadonlySet<string>;

/**
 * Tables shown in the normal Workspace dropdown: every table
 * whose id is NOT hidden. Pure — the input array is never
 * mutated. Unknown ids in the hidden set never match.
 */
export function visibleWorkspaceTables<T extends { id: string }>(
  tables: readonly T[],
  hiddenIds: HiddenTableIds,
): T[] {
  if (hiddenIds.size === 0) return [...tables];
  return tables.filter((t) => !hiddenIds.has(t.id));
}

/**
 * Selection after the visible set changes (initial load, hide, or
 * restore): keep the current id when it is still visible, else
 * fall back to the first visible table, else null (preserves the
 * existing empty-state behavior). Pure. Never throws, never
 * invents an id.
 */
export function resolveWorkspaceTableAfterVisibility(
  visibleIds: readonly string[],
  selectedId: string | null,
): string | null {
  if (selectedId && visibleIds.includes(selectedId)) return selectedId;
  return visibleIds[0] ?? null;
}

/** Normalize an unknown hidden-ids payload into a clean string set. */
export function cleanHiddenTableIds(value: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") {
      out.add(entry.trim());
    }
  }
  return out;
}
