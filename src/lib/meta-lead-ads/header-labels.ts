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

import { META_IDENTITY_ANSWER_KEYS } from "./normalize";
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

/**
 * Storage/render lookup key for one flow column. Deliberately defined
 * here (rather than importing flowColumnVisId) so this module stays
 * server-safe for API routes: it must always equal `flow:<key>`,
 * enforced by the parity test below.
 */
export function metaHeaderLabelKey(columnKey: string): string {
  return `flow:${columnKey}`;
}

/**
 * Visibility ids hidden by default on a Meta Lead Ads table:
 * dynamic question columns whose stable key is a standard identity
 * key (full_name, phone_number, …), i.e. duplicates of the system
 * Name / Phone Number columns. The columns stay in the payload and
 * in the Columns menu — this only seeds the default hidden set
 * until the user customizes visibility. Flow Tables always get [].
 */
export function metaDefaultHiddenColumnIds(
  columns: ReadonlyArray<Pick<MetaHeaderColumnRef, "key" | "system">>,
  isMetaTable: boolean,
): string[] {
  if (!isMetaTable) return [];
  return columns
    .filter((c) => !c.system && META_IDENTITY_ANSWER_KEYS.has(c.key))
    .map((c) => metaHeaderLabelKey(c.key));
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
  return storedMetaHeaderLabel(column.key, labels) ?? column.label;
}

/**
 * A stored custom header, or null when none applies. Single lookup
 * behind both resolvers below, so the table header, the table cell
 * tooltip, and the lead-details sidebar can never disagree about
 * which override belongs to which column.
 */
function storedMetaHeaderLabel(
  columnKey: string,
  labels: Readonly<Record<string, string>> | null | undefined,
): string | null {
  const custom = labels?.[metaHeaderLabelKey(columnKey)];
  if (typeof custom === "string" && custom.trim() !== "") return custom;
  return null;
}

/**
 * Final display label for one column in Meta Lead Ads surfaces
 * (table header and lead-details sidebar). A stored custom header
 * renders verbatim; otherwise the original question goes through
 * the caller's display formatting (the workspace
 * `formatColumnLabel`). Flow Tables, system columns, and the fixed
 * Source column always take the formatting path, so their labels
 * render exactly as before.
 *
 * `formatOriginal` is injected (rather than imported) so this
 * module stays server-safe for API routes.
 */
export function resolveMetaHeaderDisplayLabel(args: {
  flowKind: string | null | undefined;
  column: Pick<MetaHeaderColumnRef, "key" | "system" | "label">;
  labels: Readonly<Record<string, string>> | null | undefined;
  formatOriginal: (label: string) => string;
}): string {
  const { flowKind, column, labels, formatOriginal } = args;
  if (flowKind !== "meta_lead_ads") return formatOriginal(column.label);
  if (!isRenamableMetaColumn(column)) return formatOriginal(column.label);
  return storedMetaHeaderLabel(column.key, labels) ?? formatOriginal(column.label);
}
