// ============================================================
// Meta Lead Ads → Google Sheets sync — shared constants.
//
// Meta-only. Nothing here is imported by Flow Tables, All Sheets,
// or the generic Google Sheets feature. The header below is the
// legacy owned range (row 1, columns A–L), still used for fresh
// spreadsheet creation and NULL column configs. Policy:
//   * The Meta Lead ID is the stable dedup key — never rename or
//     delete it. Its position follows the configured column order
//     (last by default; first for legacy layouts); matching scans
//     that configured position, never a hardcoded column.
//   * Row 1 headers are managed by WhatsApp Max; manual renames
//     are overwritten on the next sync.
//   * Users may add their own columns to the RIGHT of the managed
//     width; anything inside it may be overwritten by sync updates.
//   * Never write outside this spreadsheet/tab; never touch other
//     tabs; disconnect never deletes spreadsheet contents.
// ============================================================

/** Legacy header row (ID first), owned by this integration. */
export const META_SHEETS_HEADERS = [
  "Meta Lead ID",
  "Submitted At",
  "Name",
  "Phone",
  "Email",
  "Form Name",
  "Campaign",
  "Ad",
  "Source",
  "Assigned To",
  "Lead Type",
  "Stage",
] as const;

export type MetaSheetsHeader = (typeof META_SHEETS_HEADERS)[number];

/**
 * 0-based fallback index of the stable dedup column, matching the
 * legacy ID-first layout. Layouts always carry their own
 * `idColumnIndex`; this constant is only the default when no
 * layout is available.
 */
export const META_SHEETS_LEAD_ID_COL = 0;

/** Default worksheet tab name for a fresh config. */
export const META_SHEETS_DEFAULT_TAB = "Meta Leads";

/** Rows claimed per drain sweep (cron budget). */
export const META_SHEETS_SWEEP_LIMIT = 20;

/** Max attempts per queued row (first try + retries). */
export const META_SHEETS_MAX_ATTEMPTS = 8;

/** Rows written per Sheets API request during backfill. */
export const META_SHEETS_BATCH_SIZE = 50;

/** Bounded backoff: 1m, 2m, 4m … capped at 30m. */
export function sheetsRetryDelayMs(attempt: number): number {
  const step = Math.max(0, attempt - 1);
  return Math.min(60_000 * 2 ** step, 30 * 60_000);
}
