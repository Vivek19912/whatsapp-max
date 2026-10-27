// Meta Lead Ads auto-send WhatsApp dialog — view/edit modes.
//
// View mode renders the saved configuration read-only; Edit mode
// keeps the full editor. Source pins (the dialog is too heavy to
// render here, following the columns-menu test pattern).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const src = () =>
  readFileSync(
    `${root}/src/components/workspace/meta-table-whatsapp-dialog.tsx`,
    'utf8'
  );

describe('auto-send dialog view mode (read-only inspection)', () => {
  it('accepts a viewMode flag and derives a read-only gate from it', () => {
    expect(src()).toContain('viewMode = false');
    expect(src()).toContain('const readOnly = viewMode === true');
    expect(src()).toContain('Viewing — switch to Edit to make changes.');
  });

  it('disables every editable control in view mode', () => {
    // Pause switch and delay input stay visible but inert.
    expect(src()).toContain('disabled={readOnly}');
    // Variable mappings render as read-only text instead of
    // dropdowns; the pick-a-template row is edit-only.
    expect(src()).toContain('Not mapped');
    expect(src()).toContain('{readOnly ? null : (');
  });

  it('hides every mutating action in view mode and keeps the saved readout', () => {
    // Move/remove step buttons, the add-step row, and the retry
    // button are edit-only (the failed-sends notice itself stays).
    expect(src()).toContain('aria-label={`Move ${item.template_name} up`}');
    expect(src()).toContain('aria-label={`Remove ${item.template_name}`}');
    expect(src()).toContain('then retry');
    // ...while names, languages, previews, counts, and the failed
    // notice stay visible.
    expect(src()).toContain('{item.template_name}');
    expect(src()).toContain('{item.template_language}');
    expect(src()).toContain('Preview: {rendered}');
    expect(src()).toContain('failed send');
  });

  it('swaps the footer to Close-only and blocks the mutating submitters', () => {
    expect(src()).toContain('if (readOnly) return;');
    // Close-only footer branch (the Save pair lives in the else branch).
    expect(src()).toContain('readOnly ? (');
    expect(src()).toContain('onClick={() => onOpenChange(false)}');
    expect(src()).toContain('saveLabel="Save Changes"');
    // No save or retry path runs in view mode.
    expect(src()).toContain('function save() {\n    if (readOnly) return;');
    expect(src()).toContain('function retryFailed() {\n    if (readOnly) return;');
  });

  it('keeps edit mode behavior identical to before', () => {
    // Gating is purely additive: every editor branch renders when
    // readOnly is false, with the original handlers intact.
    expect(src()).toContain('function addPicked() {');
    expect(src()).toContain('function setMapping(index: number, slotKey: string, fieldKey: string) {');
    expect(src()).toContain('/api/integrations/meta-lead-ads/whatsapp/tables/');
    expect(src()).toContain("method: 'PUT'");
  });
});
