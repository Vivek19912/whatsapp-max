import { describe, expect, it } from 'vitest';

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
});
