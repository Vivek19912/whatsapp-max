// Workspace Meta tables — per-table Google Sheets configuration.
//
// The visible "Configure Sheet" / "Open Sheet" toolbar entry points
// were removed from the Workspace UI (UI-only cleanup), and the
// remaining actions now live behind a single actions menu; the
// per-table configuration dialog, its table-scoped endpoints, and
// the Flow Tables behavior are preserved. Source assertions pin
// that removal while keeping the backend/dialog contract intact.

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
const menu = () =>
  readFileSync(
    `${root}/src/components/workspace/workspace-actions-menu.tsx`,
    'utf8'
  );

describe('workspace page — per-table Google Sheets action', () => {
  it('no longer shows Configure Sheet in the Workspace UI (dialog preserved)', () => {
    const src = page();
    // Sheet entry points stay removed after the toolbar consolidation:
    // the actions menu carries only the non-sheet actions, and the
    // dialog component stays mounted so the saved configuration and
    // backend are untouched.
    expect(src).not.toContain("key: 'sheet-config'");
    expect(src).not.toContain("label: 'Configure Sheet'");
    expect(src).not.toContain('WorkspaceToolbar');
    expect(src).toContain('WorkspaceActionsMenu');
    expect(src).toContain('MetaTableSheetsDialog');
    expect(src).toContain('open={sheetDialogOpen}');
    expect(menu()).not.toContain('Configure Sheet');
  });

  it('no longer keeps a toolbar Open Sheet URL state (dialog owns its config)', () => {
    const src = page();
    // The toolbar no longer tracks a per-table spreadsheet URL:
    // the configuration dialog loads/saves through its own
    // table-scoped endpoints.
    expect(src).not.toContain("label: 'Open Sheet'");
    expect(src).not.toContain("key: 'open-sheet'");
    expect(src).not.toContain('setSheetUrl(null)');
    expect(src).not.toContain('isMetaTable && sheetUrl');
    expect(src).not.toContain('resolveSpreadsheetOpenUrl');
    expect(src).not.toContain("window.open(sheetUrl, '_blank', 'noopener,noreferrer')");
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

  it('keeps the actions menu free of sheet entry points', () => {
    // The single actions menu groups the remaining tools under
    // Table tools / Automation headings with its own icon trigger —
    // no sheet actions, no second overflow menu.
    const menuSrc = menu();
    expect(menuSrc).toContain('Workspace actions');
    expect(menuSrc).toContain('Table tools');
    expect(menuSrc).toContain('Automation');
    expect(menuSrc).toContain('SlidersHorizontal');
    expect(menuSrc).toContain('Assignment');
    const src = page();
    // Removed entry points never appear in the page or the menu;
    // the page renders exactly one menu with the existing handlers.
    expect(src).not.toContain("label: 'Configure Sheet'");
    expect(src).not.toContain("label: 'Open Sheet'");
    expect(menuSrc).not.toContain("label: 'Configure Sheet'");
    expect(menuSrc).not.toContain("label: 'Open Sheet'");
    expect(menuSrc).not.toContain('More actions');
    expect(src).toContain('onOpenAssignment');
  });

  it('keeps the per-table sheets dialog mounted without a sheet menu action', () => {
    const src = page();
    // The dialog stays mounted (backend + configuration preserved);
    // only the entry points are gone.
    expect(src).toContain('MetaTableSheetsDialog');
    expect(src).toContain('open={sheetDialogOpen}');
    expect(src).not.toContain("key: 'open-sheet'");
    expect(src).not.toContain("label: 'Open Sheet'");
  });

  it("keys the dialog by flow so switching tables loads that table's settings", () => {
    const src = page();
    expect(src).toContain('MetaTableSheetsDialog');
    expect(src).toContain('key={flowId}');
    expect(src).toContain('flowId={flowId}');
    expect(src).toContain('open={sheetDialogOpen}');
  });

  it('keeps Flow Tables exactly as before (no sheet menu action, no gating change)', () => {
    const src = page();
    // The completion-tabs gate is untouched; the actions menu keeps
    // only the non-sheet per-table actions.
    expect(src).toContain('{isMetaTable ? null : (');
    expect(src).not.toContain("key: 'sheet-config'");
    expect(src).not.toContain("label: 'Configure Sheet'");
    expect(src).toContain('showAssignment');
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
    // The shared footer passes the saving state through and blocks
    // duplicate submissions while the save request is in flight.
    expect(src).toContain('saving={busy === ');
    expect(src).toContain('saveLabel="Save Configuration"');
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
      // The shared footer (rendered after all handlers) owns the
      // Close button — handler bodies must never close the dialog.
      const renderStart = src.indexOf('<ConfigDialog');
      const end = nextFn === -1 ? renderStart : Math.min(nextFn, renderStart);
      const body = src.slice(start, end);
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
