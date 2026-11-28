import { describe, expect, it } from 'vitest';

import {
  buildAllMetaExportColumns,
  buildSingleTableExportColumns,
  DATE_ONLY_NUM_FMT,
  resolveExportHeader,
  SUBMISSION_TIME_NUM_FMT,
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
    // System columns present.
    expect(headers).toContain('Name');
    expect(headers).toContain('Phone Number');
    // Provenance columns are intentionally not exported.
    expect(headers).not.toContain('Ad Name');
    expect(headers).not.toContain('Campaign Name');
    expect(headers).not.toContain('Lead Source');
    expect(headers).not.toContain('Meta Created Time');
    expect(headers).not.toContain('Meta Lead ID');
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

  it('all-meta union keeps combined spec order without provenance', () => {
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
    expect(headers).not.toContain('Ad Name');
    expect(headers).not.toContain('Campaign Name');
    expect(headers).not.toContain('Lead Source');
    expect(headers).not.toContain('Meta Created Time');
    expect(headers).not.toContain('Meta Lead ID');
  });

  it('submission time uses dd-mm-yyyy hh:mm AM/PM in both views', () => {
    const single = buildSingleTableExportColumns({
      nodes: [],
      entryNodeKey: null,
      fullNameQuestions: [],
      questionKeys: [],
      headerLabels: null,
      workspaceFields: [],
    });
    const singleSubmission = single.columns.find(
      (c) => c.key === 'submission_time'
    );
    expect(singleSubmission?.numFmt).toBe(SUBMISSION_TIME_NUM_FMT);
    expect(SUBMISSION_TIME_NUM_FMT).toBe('dd-mm-yyyy hh:mm AM/PM');

    const all = buildAllMetaExportColumns({ tables: [], fieldsByFlow: {} });
    const allSubmission = all.find((c) => c.key === 'submission_time');
    expect(allSubmission?.numFmt).toBe('dd-mm-yyyy hh:mm AM/PM');
  });

  it('last Contact Date renders date-only while other dates keep time', () => {
    const { columns } = buildSingleTableExportColumns({
      nodes: [],
      entryNodeKey: null,
      fullNameQuestions: [],
      questionKeys: [],
      headerLabels: null,
      workspaceFields: [
        { id: 'f-lcd', name: 'Last Contact Date', field_type: 'text' },
        {
          id: 'f-nfu',
          name: 'Next Follow-up Date & Time',
          field_type: 'datetime',
        },
      ],
    });
    const byHeader = new Map(columns.map((c) => [c.header, c]));
    expect(byHeader.get('Last Contact Date')?.kind).toBe('date');
    expect(byHeader.get('Last Contact Date')?.numFmt).toBe(DATE_ONLY_NUM_FMT);
    expect(DATE_ONLY_NUM_FMT).toBe('dd-mm-yyyy');
    // Unrelated date columns keep the workbook default format.
    expect(byHeader.get('Next Follow-up Date & Time')?.kind).toBe('date');
    expect(byHeader.get('Next Follow-up Date & Time')?.numFmt).toBeUndefined();
  });

  it('drops the duplicate dynamic phone question column, keeps system Column D', () => {
    const { columns } = buildSingleTableExportColumns({
      nodes: [
        {
          node_key: 'meta_q_0_phone',
          node_type: 'collect_input',
          config: {
            var_key: 'phone_number',
            prompt_text: 'Phone number',
            sheet_column_name: 'Phone number',
            sheet_include: true,
          },
          created_at: '2026-01-01',
        },
        {
          node_key: 'meta_q_1_city',
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
      entryNodeKey: 'meta_q_0_phone',
      fullNameQuestions: [],
      questionKeys: ['phone_number', 'city'],
      headerLabels: null,
      workspaceFields: [],
    });
    const headers = columns.map((c) => c.header);
    // System Phone Number stays exactly at Column D.
    expect(headers.slice(0, 4)).toEqual([
      'No.',
      'Submission Time',
      'Name',
      'Phone Number',
    ]);
    const phoneHeaders = headers.filter(
      (hh) =>
        hh
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, '') === 'phonenumber'
    );
    expect(phoneHeaders).toEqual(['Phone Number']);
    // The other dynamic question column is untouched.
    expect(headers).toContain('City');
    expect(
      columns.find((c) => c.key === 'answer:phone_number')
    ).toBeUndefined();
  });

  it('matches phone duplicates case-insensitively, keeps unrelated fields', () => {
    const { columns } = buildSingleTableExportColumns({
      nodes: [
        {
          node_key: 'meta_q_0_phone',
          node_type: 'collect_input',
          config: {
            var_key: 'phone_number',
            prompt_text: 'PHONE_NUMBER',
            sheet_column_name: 'PHONE_NUMBER',
            sheet_include: true,
          },
          created_at: '2026-01-01',
        },
      ],
      entryNodeKey: 'meta_q_0_phone',
      fullNameQuestions: [],
      questionKeys: ['phone_number'],
      headerLabels: null,
      workspaceFields: [{ id: 'f1', name: 'Phone', field_type: 'text' }],
    });
    const headers = columns.map((c) => c.header);
    expect(
      headers.filter(
        (hh) =>
          hh
            .trim()
            .toLowerCase()
            .replace(/[\s_]+/g, '') === 'phonenumber'
      )
    ).toEqual(['Phone Number']);
    // A merely similar custom field is preserved.
    expect(headers).toContain('Phone');
  });

  it('all-meta union applies date-only format and preserves custom fields', () => {
    const cols = buildAllMetaExportColumns({
      tables: [{ flowId: 'flow-1' }],
      fieldsByFlow: {
        'flow-1': [
          { id: 'u1', name: 'Last Contact Date', field_type: 'datetime' },
          { id: 'u2', name: 'Phone', field_type: 'text' },
        ],
      },
    });
    const byHeader = new Map(cols.map((c) => [c.header, c]));
    expect(byHeader.get('Last Contact Date')?.kind).toBe('date');
    expect(byHeader.get('Last Contact Date')?.numFmt).toBe(DATE_ONLY_NUM_FMT);
    // Custom fields are never removed as duplicates.
    expect(byHeader.get('Phone')).toBeDefined();
    expect(cols.map((c) => c.header)).toContain('Phone Number');
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
