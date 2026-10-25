import { describe, expect, it } from 'vitest';

import { buildFlowTableColumns } from '@/lib/flows/flow-tables';
import type { FlowNodeLite } from '@/lib/flows/sheet-columns';

function nodesFor(keys: Array<{ key: string }>): FlowNodeLite[] {
  return [
    { node_key: 'start', node_type: 'start', config: { next_node_key: keys[0]?.key ?? '' } },
    ...keys.map((k, i) => ({
      node_key: `q${i}`,
      node_type: 'collect_input' as const,
      config: {
        prompt_text: `What is your ${k.key}?`,
        var_key: k.key,
        next_node_key: keys[i + 1] ? `q${i + 1}` : 'end',
      },
    })),
    { node_key: 'end', node_type: 'end', config: {} },
  ];
}

/**
 * Regression guard: Dial is a page-level application action, never
 * part of the shared column model — in ANY table kind. The model
 * keeps its exact column list (so Sheets mappings, visibility ids,
 * widths, filters, and sorting stay untouched) while every table
 * that contains the Phone Number system column gets a Dial cell
 * rendered after it by the Workspace page UI.
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

  it('always exposes the Phone Number system column Dial anchors to', () => {
    // With and without flow-derived columns, the system phone
    // column is present — the single insertion point the page uses
    // in every table kind.
    for (const keys of [[], [{ key: 'Name' }], [{ key: 'A' }, { key: 'B' }]]) {
      const { columns } = buildFlowTableColumns(nodesFor(keys), 'start');
      const phone = columns.find((c) => c.key === 'phone');
      expect(phone).toMatchObject({ system: true, label: 'Phone Number' });
      expect(columns.map((c) => c.key)).not.toContain('dial');
    }
  });
});
