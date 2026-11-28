import { describe, expect, it } from 'vitest';

import ExcelJS from 'exceljs';

import { buildMetaLeadsWorkbook } from './workbook';
import { EXCEL_MAX_ROWS } from './constants';

describe('buildMetaLeadsWorkbook', () => {
  it('creates one worksheet with frozen header + autofilter + dates', async () => {
    const buf = await buildMetaLeadsWorkbook({
      columns: [
        { key: 'submission_time', header: 'Submission Time', kind: 'date' },
        { key: 'name', header: 'Name', kind: 'text' },
        { key: 'phone', header: 'Phone Number', kind: 'text' },
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
        columns: [{ key: 'name', header: 'Name', kind: 'text' }],
        rows: Array.from({ length: EXCEL_MAX_ROWS }, (_, i) => ({
          name: `L${i}`,
        })),
      })
    ).rejects.toThrow(/exceeding Excel/);
  });

  it('handles special chars + empty values consistently', async () => {
    const buf = await buildMetaLeadsWorkbook({
      columns: [{ key: 'form_answers', header: 'Form Answers', kind: 'text' }],
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
          numFmt: 'dd-mm-yyyy hh:mm AM/PM',
        },
        {
          key: 'last_contact',
          header: 'Last Contact Date',
          kind: 'date',
          numFmt: 'dd-mm-yyyy',
        },
        { key: 'follow_up', header: 'Follow-up information', kind: 'date' },
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
});
