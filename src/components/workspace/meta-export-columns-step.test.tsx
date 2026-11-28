import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { SelectableExportColumn } from '@/lib/meta-leads-export/column-selection';
import { MetaExportColumnsStep } from './meta-export-columns-step';

const COLUMNS: SelectableExportColumn[] = [
  { key: '__row', header: 'No.', group: 'basic' },
  { key: 'submission_time', header: 'Submission Time', group: 'basic' },
  { key: 'name', header: 'Name', group: 'basic' },
  { key: 'phone', header: 'Phone Number', group: 'basic' },
  { key: 'answer:city', header: 'City', group: 'basic' },
  {
    key: 'answer:hotel',
    header: 'Which hotel category would you prefer?',
    group: 'basic',
  },
  {
    key: 'answer:month',
    header: 'Which month would you like to travel?',
    group: 'basic',
  },
  {
    key: 'answer:trip',
    header: 'Are you comfortable with the package price?',
    group: 'basic',
  },
  { key: 'assigned_to', header: 'Assigned To', group: 'management' },
  { key: 'lead_type', header: 'Type', group: 'management' },
  { key: 'stage', header: 'Stage', group: 'management' },
  { key: 'call_status', header: 'Call Status', group: 'management' },
  { key: 'calls_tried', header: 'No. of Calls Tried', group: 'management' },
  { key: 'follow_up_status', header: 'Follow-Up Status', group: 'management' },
  { key: 'last_contact', header: 'Last Contact Date', group: 'management' },
  {
    key: 'customer_response',
    header: 'Customer Response',
    group: 'management',
  },
  { key: 'follow_up', header: 'Next Follow-up', group: 'management' },
];

const noop = () => {};
const ALL = new Set(COLUMNS.map((c) => c.key));

function render(
  overrides: Partial<Parameters<typeof MetaExportColumnsStep>[0]> = {}
) {
  return renderToStaticMarkup(
    <MetaExportColumnsStep
      columns={COLUMNS}
      selected={ALL}
      search=""
      onSearchChange={noop}
      expanded={{ basic: true, management: true }}
      onToggleExpanded={noop}
      onToggleColumn={noop}
      onToggleGroup={noop}
      onSelectAll={noop}
      onDeselectAll={noop}
      onBack={noop}
      onCancel={noop}
      onDownload={noop}
      busy={false}
      {...overrides}
    />
  );
}

describe('meta-export Step 2 column selection UI', () => {
  it('shows the progress indicator with Step 2 active', () => {
    const html = render();
    expect(html).toContain('Export progress');
    expect(html).toContain('1. Filters');
    expect(html).toContain('Select Columns');
    expect(html).toContain('aria-current="step"');
  });

  it('shows search, Select All and Deselect All controls', () => {
    const html = render();
    expect(html).toContain('placeholder="Search columns..."');
    expect(html).toContain('aria-label="Search columns"');
    expect(html).toContain('Select All');
    expect(html).toContain('Deselect All');
  });

  it('renders both group headers with descriptions and counts', () => {
    const html = render();
    expect(html).toContain('Basic Details &amp; Form Answers');
    expect(html).toContain(
      'Lead basic information and all Instant Form question answers.'
    );
    expect(html).toContain('8 of 8 selected');
    expect(html).toContain('Lead Management &amp; Follow-up');
    expect(html).toContain(
      'Assignment, stage, call and follow-up related details.'
    );
    expect(html).toContain('9 of 9 selected');
  });

  it('Basic Details has no group-level checkbox; management has a checked one', () => {
    const html = render();
    // Exactly one group-level checkbox (management only).
    expect(html.match(/Select all .* columns/g) ?? []).toHaveLength(1);
    expect(html).toContain(
      'aria-label="Select all Lead Management &amp; Follow-up columns"'
    );
    expect(html).not.toContain('Select all Basic Details');
    // All selected → master checkbox checked.
    expect(html).toContain('data-checked');
    expect(html).not.toContain('data-indeterminate');
  });

  it('partial management selection renders the indeterminate state', () => {
    const partial = new Set(['assigned_to']);
    const html = render({ selected: partial });
    expect(html).toContain('data-indeterminate');
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain('1 of 9 selected');
  });

  it('lists every column with an individual checkbox', () => {
    const html = render();
    for (const c of COLUMNS) {
      expect(html).toContain(`aria-label="${c.header}"`);
    }
  });

  it('search filters the visible columns without changing groups', () => {
    const html = render({ search: 'hotel' });
    expect(html).toContain('Which hotel category would you prefer?');
    expect(html).not.toContain('Which month would you like to travel?');
    // Group headers stay put even when their list is filtered.
    expect(html).toContain('Basic Details &amp; Form Answers');
    expect(html).toContain('Lead Management &amp; Follow-up');
  });

  it('collapsed groups hide their columns but keep the header and count', () => {
    const html = render({ expanded: { basic: false, management: true } });
    expect(html).toContain('Basic Details &amp; Form Answers');
    expect(html).toContain('8 of 8 selected');
    expect(html).not.toContain('Which hotel category would you prefer?');
    expect(html).toContain('aria-expanded="false"');
  });

  it('disables download and shows guidance when nothing is selected', () => {
    const html = render({ selected: new Set() });
    expect(html).toContain('disabled');
    expect(html).toContain(
      'Select at least one column to include in the Excel file.'
    );
    expect(html).toContain('0 of 8 selected');
    expect(html).toContain('0 of 9 selected');
  });

  it('shows footer actions: Back, Cancel, Download .xlsx', () => {
    const html = render();
    expect(html).toContain('Back');
    expect(html).toContain('Cancel');
    expect(html).toContain('Download .xlsx');
  });

  it('reflects unselected columns and updated counts', () => {
    const selected = new Set(ALL);
    selected.delete('stage');
    const html = render({ selected });
    expect(html).toContain('8 of 9 selected');
  });
});
