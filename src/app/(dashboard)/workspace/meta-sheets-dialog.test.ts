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
  it('shows Configure Sheet only for Meta tables and only for the owner', () => {
    const src = page();
    expect(src).toContain('Configure Sheet');
    // Owner-only: admins, agents, and viewers never see the sheet
    // actions (the APIs enforce the same rule server-side).
    expect(src).toContain('isMetaTable && isOwner && flowId');
    expect(src).not.toContain('isMetaTable && canEditSettings && flowId');
    expect(src).toContain('setSheetDialogOpen(true)');
  });

  it('refreshes the Open Sheet URL when the dialog closes (no stale sheet)', () => {
    const src = page();
    // The per-table URL effect re-runs when the dialog closes, so a
    // spreadsheet created + saved inside the dialog takes effect
    // immediately without a page refresh. The previous URL is
    // cleared first, and the request stays scoped to the selected
    // table (never another table's configuration).
    expect(src).toContain('setSheetUrl(null)');
    expect(src).toContain('/sheets/tables/${encodeURIComponent(flowId)}/config');
    expect(src).toContain('[isMetaTable, isOwner, flowId, sheetDialogOpen]');
  });

  it('saves the created spreadsheet URL to the selected table’s configuration', () => {
    const dialogSrc = dialog();
    // Create Spreadsheet fills the URL field from the response
    // (coerced: bare id fallback, never undefined)…
    expect(dialogSrc).toContain('setSpreadsheet(createdUrl');
    // …and Save Configuration persists that exact field value for
    // this table (flowId-scoped endpoint), so Open Sheet later
    // reads back the newly configured spreadsheet.
    expect(dialogSrc).toContain('spreadsheet_url: spreadsheet.trim()');
    expect(dialogSrc).toContain('/sheets/tables/${encodeURIComponent(flowId)}/config');
  });

  it('groups Configure Sheet and Open Sheet in one compact right-aligned group', () => {
    const src = page();
    // One wrapping group with a single 8px gap (gap-2) holds both
    // buttons together — no excessive separation, still responsive.
    expect(src).toContain('<div className="flex shrink-0 items-center gap-2">');
    const groupIdx = src.indexOf('<div className="flex shrink-0 items-center gap-2">');
    const configIdx = src.indexOf('Configure Sheet');
    const openIdx = src.indexOf('Open Sheet');
    expect(configIdx).toBeGreaterThan(groupIdx);
    expect(openIdx).toBeGreaterThan(configIdx);
    // Styling, icons, and labels are unchanged.
    expect(src).toContain('Table2');
    expect(src).toContain('ExternalLink');
  });

  it('shows Open Sheet only for the owner with this table’s saved URL, in a new tab', () => {
    const src = page();
    expect(src).toContain('Open Sheet');
    // Same owner + Meta + table gate as Configure Sheet (which
    // remains as the path when no spreadsheet is configured).
    expect(src).toContain('isMetaTable && isOwner && flowId');
    expect(src).toContain('setSheetDialogOpen(true)');
    // Per-table saved URL: refetched when the selected table
    // changes (previous URL cleared first), resolved through the
    // shared helper, opened in a new tab — never another table.
    expect(src).toContain('setSheetUrl(null)');
    expect(src).toContain('/sheets/tables/${encodeURIComponent(flowId)}/config');
    expect(src).toContain('resolveSpreadsheetOpenUrl');
    expect(src).toContain("{sheetUrl ? (");
    expect(src).toContain("window.open(sheetUrl, '_blank', 'noopener,noreferrer')");
    // The button lives inside the Meta-only branch: the last
    // isMetaTable gate before it guards both sheet actions.
    const buttonIdx = src.indexOf('Open Sheet');
    const metaGateIdx = src.lastIndexOf('isMetaTable', buttonIdx);
    expect(metaGateIdx).toBeGreaterThan(-1);
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
    expect(src).toContain('/sheets/tables/${encodeURIComponent(flowId)}/import');
    expect(src).not.toContain('sheets/config');
    expect(src).not.toContain('sheets/fields');
  });

  it('replaces Sync now with an Import Leads workflow (not a rename)', () => {
    const src = dialog();
    expect(src).not.toContain('Sync now');
    expect(src).not.toContain('syncNow');
    // The table retry endpoint is used ONLY to revive failed rows
    // (revive_failed), never as a sync-now trigger.
    expect(src).toContain('revive_failed');
    expect(src).toContain('Retry failed');
    // Import entry point beside Save Configuration.
    expect(src).toContain('Import Leads');
    expect(src).toContain('startImport');
    // Compact options dialog: all leads vs inclusive date range,
    // with explicit start and cancel controls.
    expect(src).toContain('Import All Leads');
    expect(src).toContain('Import Leads by Date Range');
    expect(src).toContain('Start date');
    expect(src).toContain('End date');
    expect(src).toContain('Start Import');
    expect(src).toContain('Cancel');
    // Loading progress and a completion summary with all four counts.
    expect(src).toContain('Importing leads');
    expect(src).toContain('imported,');
    expect(src).toContain('updated,');
    expect(src).toContain('skipped,');
    // Automatic sync control is untouched.
    expect(src).toContain('Automatic sync for new + updated leads');
  });

  it('discovers tabs, defaults to the first, and never auto-creates silently', () => {
    const src = dialog();
    expect(src).toContain('/sheets/tabs?spreadsheet_id=');
    expect(src).toContain('Load tabs');
    // Tabs are never created implicitly: no "create if missing"
    // checkbox — only the explicit Create tab control (server-side
    // the save always sends create_tab: false).
    expect(src).not.toContain('Create the tab if missing');
    expect(src).toContain('Create a new worksheet tab');
    expect(src).toContain('create_tab: false');
    expect(src).not.toContain('ensureSheetsTab');
  });

  it('keeps a compact footer: primary save, import action, auto-sync default, danger zone', () => {
    const src = dialog();
    // Save Configuration stays the primary button; Import Leads
    // sits beside it (Sync now is gone).
    expect(src).toContain('Save Configuration');
    expect(src).toContain('Import Leads');
    // Automatic sync stays enabled by default as a compact setting.
    expect(src).toContain('Automatic sync for new + updated leads');
    expect(src).toContain('Enable automatic sync');
    // No separate import checkbox: first-time saves auto-import
    // server-side; re-saves never re-import.
    expect(src).not.toContain('Import existing leads on save');
    expect(src).not.toContain('importExisting');
    expect(src).not.toContain('import_existing');
    // Destructive removal lives in a labeled danger zone with the
    // existing confirmation, outside the main action row.
    expect(src).toContain('Danger zone');
    expect(src).toContain('Remove {managedRows} synced row');
    expect(src).toContain('window.confirm');
  });

  it('offers per-table cleanup with explicit confirmation only', () => {
    const src = dialog();
    expect(src).toContain(
      '/sheets/tables/${encodeURIComponent(flowId)}/cleanup'
    );
    expect(src).toContain('confirmed: true');
    expect(src).toContain('window.confirm');
  });

  it('creates a worksheet tab explicitly, then refreshes and selects it', () => {
    const src = dialog();
    expect(src).toContain('Create a new worksheet tab');
    expect(src).toContain('Create tab');
    expect(src).toContain('createNewTab');
    expect(src).toContain('validateWorksheetTabName');
    // POSTs the single requested tab; the response refreshes the
    // list and selects the new tab automatically.
    expect(src).toContain("method: 'POST'");
    expect(src).toContain('setTab(json.tab)');
    expect(src).toContain('setTabTouched(true)');
    // Duplicates are rejected client-side (case-insensitive) and
    // server-side (409); Load tabs behavior is preserved.
    expect(src).toContain('already exists');
    expect(src).toContain('Load tabs');
  });

  it('deletes only the selected tab after confirmation and clears it', () => {
    const src = dialog();
    expect(src).toContain('Delete tab');
    expect(src).toContain('deleteSelectedTab');
    expect(src).toContain('window.confirm');
    expect(src).toContain('Delete worksheet tab');
    // DELETE targets the explicit tab; the refreshed list replaces
    // state and the selection clears only when it was deleted.
    expect(src).toContain("method: 'DELETE'");
    expect(src).toContain('setTabs(json.tabs)');
    expect(src).toContain("setTab('')");
    // Never automatic: no delete call outside the confirmed handler,
    // and saving/syncing never deletes tabs.
    expect(src).not.toContain('deleteWorksheetTab');
  });

  it('default-selects every Workspace header once for new configs, preserves saved ones', () => {
    const src = dialog();
    expect(src).toContain('defaultSheetsColumns');
    expect(src).toContain('dedupeSheetsColumns');
    expect(src).toContain('json.selectedColumns');
    // Explicit selections load verbatim (even ID-first); anything
    // else — new or legacy-default rows — gets the ID-last default.
    expect(src).toContain('json.hasCustomColumns');
    expect(src).toContain('never silently replaced');
    expect(src).toContain('defaultSheetsColumns({');
  });

  it('hides equivalent twin columns by stable key, never by label', () => {
    const src = dialog();
    // Twins (Full name/Phone number) are suppressed wherever the
    // standard counterpart (Name/Phone) is offered — in the
    // Workspace-derived list, the form-answers group, defaults,
    // and save normalization.
    expect(src).toContain('withoutShadowedDynamicColumns');
    expect(src).toContain('dedupeEquivalentColumns');
    // The form-answers group filters twins against the offered
    // standard keys; saving normalizes twins into their standard
    // counterpart. Both are key-based (equivalentStandardKey in
    // columns.ts) — a custom question that merely looks similar
    // keeps its own entry.
    expect(src).toContain('withoutShadowedDynamicColumns(');
    expect(src).toContain('dedupeEquivalentColumns(');
  });

  it('places Load tabs beside the Worksheet tab input in one row', () => {
    const src = dialog();
    // The button sits in the Worksheet tab row (after its label,
    // before the new-tab controls), vertically centered with the
    // tab input/select; the URL input stays on the left, unchanged.
    const tabLabelIdx = src.indexOf('Worksheet tab');
    const loadTabsIdx = src.indexOf('Load tabs');
    const newTabIdx = src.indexOf('Create a new worksheet tab');
    expect(tabLabelIdx).toBeGreaterThan(-1);
    expect(loadTabsIdx).toBeGreaterThan(tabLabelIdx);
    expect(newTabIdx).toBeGreaterThan(loadTabsIdx);
    // The URL row keeps only its input + Open Spreadsheet action.
    const urlRow = src.slice(
      src.indexOf('meta-table-sheets-url'),
      src.indexOf('meta-table-sheets-tab')
    );
    expect(urlRow).toContain('Open Spreadsheet');
    expect(urlRow).not.toContain('Load tabs');
    // Shared row pattern: control flexes (min-w-0) while the button
    // keeps its width, so nothing overlaps or squeezes on narrow
    // screens.
    expect(src).toContain('className="flex items-center gap-2"');
    expect(src).toContain('className="min-w-0 flex-1"');
    expect(src).toContain('className="shrink-0"');
    expect(src).toContain('aria-label="Load worksheet tabs"');
    // Functionality and loading state are unchanged.
    expect(src).toContain("disabled={busy === 'tabs'}");
    expect(src).toContain('loadTabs(spreadsheet)');
  });

  it('numbers every selected column by position (Meta Lead ID reorders like the rest)', () => {
    const src = dialog();
    // No special-cased "A" badge: the position badge follows the
    // configured order for every column, including the ID.
    expect(src).toContain('{idx + 1}');
    expect(src).not.toContain("? 'A'");
    // Reordering is fully generic — the ID moves up/down with the
    // same controls and no key-specific guards.
    expect(src).toContain('moveColumn(col.key, -1)');
    expect(src).toContain('moveColumn(col.key, 1)');
    expect(src).toContain('disabled={idx === 0}');
  });

  it('has no Header preview box; column controls remain intact', () => {
    const src = dialog();
    expect(src).not.toContain('Header preview');
    expect(src).not.toContain('previewHeaders');
    expect(src).not.toContain('headers.join');
    // Column selection, reorder, rename, and removal are unchanged.
    expect(src).toContain('addColumn');
    expect(src).toContain('moveColumn');
    expect(src).toContain('renameColumn');
    expect(src).toContain('removeColumn');
    expect(src).toContain('Selected columns (in sheet order)');
    expect(src).toContain('Available columns');
  });

  it('closes the dialog on successful save, keeps it open on failure', () => {
    const src = dialog();
    // Slice the save handler (up to the next handler) so the pins
    // apply to Save Configuration only — Import, Create
    // Spreadsheet, Create/Delete tab, and cleanup are untouched.
    const saveFn = src.slice(src.indexOf('function save()'), src.indexOf('function startImport()'));
    expect(saveFn).toContain('toast.success');
    expect(saveFn).toContain('onOpenChange(false)');
    // Validation errors return before the request — dialog stays open.
    expect(saveFn).toContain('Paste a Google Sheets URL or spreadsheet ID.');
    // Duplicate submissions are blocked while saving.
    expect(src).toContain("disabled={busy === 'save'}");
    for (const other of [
      'function startImport()',
      'function createSpreadsheet()',
      'function createNewTab()',
      'function deleteSelectedTab()',
      'function cleanupTable()',
    ]) {
      const start = src.indexOf(other);
      expect(start).toBeGreaterThan(-1);
      const nextFn = src.indexOf('\n  function ', start + 1);
      const body = nextFn === -1 ? src.slice(start) : src.slice(start, nextFn);
      expect(body).not.toContain('onOpenChange(false)');
    }
  });

  it('opens the saved spreadsheet in a new tab from the dialog', () => {
    const src = dialog();
    expect(src).toContain('Open Spreadsheet');
    expect(src).toContain('ExternalLink');
    // Saved configuration only — never the unsaved text field.
    expect(src).toContain('savedSpreadsheetUrl');
    expect(src).toContain('status?.spreadsheetUrl');
    expect(src).toContain('resolveSpreadsheetOpenUrl');
    expect(src).toContain("window.open(");
    expect(src).toContain("'_blank'");
    expect(src).toContain("'noopener,noreferrer'");
    // Disabled until a spreadsheet is saved.
    expect(src).toContain('disabled={!savedSpreadsheetUrl}');
  });

  it('creates a spreadsheet on demand, populates the URL, and selects the first tab', () => {
    const src = dialog();
    expect(src).toContain('Create Spreadsheet');
    expect(src).toContain('createSpreadsheet');
    expect(src).toContain('/sheets/spreadsheets');
    // Populates the URL field and selects the first tab without
    // touching columns or starting a sync.
    expect(src).toContain('setSpreadsheet(createdUrl');
    expect(src).toContain('setTab(createdTabs[0]');
    expect(src).toContain('setTabTouched(true)');
    expect(src).toContain('Nothing');
    expect(src).toContain('syncs until you save');
  });

  it('never touches Flow Tables helpers or tokens', () => {
    const src = dialog();
    expect(src).not.toContain('google_connections');
    expect(src).not.toContain('@/lib/flows/sheet-');
    expect(src).not.toContain('access_token');
    expect(src).not.toContain('refresh_token');
  });

  it('tolerates malformed create responses without breaking the form', () => {
    const src = dialog();
    const fn = src.slice(src.indexOf('function createSpreadsheet()'));
    // Coerced, never trusted verbatim: a missing URL falls back to
    // the bare id (or empty — never undefined), and non-array tabs
    // degrade to an empty list instead of crashing the selector.
    expect(fn).toContain('Array.isArray(json.tabs)');
    expect(fn).toContain("typeof json.url === 'string'");
    expect(fn).toContain('Spreadsheet "');
  });

  it('opens the persisted table spreadsheet, never a stale or foreign URL', () => {
    const src = dialog();
    // The icon reads the saved config (status), never the editable
    // text field and never another table: switching tables remounts
    // the dialog by flow key and every fetch is flowId-scoped.
    expect(src).toContain('savedSpreadsheetUrl');
    expect(src).toContain('status?.spreadsheetUrl');
    expect(src).not.toContain('window.open(spreadsheet,');
    // ID fallback when no URL was saved; invalid values hide the
    // button instead of opening the wrong sheet.
    expect(src).toContain('spreadsheetId: status?.spreadsheetId');
    expect(src).toContain('resolveSpreadsheetOpenUrl');
    expect(src).toContain('disabled={!savedSpreadsheetUrl}');
    expect(src).toContain('window.open(');
    expect(src).toContain('savedSpreadsheetUrl,');
    expect(src).toContain("'_blank'");
    expect(src).toContain("'noopener,noreferrer'");
  });
});
