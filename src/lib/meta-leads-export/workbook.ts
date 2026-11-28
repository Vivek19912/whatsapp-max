// ============================================================
// Meta Leads Export — .xlsx workbook builder (exceljs).
//
// One worksheet per file. Headers match Workspace display names.
// Values pass through sanitizeExcelValue (formula-injection guard).
// Date columns render as real Excel dates (per-column numFmt;
// default yyyy-mm-dd hh:mm). Freeze header row + autofilter.
// Sensible widths, no truncation.
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
  /**
   * Explicit Excel number-format code for `date` columns. When set
   * it wins over the workbook default (`yyyy-mm-dd hh:mm`), so
   * individual columns (Submission Time, Last Contact Date) can
   * carry their own display format while the stored Date value
   * stays a real Excel date.
   */
  numFmt?: string;
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

/** Excel row height (pt) of one wrapped Calibri-11 text line. */
const HEADER_LINE_HEIGHT_PT = 15;
/** Long headers are widened so wrapped text fits in ~this many lines. */
const HEADER_TARGET_MAX_LINES = 3;
/**
 * Characters reserved at the end of every header cell so the
 * autofilter dropdown arrow never covers header text.
 */
const HEADER_AUTOFILTER_RESERVE_CHARS = 3;
/** Floor for the usable wrap width, keeping estimates sane. */
const HEADER_MIN_USABLE_CHARS = 8;

/**
 * Estimated wrapped line count for one header at the given column
 * width (Excel character units). Explicit newlines start new lines;
 * every segment needs at least one line. Conservative by design
 * (bold headers, proportional font): the row may end up slightly
 * tall, but header text is never clipped.
 */
export function headerWrappedLineCount(
  header: string,
  columnWidthChars: number
): number {
  const usable = Math.max(
    HEADER_MIN_USABLE_CHARS,
    Math.floor(columnWidthChars) - HEADER_AUTOFILTER_RESERVE_CHARS
  );
  let lines = 0;
  for (const segment of String(header).split('\n')) {
    lines += Math.max(1, Math.ceil(segment.length / usable));
  }
  return lines;
}

/**
 * Widen a column when its header would otherwise wrap past the
 * target line count. Never narrows (data readability keeps the
 * existing default), never exceeds the workbook width cap.
 */
export function fitColumnWidthToHeader(
  baseWidthChars: number,
  header: string
): number {
  const longest = Math.max(
    ...String(header)
      .split('\n')
      .map((s) => s.length),
    0
  );
  const fitted =
    Math.ceil(longest / HEADER_TARGET_MAX_LINES) +
    HEADER_AUTOFILTER_RESERVE_CHARS;
  return Math.min(50, Math.max(baseWidthChars, fitted));
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

  const finalWidths = columns.map((c) => {
    const baseWidth = Math.min(
      Math.max(c.width ?? defaultWidth(c.kind, c.header), 10),
      50
    );
    return fitColumnWidthToHeader(baseWidth, c.header);
  });
  ws.columns = columns.map((c, idx) => ({
    header: c.header,
    key: c.key,
    width: finalWidths[idx],
  }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F2937' },
  };
  // Header cells wrap, are vertically centered + left aligned, and
  // the row is tall enough for the longest wrapped header (2–3 line
  // form-question headers stay fully visible). Autofilter arrows
  // overlay the reserved trailing space, never the text.
  headerRow.eachCell((cell) => {
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  const headerLines = Math.max(
    1,
    ...columns.map((c, idx) =>
      headerWrappedLineCount(c.header, finalWidths[idx])
    )
  );
  headerRow.height = headerLines * HEADER_LINE_HEIGHT_PT;

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

  // Date formatting (readable, locale-independent). A column with
  // an explicit numFmt keeps it; all other dates use the workbook
  // default. Values stay real Excel dates — never plain text.
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    columns.forEach((c, idx) => {
      if (c.kind !== 'date') return;
      const cell = row.getCell(idx + 1);
      if (cell.value instanceof Date)
        cell.numFmt = c.numFmt ?? 'yyyy-mm-dd hh:mm';
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
