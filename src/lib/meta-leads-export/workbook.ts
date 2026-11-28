// ============================================================
// Meta Leads Export — .xlsx workbook builder (exceljs).
//
// One worksheet per file. Headers match Workspace display names.
// Values pass through sanitizeExcelValue (formula-injection guard).
// Submission/Meta/Follow-up times render as real Excel dates.
// Freeze header row + autofilter. Sensible widths, no truncation.
// ============================================================

import ExcelJS from 'exceljs';

import { EXPORT_SHEET_NAME, sanitizeExcelValue } from './constants';

export interface ExportColumn {
  /** Stable key (for mapping, never displayed). */
  key: string;
  /** Display header (already resolved: overrides + formatColumnLabel). */
  header: string;
  /** Column kind for formatting/width. */
  kind: 'text' | 'date' | 'number';
  /** Preferred width override (chars). */
  width?: number;
}

export interface ExportRow {
  [key: string]: string | number | Date | boolean | null | undefined;
}

function columnLetter(n: number): string {
  let s = '';
  let i = n;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function defaultWidth(kind: ExportColumn['kind'], header: string): number {
  if (kind === 'date') return 20;
  const h = header.length;
  if (/phone/i.test(header)) return Math.max(16, Math.min(h + 4, 22));
  if (/name/i.test(header)) return 22;
  if (/answer|remark|note|address/i.test(header)) return 30;
  if (/table|source|campaign|ad\b/i.test(header)) return 22;
  if (/follow|stage|type|status/i.test(header)) return 16;
  return Math.max(14, Math.min(h + 6, 32));
}

/**
 * Build a genuine .xlsx buffer from columns + rows.
 * Throws when rows exceed Excel's worksheet limit.
 */
export async function buildMetaLeadsWorkbook(args: {
  columns: ExportColumn[];
  rows: ExportRow[];
  sheetName?: string;
}): Promise<Buffer> {
  const { columns, rows } = args;
  if (rows.length + 1 > 1_048_576) {
    throw new Error(
      `Export has ${rows.length.toLocaleString()} rows, exceeding Excel's 1,048,575-row limit. Narrow the filters and try again.`
    );
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WACRM';
  workbook.created = new Date();
  const rawName = (args.sheetName ?? EXPORT_SHEET_NAME)
    .replace(/[\[\]\:*?\/\\]/g, ' ')
    .trim();
  const sheetName = (rawName || EXPORT_SHEET_NAME).slice(0, 31);
  const ws = workbook.addWorksheet(sheetName);

  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.min(
      Math.max(c.width ?? defaultWidth(c.kind, c.header), 10),
      50
    ),
  }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F2937' },
  };
  headerRow.alignment = { vertical: 'middle', wrapText: true };
  headerRow.height = 22;

  for (const row of rows) {
    const values: Record<string, unknown> = {};
    for (const c of columns) {
      const v = row[c.key];
      if (v === null || v === undefined || v === '') {
        values[c.key] = null;
        continue;
      }
      if (c.kind === 'date') {
        const d = v instanceof Date ? v : new Date(String(v));
        values[c.key] = Number.isNaN(d.getTime())
          ? sanitizeExcelValue(String(v))
          : d;
        continue;
      }
      if (c.kind === 'number' && typeof v === 'number') {
        values[c.key] = v;
        continue;
      }
      values[c.key] = sanitizeExcelValue(typeof v === 'string' ? v : String(v));
    }
    const r = ws.addRow(values);
    r.alignment = { vertical: 'top', wrapText: true };
  }

  // Date formatting (readable, locale-independent).
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    columns.forEach((c, idx) => {
      if (c.kind !== 'date') return;
      const cell = row.getCell(idx + 1);
      if (cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd hh:mm';
    });
  });

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (columns.length > 0) {
    ws.autoFilter = {
      from: 'A1',
      to: `${columnLetter(columns.length)}1`,
    };
  }

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
