import { describe, expect, it } from 'vitest';

import ExcelJS from 'exceljs';

import {
  buildMetaLeadsWorkbook,
  fitColumnWidthToHeader,
  headerWrappedLineCount,
} from './workbook';
import { EXCEL_MAX_ROWS } from './constants';

describe('buildMetaLeadsWorkbook', () => {
  it('creates one worksheet with frozen header + autofilter + dates', async () => {
    const buf = await buildMetaLeadsWorkbook({
      columns: [
        {
          key: 'submission_time',
          header: 'Submission Time',
          kind: 'date',
          group: 'basic',
        },
        { key: 'name', header: 'Name', kind: 'text', group: 'basic' },
        {
          key: 'phone',
          header: 'Phone Number',
          kind: 'text',
          group: 'basic',
        },
      ],
      rows: [
        {
          submission_time: new Date('2026-11-28T10:00:00Z'),
          name: 'Aarav',
          phone: '+919999999999',
        },
        { submission_time: null, name: '', phone: null },
        // Formula injection is neutralized, not executed.
        {
          submission_time: new Date('2026-11-27T10:00:00Z'),
          name: '=1+1',
          phone: '+918888888888',
        },
      ],
    });
    expect(buf.length).toBeGreaterThan(1000);
    // ZIP signature of a genuine .xlsx (not CSV-with-extension).
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('rejects exports beyond Excel row limit instead of truncating', async () => {
    await expect(
      buildMetaLeadsWorkbook({
        columns: [
          { key: 'name', header: 'Name', kind: 'text', group: 'basic' },
        ],
        rows: Array.from({ length: EXCEL_MAX_ROWS }, (_, i) => ({
          name: `L${i}`,
        })),
      })
    ).rejects.toThrow(/exceeding Excel/);
  });

  it('handles special chars + empty values consistently', async () => {
    const buf = await buildMetaLeadsWorkbook({
      columns: [
        {
          key: 'form_answers',
          header: 'Form Answers',
          kind: 'text',
          group: 'basic',
        },
      ],
      rows: [
        { form_answers: 'Q: A\nnewline, comma,; emoji 🎉' },
        { form_answers: null },
        { form_answers: '' },
      ],
    });
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('honours per-column date formats while keeping real date values', async () => {
    const buf = await buildMetaLeadsWorkbook({
      columns: [
        {
          key: 'submission_time',
          header: 'Submission Time',
          kind: 'date',
          group: 'basic',
          numFmt: 'dd-mm-yyyy hh:mm AM/PM',
        },
        {
          key: 'last_contact',
          header: 'Last Contact Date',
          kind: 'date',
          group: 'management',
          numFmt: 'dd-mm-yyyy',
        },
        {
          key: 'follow_up',
          header: 'Follow-up information',
          kind: 'date',
          group: 'management',
        },
      ],
      rows: [
        {
          submission_time: new Date('2026-11-28T17:34:00Z'),
          last_contact: new Date('2026-11-27T00:00:00Z'),
          follow_up: new Date('2026-11-29T10:00:00Z'),
        },
        { submission_time: null, last_contact: null, follow_up: null },
      ],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Uint8Array.from(buf).buffer);
    const ws = wb.getWorksheet('Leads');
    expect(ws).toBeDefined();
    const header = ws!.getRow(1).values as unknown[];
    const idxOf = (h: string) =>
      (header as unknown[]).findIndex((v) => v === h);
    const subCell = ws!.getRow(2).getCell(idxOf('Submission Time'));
    const lcdCell = ws!.getRow(2).getCell(idxOf('Last Contact Date'));
    const fuCell = ws!.getRow(2).getCell(idxOf('Follow-up information'));
    // Real Excel dates, not text — with the requested display formats.
    expect(subCell.value).toBeInstanceOf(Date);
    expect(subCell.numFmt).toBe('dd-mm-yyyy hh:mm AM/PM');
    expect(lcdCell.value).toBeInstanceOf(Date);
    expect(lcdCell.numFmt).toBe('dd-mm-yyyy');
    // Columns without an explicit format keep the workbook default.
    expect(fuCell.value).toBeInstanceOf(Date);
    expect(fuCell.numFmt).toBe('yyyy-mm-dd hh:mm');
    // Empty dates stay empty, never epoch text.
    expect(ws!.getRow(3).getCell(idxOf('Submission Time')).value).toBeNull();
    expect(ws!.getRow(3).getCell(idxOf('Last Contact Date')).value).toBeNull();
  });

  it('wraps header text with vertical centering and left alignment', async () => {
    const buf = await buildMetaLeadsWorkbook({
      columns: [
        { key: 'name', header: 'Name', kind: 'text', group: 'basic' },
        {
          key: 'phone',
          header: 'Phone Number',
          kind: 'text',
          group: 'basic',
        },
      ],
      rows: [{ name: 'Aarav', phone: '+919999999999' }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Uint8Array.from(buf).buffer);
    const ws = wb.getWorksheet('Leads');
    expect(ws).toBeDefined();
    // Short headers stay single-line: row height fits one line.
    expect(ws!.getRow(1).height).toBe(15);
    ws!.getRow(1).eachCell((cell) => {
      expect(cell.alignment).toMatchObject({
        vertical: 'middle',
        horizontal: 'left',
        wrapText: true,
      });
    });
    // Header styling is untouched.
    expect(ws!.getRow(1).font).toMatchObject({ bold: true });
    expect(ws!.getRow(1).fill).toMatchObject({
      type: 'pattern',
      pattern: 'solid',
    });
    // Autofilter + frozen header row survive.
    expect(ws!.autoFilter).toBe('A1:B1');
    expect(ws!.views).toContainEqual(
      expect.objectContaining({ state: 'frozen', ySplit: 1 })
    );
  });

  it('grows the header row so 2-3 line question headers stay visible', async () => {
    const longHeader = 'Q'.repeat(60);
    const buf = await buildMetaLeadsWorkbook({
      columns: [
        { key: 'name', header: 'Name', kind: 'text', group: 'basic' },
        { key: 'q1', header: longHeader, kind: 'text', group: 'basic' },
      ],
      rows: [{ name: 'Aarav', q1: 'Yes' }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Uint8Array.from(buf).buffer);
    const ws = wb.getWorksheet('Leads');
    // 60 chars at width 32 (usable 29) wrap to 3 lines → 45pt.
    expect(ws!.getColumn(2).width).toBe(32);
    expect(ws!.getRow(1).height).toBe(45);
  });

  it('widens very long headers instead of stacking endless lines', async () => {
    const longHeader = 'Q'.repeat(100);
    const buf = await buildMetaLeadsWorkbook({
      columns: [
        { key: 'name', header: 'Name', kind: 'text', group: 'basic' },
        { key: 'q1', header: longHeader, kind: 'text', group: 'basic' },
      ],
      rows: [{ name: 'Aarav', q1: 'Yes' }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Uint8Array.from(buf).buffer);
    const ws = wb.getWorksheet('Leads');
    // ceil(100/3)+3 = 37 chars: short headers keep their width.
    expect(ws!.getColumn(2).width).toBe(37);
    expect(ws!.getColumn(1).width).toBe(22);
    // 100 chars in 34 usable chars wrap to 3 lines.
    expect(ws!.getRow(1).height).toBe(45);
  });

  it('counts explicit newlines as separate header lines', async () => {
    const buf = await buildMetaLeadsWorkbook({
      columns: [
        {
          key: 'q1',
          header: 'AB\nCDEFGH',
          kind: 'text',
          width: 20,
          group: 'basic',
        },
      ],
      rows: [{ q1: 'Yes' }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Uint8Array.from(buf).buffer);
    const ws = wb.getWorksheet('Leads');
    // 'AB' → 1 line, 'CDEFGH' fits one line at usable width 17.
    expect(ws!.getRow(1).height).toBe(30);
  });

  it('header line estimation never clips and never narrows columns', () => {
    expect(headerWrappedLineCount('Name', 22)).toBe(1);
    expect(headerWrappedLineCount('', 22)).toBe(1);
    expect(headerWrappedLineCount('AB\nCDEFGH', 20)).toBe(2);
    // Short headers keep their width; long ones widen (capped at 50).
    expect(fitColumnWidthToHeader(22, 'Name')).toBe(22);
    expect(fitColumnWidthToHeader(32, 'Q'.repeat(60))).toBe(32);
    expect(fitColumnWidthToHeader(32, 'Q'.repeat(100))).toBe(37);
    expect(fitColumnWidthToHeader(10, 'Q'.repeat(500))).toBe(50);
  });
});
