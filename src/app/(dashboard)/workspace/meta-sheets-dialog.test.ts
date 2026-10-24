// Workspace Meta tables — per-table Google Sheets configuration.
//
// Source assertions (the page is too heavy to render here, following
// the columns-menu test pattern). Pins that:
//   * a "Configure Sheet" action sits next to the table selector,
//     rendered ONLY for Meta Lead Ads tables and only for admins;
//   * Flow Tables keep exactly what they had (no sheet action);
//   * the dialog is keyed by the selected flow so switching tables
//     loads that table's own settings and never overwrites another
//     table's configuration.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const page = () =>
  readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, 'utf8');
const dialog = () =>
  readFileSync(
    `${root}/src/components/workspace/meta-table-sheets-dialog.tsx`,
    'utf8'
  );

describe('workspace page — per-table Google Sheets action', () => {
  it('shows Configure Sheet only for Meta tables and only for admins', () => {
    const src = page();
    expect(src).toContain('Configure Sheet');
    expect(src).toContain('isMetaTable && canEditSettings && flowId');
    expect(src).toContain('setSheetDialogOpen(true)');
  });

  it("keys the dialog by flow so switching tables loads that table's settings", () => {
    const src = page();
    expect(src).toContain('MetaTableSheetsDialog');
    expect(src).toContain('key={flowId}');
    expect(src).toContain('flowId={flowId}');
    expect(src).toContain('open={sheetDialogOpen}');
  });

  it('keeps Flow Tables exactly as before (no sheet action, no gating change)', () => {
    const src = page();
    // The completion-tabs gate is untouched; the sheet button lives
    // inside the isMetaTable branch only.
    expect(src).toContain('{isMetaTable ? null : (');
    expect(src).toContain('Configure Sheet');
    const buttonIdx = src.indexOf('Configure Sheet');
    const metaGateIdx = src.lastIndexOf('isMetaTable', buttonIdx);
    expect(metaGateIdx).toBeGreaterThan(-1);
  });
});

describe('workspace dialog — per-table sheets configuration', () => {
  it('loads and saves through the table-scoped endpoints', () => {
    const src = dialog();
    expect(src).toContain(
      '/sheets/tables/${encodeURIComponent(flowId)}/config'
    );
    expect(src).toContain('/sheets/tables/${encodeURIComponent(flowId)}/retry');
    expect(src).not.toContain('sheets/config');
    expect(src).not.toContain('sheets/fields');
  });

  it('discovers tabs, defaults to the first, and never auto-creates silently', () => {
    const src = dialog();
    expect(src).toContain('/sheets/tabs?spreadsheet_id=');
    expect(src).toContain('Load tabs');
    expect(src).toContain('Create the tab if missing');
    expect(src).not.toContain('ensureSheetsTab');
  });

  it('offers per-table cleanup with explicit confirmation only', () => {
    const src = dialog();
    expect(src).toContain(
      '/sheets/tables/${encodeURIComponent(flowId)}/cleanup'
    );
    expect(src).toContain('confirmed: true');
    expect(src).toContain('window.confirm');
  });

  it('never touches Flow Tables helpers or tokens', () => {
    const src = dialog();
    expect(src).not.toContain('google_connections');
    expect(src).not.toContain('@/lib/flows/sheet-');
    expect(src).not.toContain('access_token');
    expect(src).not.toContain('refresh_token');
  });
});
