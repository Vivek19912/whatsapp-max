// ============================================================
// Meta Leads Excel Export — shared constants + pure helpers.
//
// Scope: Meta Lead Ads tables ONLY (flows.kind = 'meta_lead_ads'
// plus the virtual ALL_META_LEADS_ID union). Never imported by
// Flow Table (whatsapp_flow) paths.
// ============================================================

import { ALL_META_LEADS_ID } from '@/lib/workspace/all-meta-leads';

/** Excel hard limit (rows per worksheet, including header). */
export const EXCEL_MAX_ROWS = 1_048_576;

/** RPC page size for export batching (matches server caps). */
export const EXPORT_RPC_PAGE_SIZE = 100;

/** Worksheet name (Excel caps at 31 chars, forbids []:*?/\). */
export const EXPORT_SHEET_NAME = 'Leads';

/** True when the export target is the virtual All Meta Leads union. */
export function isAllMetaExportTarget(
  tableId: string | null | undefined
): boolean {
  return tableId === ALL_META_LEADS_ID;
}

/**
 * Sanitize a filename segment: trim, collapse whitespace, replace
 * filesystem-hostile chars, cap length. Never returns empty.
 */
export function sanitizeFilenameSegment(
  raw: string | null | undefined
): string {
  const t = (raw ?? '').trim().replace(/\s+/g, '_');
  const clean = t
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (clean || 'Export').slice(0, 80);
}

/** Descriptive filename: <Table>_YYYY-MM-DD.xlsx */
export function buildExportFilename(
  tableName: string | null | undefined,
  now: Date = new Date()
): string {
  const day = now.toISOString().slice(0, 10);
  return `${sanitizeFilenameSegment(tableName || 'All_Meta_Leads')}_${day}.xlsx`;
}

/**
 * Protect against Excel formula injection from untrusted lead data.
 * Values starting with = + - @ (or tab/CR) are prefixed with a
 * single-quote text marker (hidden by Excel, forces text).
 */
export function sanitizeExcelValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === '') return value;
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

/** Lead Source filter values (maps to is_organic). */
export const EXPORT_SOURCE_OPTIONS = ['all', 'organic', 'paid'] as const;
export type ExportSourceFilter = (typeof EXPORT_SOURCE_OPTIONS)[number];

export function isExportSourceFilter(v: unknown): v is ExportSourceFilter {
  return (
    typeof v === 'string' &&
    (EXPORT_SOURCE_OPTIONS as readonly string[]).includes(v)
  );
}

/**
 * Match a row's is_organic flag against the source filter.
 * null (unknown/historical) matches only "all" — never organic/paid.
 */
export function matchesSourceFilter(
  isOrganic: boolean | null | undefined,
  source: ExportSourceFilter
): boolean {
  if (source === 'all') return true;
  if (source === 'organic') return isOrganic === true;
  return isOrganic === false;
}
