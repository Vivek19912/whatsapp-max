import { describe, expect, it } from 'vitest';

import {
  buildAllMetaExportColumns,
  buildSingleTableExportColumns,
  DATE_ONLY_NUM_FMT,
  filterColumnsByKeys,
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
    // UI-only columns never exported.
    expect(headers).not.toContain('Latest Recording');
    // Every column belongs to exactly one Step-2 group.
    const byKey = new Map(columns.map((c) => [c.key, c.group]));
    expect(byKey.get('__row')).toBe('basic');
    expect(byKey.get('submission_time')).toBe('basic');
    expect(byKey.get('name')).toBe('basic');
    expect(byKey.get('phone')).toBe('basic');
    expect(byKey.get('answer:city')).toBe('basic');
    expect(byKey.get('field:f1')).toBe('management');
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
    const byKey = new Map(cols.map((c) => [c.key, c.group]));
    expect(byKey.get('__row')).toBe('basic');
    expect(byKey.get('meta_table')).toBe('basic');
    expect(byKey.get('source')).toBe('basic');
    expect(byKey.get('form_answers')).toBe('basic');
    expect(byKey.get('assigned_to')).toBe('management');
    expect(byKey.get('stage')).toBe('management');
    expect(byKey.get('follow_up')).toBe('management');
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

  it('assigns every column to exactly one group', () => {
    const { columns: single } = buildSingleTableExportColumns({
      nodes: [
        {
          node_key: 'meta_q_0_city',
          node_type: 'collect_input',
          config: {
            var_key: 'city',
            prompt_text: 'city',
            sheet_column_name: 'city',
            sheet_include: true,
          },
          created_at: '2026-01-01',
        },
      ],
      entryNodeKey: 'meta_q_0_city',
      fullNameQuestions: [],
      questionKeys: ['city'],
      headerLabels: null,
      workspaceFields: [
        { id: 'f1', name: 'Assigned To', field_type: 'single_select' },
      ],
    });
    const singleByKey = new Map(single.map((c) => [c.key, c.group]));
    expect(singleByKey.get('__row')).toBe('basic');
    expect(singleByKey.get('submission_time')).toBe('basic');
    expect(singleByKey.get('name')).toBe('basic');
    expect(singleByKey.get('phone')).toBe('basic');
    expect(singleByKey.get('answer:city')).toBe('basic');
    expect(singleByKey.get('field:f1')).toBe('management');

    const all = buildAllMetaExportColumns({
      tables: [{ flowId: 'flow-1' }],
      fieldsByFlow: {
        'flow-1': [{ id: 'u1', name: 'Notes', field_type: 'text' }],
      },
    });
    const allByKey = new Map(all.map((c) => [c.key, c.group]));
    expect(allByKey.get('meta_table')).toBe('basic');
    expect(allByKey.get('source')).toBe('basic');
    expect(allByKey.get('form_answers')).toBe('basic');
    expect(allByKey.get('assigned_to')).toBe('management');
    expect(allByKey.get('stage')).toBe('management');
    expect(allByKey.get('union:all_union_notes')).toBe('management');
    for (const c of [...single, ...all]) {
      expect(c.group === 'basic' || c.group === 'management').toBe(true);
    }
  });

  it('filterColumnsByKeys keeps canonical order and flags unknowns', () => {
    const all = buildAllMetaExportColumns({ tables: [], fieldsByFlow: {} });
    // Null selection = everything (existing single-step behavior).
    expect(filterColumnsByKeys(all, null).columns.map((c) => c.key)).toEqual(
      all.map((c) => c.key)
    );
    // Tick order does not leak into the workbook.
    const picked = filterColumnsByKeys(all, ['stage', 'name', '__row']);
    expect(picked.unknownKeys).toEqual([]);
    expect(picked.columns.map((c) => c.key)).toEqual([
      '__row',
      'name',
      'stage',
    ]);
    // Removed provenance columns can never be reintroduced.
    for (const removed of [
      'meta_ad',
      'meta_campaign',
      'meta_source_type',
      'meta_created',
      'meta_lead_id',
    ]) {
      expect(filterColumnsByKeys(all, [removed]).unknownKeys).toEqual([
        removed,
      ]);
    }
    // Duplicates collapse to a single column.
    expect(
      filterColumnsByKeys(all, ['name', 'name', 'phone']).columns.map(
        (c) => c.key
      )
    ).toEqual(['name', 'phone']);
  });
});
