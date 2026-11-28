import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  `${process.cwd()}/src/components/workspace/meta-export-dialog.tsx`,
  'utf8'
);

describe('meta-export dialog — two-step workflow wiring', () => {
  it('Step 1 shows only Submission Time, Form and Assignment; Search/Source/Campaign/Ad are gone', () => {
    for (const label of [
      'Submission Time',
      'meta-export-form',
      'meta-export-assignee',
    ]) {
      expect(src).toContain(label);
    }
    for (const removed of [
      'meta-export-search',
      'meta-export-source',
      'meta-export-campaign',
      'meta-export-ad',
      'Lead Source',
      'All Campaigns',
      'All Ads',
      "qs.set('search'",
      'setSearch',
    ]) {
      expect(src).not.toContain(removed);
    }
    expect(src).toContain('Clear All');
    expect(src).toContain('Next: Select Columns');
  });

  it('never renders the internal __all value; All Forms leads with counts', () => {
    // The old self-closing trigger rendered the raw select value
    // (`__all`) instead of a label — it must stay gone.
    expect(src).not.toContain('<SelectValue placeholder="All forms" />');
    expect(src).not.toContain('>__all<');
    expect(src).not.toContain('>{__all}<');
    // The trigger shows an explicit label, not the raw value.
    expect(src).toContain('{formTriggerLabel}');
    expect(src).toContain('All Forms${formatFormCountsSuffix(allCounts)}');
    // First option stays All Forms; every form shows both counts
    // (suffix text itself is asserted in form-counts.test.ts).
    expect(src).toContain('<SelectItem value="__all">{allFormsLabel}');
    expect(src).toContain('formatFormCountsSuffix(allCounts)');
    expect(src).toContain('formatFormCountsSuffix(formCounts?.[f.flowId])');
    expect(src).toContain('formatFormCountsSuffix(formCounts?.[formFilter])');
  });

  it('Step-1 counts refresh when Submission Time or Assignment changes', () => {
    expect(src).toContain("qs.set('counts', '1')");
    expect(src).toContain('normalizeFormCountsResponse');
    // The counts effect is keyed on the dialog filters (never on search).
    const fxStart = src.indexOf('setAllCounts(null);');
    const fxEnd = src.indexOf('const clearAll', fxStart);
    const fx = src.slice(fxStart, fxEnd);
    for (const dep of [
      'preset',
      'customFrom',
      'customTo',
      'assignee',
      'formIdsKey',
    ]) {
      expect(fx).toContain(dep);
    }
    expect(fx).not.toContain('search');
    expect(src).toContain('setFormCounts(normalized.byFlowId)');
    expect(src).toContain('setAllCounts(normalized.all)');
    // Counts never reach the export request.
    const buildStart = src.indexOf('const buildFilterParams');
    const buildEnd = src.indexOf('const handleNext');
    const build = src.slice(buildStart, buildEnd);
    expect(build).not.toContain('counts');
    expect(build).not.toContain('search');
  });

  it('Form dropdown menu sizes to long names and wraps instead of truncating', () => {
    // max-content width with the trigger as the floor, capped at the viewport.
    expect(src).toContain("width: 'max-content'");
    expect(src).toContain("minWidth: 'var(--anchor-width)'");
    expect(src).toContain('max-w-[calc(100vw-2rem)]');
    // Long form names wrap onto multiple lines; full name on hover.
    expect(src).toContain('[&>span]:whitespace-normal');
    expect(src).toContain('[&>span]:break-words');
    expect(src).toContain('title={`${f.tableName}');
  });

  it('Step 1 ends with Next (not Download); Download lives in Step 2', () => {
    expect(src).toContain('Next: Select Columns');
    // handleExport is wired exactly once: the Step 2 Download button.
    expect(src.match(/onClick=\{handleExport\}/g) ?? []).toHaveLength(0);
    expect(src.match(/onDownload=\{handleExport\}/g) ?? []).toHaveLength(1);
  });

  it('Next loads the column list for the selected table/form scope', () => {
    expect(src).toContain("qs.set('columns', '1')");
    expect(src).toContain('loadedScope');
    // Form scope is included for the All view.
    expect(src).toContain("qs.set('formId', formFilter)");
  });

  it('Back returns without resetting filters or the column selection', () => {
    const start = src.indexOf('const handleBack');
    const end = src.indexOf('const handleToggleColumn');
    const back = src.slice(start, end);
    expect(back).toContain('setStep(1)');
    expect(back).not.toContain('setSelected');
    expect(back).not.toContain('setColumns');
    expect(back).not.toContain('setPreset');
  });

  it('Step 2 renders the column-selection panel with dialog wiring', () => {
    expect(src).toContain('<MetaExportColumnsStep');
    expect(src).toContain('selected={selected}');
    expect(src).toContain('onDownload={handleExport}');
    expect(src).toContain('onBack={handleBack}');
    expect(src).toContain('onToggleGroup={handleToggleGroup}');
    expect(src).toContain('onToggleColumn={handleToggleColumn}');
    expect(src).toContain('onSelectAll={handleSelectAll}');
    expect(src).toContain('onDeselectAll={handleDeselectAll}');
  });

  it('download sends filters plus selected column keys in canonical order', () => {
    expect(src).toContain('orderedSelectedKeys(columns, selected)');
    expect(src).toContain("qs.append('col', key)");
    // Empty selection is blocked client-side before any request.
    expect(src).toContain('Select at least one column');
  });

  it('unavailable columns never reach the workbook request', () => {
    // handleExport only ever sends keys derived from the loaded list.
    expect(src).toContain('if (!tableId || !columns) return;');
  });

  it('dialog widens for Step 2 and resets on open', () => {
    expect(src).toContain('sm:max-w-3xl');
    expect(src).toContain('setStep(1)');
    expect(src).toContain('setSelected(new Set())');
  });
});
