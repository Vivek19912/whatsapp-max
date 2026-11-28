import { describe, expect, it } from 'vitest';

import {
  buildAllMetaExportColumns,
  buildSingleTableExportColumns,
  resolveExportHeader,
} from './columns';

describe('meta-leads-export columns (reuse Workspace logic)', () => {
  it('single table preserves Submission Time first + question headers + provenance', () => {
    const { columns } = buildSingleTableExportColumns({
      nodes: [
        {
          node_key: 'meta_source_node',
          node_type: 'collect_input',
          config: {
            var_key: 'meta_lead_source',
            prompt_text: 'Source',
            sheet_column_name: 'Source',
            sheet_include: true,
          },
          created_at: '2026-01-01',
        },
        {
          node_key: 'meta_q_0_city',
          node_type: 'collect_input',
          config: {
            var_key: 'city',
            prompt_text: 'city',
            sheet_column_name: 'city',
            sheet_include: true,
          },
          created_at: '2026-01-02',
        },
      ],
      entryNodeKey: 'meta_source_node',
      fullNameQuestions: [],
      questionKeys: ['city'],
      headerLabels: { 'flow:city': 'Preferred City' },
      workspaceFields: [
        { id: 'f1', name: 'Assigned To', field_type: 'single_select' },
      ],
    });
    const headers = columns.map((c) => c.header);
    expect(headers[0]).toBe('No.');
    expect(headers[1]).toBe('Submission Time');
    // Header-label override wins over stored question text.
    expect(headers).toContain('Preferred City');
    // System + provenance columns present.
    expect(headers).toContain('Name');
    expect(headers).toContain('Phone Number');
    expect(headers).toContain('Ad Name');
    expect(headers).toContain('Campaign Name');
    // Workspace business field uses display alias formatting.
    expect(headers).toContain('Assigned To');
    // UI-only columns never exported.
    expect(headers).not.toContain('Latest Recording');
  });

  it('single table suppresses the Full Name twin, keeps system Name', () => {
    const { columns } = buildSingleTableExportColumns({
      nodes: [
        {
          node_key: 'n1',
          node_type: 'collect_input',
          config: {
            var_key: 'full_name',
            prompt_text: 'Full name',
            sheet_column_name: 'Full name',
            sheet_include: true,
          },
          created_at: '2026-01-01',
        },
      ],
      entryNodeKey: 'n1',
      fullNameQuestions: [
        { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
      ],
      questionKeys: ['full_name'],
      headerLabels: null,
      workspaceFields: [],
    });
    const answerCols = columns.filter((c) => c.key.startsWith('answer:'));
    expect(
      answerCols.find((c) => c.key === 'answer:full_name')
    ).toBeUndefined();
    expect(columns.map((c) => c.header)).toContain('Name');
  });

  it('all-meta union keeps combined spec order + provenance', () => {
    const cols = buildAllMetaExportColumns({ tables: [], fieldsByFlow: {} });
    const headers = cols.map((c) => c.header);
    expect(headers.slice(0, 5)).toEqual([
      'No.',
      'Submission Time',
      'Name',
      'Phone Number',
      'Meta Lead Ads Table',
    ]);
    expect(headers).toContain('Source');
    expect(headers).toContain('Form Answers');
    expect(headers).toContain('Assigned To');
    expect(headers).toContain('Type');
    expect(headers).toContain('Stage');
    expect(headers).toContain('Ad Name');
    expect(headers).toContain('Campaign Name');
  });

  it('header resolver applies Meta overrides, never Flow Tables', () => {
    expect(
      resolveExportHeader({
        column: { key: 'city', system: false, label: 'city' },
        labels: { 'flow:city': 'Preferred City' },
      })
    ).toBe('Preferred City');
    // System columns ignore overrides.
    expect(
      resolveExportHeader({
        column: { key: 'name', system: true, label: 'Name' },
        labels: { 'flow:name': 'Hacked' },
      })
    ).toBe('Name');
  });
});
