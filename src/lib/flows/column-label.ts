// ============================================================
// Workspace column-label display formatting — UI only.
//
// "First word capitalized": the first character is uppercased,
// everything else is left EXACTLY as stored. This never touches
// the underlying column name/key, database value, API payload,
// Google Sheets header, search matching, or header-color
// resolution — callers format at render time only.
//
// Display aliases (also UI only): two long default names render
// shorter in the Workspace table and Columns menu, while the
// stored field name, uniqueness key, filters, select options,
// Sheets mapping, and Travel CRM mapping keep the original:
//   "Lead Type"     → "Type"
//   "Lead Received" → "Lead Source"
//
//   "name"             → "Name"
//   "height and weight"→ "Height and weight"
//   "customer_source"  → "Customer_source"
//   "Assigned To"      → "Assigned To" (unchanged)
// ============================================================

/**
 * Stored column names with a shorter user-facing display label.
 * Matched case-insensitively on the trimmed stored name; the
 * stored value itself is never modified.
 */
const DISPLAY_ALIASES: Readonly<Record<string, string>> = {
  "lead type": "Type",
  "lead received": "Lead Source",
};

/** Display a stored column name with its first character capitalized. */
export function formatColumnLabel(label: string): string {
  if (!label) return label;
  const alias = DISPLAY_ALIASES[label.trim().toLowerCase()];
  if (alias !== undefined) return alias;
  const first = label.charAt(0);
  const upper = first.toUpperCase();
  if (first === upper) return label;
  return upper + label.slice(1);
}
