import { describe, expect, it } from 'vitest';

import { buildFlowTableColumns } from '@/lib/flows/flow-tables';

/**
 * Regression guard: Flow Tables must never gain a Dial column.
 * Dial is a Meta-Lead-Ads-only application action rendered by the
 * Workspace page UI — it is not part of the shared column model,
 * so Sheets mappings, visibility ids, and widths stay untouched.
 */
describe('flow tables unchanged by click-to-dial', () => {
  it('builds columns without any Dial field', () => {
    const { columns } = buildFlowTableColumns([], null);
    const keys = columns.map((c) => c.key);
    expect(keys).toContain('phone');
    expect(keys).not.toContain('dial');
    expect(keys).toEqual([
      'submission_time',
      'name',
      'phone',
      'latest_recording',
      'status',
    ]);
  });
});
