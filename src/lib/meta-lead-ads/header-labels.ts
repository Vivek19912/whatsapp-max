// ============================================================
// Meta Lead Ads — custom column header names (pure model, no I/O).
//
// Applies ONLY to virtual Meta Lead Ads tables
// (flows.kind = 'meta_lead_ads'). Flow Tables never consult these
// helpers and their rendering path is untouched.
//
// Identity: overrides are keyed by the stable flow column key
// (the answer var_key), expressed as the shared visibility id
// `flow:<key>` — the same identity the visibility, width, and
// header-color systems use. Never by display text: a rename must
// not orphan the override, and restoring must not touch siblings.
// The original question text always stays in flow_nodes config.
// ============================================================

import { META_SOURCE_COLUMN_KEY } from "./virtual-flow";

/** Maximum stored/displayed custom header length. */
export const META_HEADER_LABEL_MAX = 120;

export interface MetaHeaderColumnRef {
  key: string;
  system: boolean;
  label: string;
}

/**
 * Which columns may be renamed: dynamically generated Instant Form
 * question columns only. System columns (Name, Phone Number,
 * Submission Time, Status, …) and the fixed Source column are
 * never eligible.
 */
export function isRenamableMetaColumn(
  column: Pick<MetaHeaderColumnRef, "key" | "system">,
): boolean {
  return !column.system && column.key !== META_SOURCE_COLUMN_KEY;
}

/** Storage/render lookup key for one flow column. */
export function metaHeaderLabelKey(columnKey: string): string {
  return `flow:${columnKey}`;
}

/**
 * Validate + normalize a custom header name. Throws on non-text,
 * empty/whitespace-only, or overlong input — the route maps this
 * to a 400 and the UI blocks empty saves.
 */
export function normalizeHeaderLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Header name must be text.");
  const label = value.trim();
  if (label === "") throw new Error("Header name cannot be empty.");
  if (label.length > META_HEADER_LABEL_MAX) {
    throw new Error(
      `Header name must be ${META_HEADER_LABEL_MAX} characters or fewer.`,
    );
  }
  return label;
}

/**
 * Effective rendered header for one column. A stored custom label
 * wins only on Meta Lead Ads tables for an eligible question
 * column; everything else renders the original label untouched —
 * including every Flow Table, which never passes kind
 * 'meta_lead_ads' here.
 */
export function resolveMetaHeaderLabel(args: {
  flowKind: string | null | undefined;
  column: Pick<MetaHeaderColumnRef, "key" | "system" | "label">;
  labels: Readonly<Record<string, string>> | null | undefined;
}): string {
  const { flowKind, column, labels } = args;
  if (flowKind !== "meta_lead_ads") return column.label;
  if (!isRenamableMetaColumn(column)) return column.label;
  const custom = labels?.[metaHeaderLabelKey(column.key)];
  if (typeof custom === "string" && custom.trim() !== "") return custom;
  return column.label;
}
