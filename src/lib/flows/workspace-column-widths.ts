// ============================================================
// Workspace column widths — pure model (no React, no I/O).
//
// Users drag header boundaries (Sheets-style); widths persist
// server-side in `workspace_column_widths` keyed by the STABLE
// visibility id (`core:row`, `flow:<key>`, `custom:<uuid>`,
// `lead_source`) — the same identity visibility and header
// colors use. Visibility and width are therefore independent:
// hiding never deletes a width, unhiding restores it, and
// Completed/Incomplete share one configuration per flow.
//
// Absent entry = natural (auto) width: current visuals are the
// initial state, and new columns start natural too — resizable
// from their measured width on first drag. Stored widths are
// clamped to [MIN, MAX] on read as well as on write, so the
// grid can never break even if a row is edited by hand.
// ============================================================

/** Hard floor: narrower would clip content into uselessness. */
export const WORKSPACE_COLUMN_MIN_WIDTH = 80;
/** Hard ceiling: wider would swallow the viewport. */
export const WORKSPACE_COLUMN_MAX_WIDTH = 500;

/**
 * Natural width cap for standard custom text cells in the
 * Workspace live table (`max-w-56` = 14rem = 224px on the body
 * TableCell in `src/app/(dashboard)/workspace/page.tsx`). This
 * is the previous configured width for every text column.
 */
export const WORKSPACE_STANDARD_TEXT_CELL_WIDTH = 224;
/**
 * Doubled width for the two long-text business columns
 * ("Customer Response" and "Next Action"): exactly
 * 2 × 224px = 448px (`max-w-112` = 28rem), inside the 80–500
 * safe band. Header and body cells share this value through
 * `columnWidthStyle`, so the two can never misalign.
 */
export const WORKSPACE_WIDE_TEXT_CELL_WIDTH = 448;

/**
 * Long-text business columns rendered at the doubled width,
 * matched by stored-name identity (case-insensitive, trimmed) —
 * never by display labels — following the `isAssigneeField`
 * convention in `workspace-assignee.ts`.
 */
export const WORKSPACE_WIDE_TEXT_COLUMN_NAMES: ReadonlySet<string> = new Set([
  "customer response",
  "next action",
]);

/** True for the "Customer Response" / "Next Action" columns. */
export function isWideTextColumnName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    WORKSPACE_WIDE_TEXT_COLUMN_NAMES.has(name.trim().toLowerCase())
  );
}

/**
 * Default (stored-width fallback) pixels for one custom field
 * name, or undefined when the column keeps its natural width.
 * Stored user widths always win — this only fills gaps so the
 * doubled width is visible without resetting anyone's saved
 * preferences. Every other column is untouched.
 */
export function defaultColumnWidthForFieldName(
  name: unknown,
): number | undefined {
  return isWideTextColumnName(name)
    ? WORKSPACE_WIDE_TEXT_CELL_WIDTH
    : undefined;
}

/**
 * Default width entries for a field list, keyed by stable
 * visibility id (`custom:<field uuid>`). Pure: the input array
 * is never mutated. Only "Customer Response" / "Next Action"
 * fields produce entries; hidden fields are included so
 * unhiding restores the doubled width.
 */
export function defaultColumnWidthsForFields(
  fields: ReadonlyArray<{ id: string; name: string }>,
): Record<string, number> {
  const defaults: Record<string, number> = {};
  for (const f of fields) {
    const px = defaultColumnWidthForFieldName(f?.name);
    if (px !== undefined) defaults[`custom:${f.id}`] = px;
  }
  return defaults;
}

/** Clamp a dragged/stored width into the safe band (integers). */
export function clampColumnWidth(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error("Width must be a number.");
  }
  const px = Math.round(num);
  if (px < WORKSPACE_COLUMN_MIN_WIDTH || px > WORKSPACE_COLUMN_MAX_WIDTH) {
    throw new Error(
      `Width must be between ${WORKSPACE_COLUMN_MIN_WIDTH} and ${WORKSPACE_COLUMN_MAX_WIDTH}px.`,
    );
  }
  return px;
}

/** Lenient read-path clamp: out-of-range stored widths pin to the band. */
export function coerceColumnWidth(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(
    WORKSPACE_COLUMN_MAX_WIDTH,
    Math.max(WORKSPACE_COLUMN_MIN_WIDTH, Math.round(num)),
  );
}

export interface ColumnWidthStyle {
  width: number;
  minWidth: number;
}

/**
 * Inline geometry for one table column, or undefined when the
 * column keeps its natural (auto) width. The SAME object feeds
 * the header cell and every body cell of the column, so the two
 * can never misalign — identical pattern to sticky geometry.
 */
export function columnWidthStyle(
  visId: string,
  widths: Readonly<Record<string, unknown>> | null | undefined,
): ColumnWidthStyle | undefined {
  const raw = widths?.[visId];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return undefined;
  const px = coerceColumnWidth(num, NaN);
  if (!Number.isFinite(px)) return undefined;
  return { width: px, minWidth: px };
}
