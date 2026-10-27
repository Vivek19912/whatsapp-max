// Workspace single actions menu — render + source pins.
//
// The Workspace toolbar exposes exactly one permanently visible
// control (a Settings/Actions icon button); every secondary action
// lives in its grouped popover. Closed-state SSR proves the single
// trigger renders with its accessible label while no panel content
// leaks; source pins cover the grouped items, handlers, and the
// collision-aware/viewport-bounded panel contract.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkspaceActionsMenu } from './workspace-actions-menu';
import { WorkspaceFilters } from './workspace-filters';
import { ALL_ASSIGNEES, emptyColumnFilters } from '@/lib/flows/workspace-filters';

const root = process.cwd();
const menuSrc = () =>
  readFileSync(
    `${root}/src/components/workspace/workspace-actions-menu.tsx`,
    'utf8'
  );
const pageSrc = () =>
  readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, 'utf8');
const filtersSrc = () =>
  readFileSync(
    `${root}/src/components/workspace/workspace-filters.tsx`,
    'utf8'
  );
const tokensSrc = () =>
  readFileSync(
    `${root}/src/components/workspace/workspace-tokens.ts`,
    'utf8'
  );

function filtersTriggerHtml() {
  // The Filters popover panel portals away in SSR, leaving exactly
  // the trigger button — the row the menu shows.
  return renderToStaticMarkup(
    <WorkspaceFilters
      members={[]}
      appliedDate={null}
      appliedAssignee={ALL_ASSIGNEES}
      appliedColumns={emptyColumnFilters()}
      columnOptions={{
        callStatus: [],
        followUpStatus: [],
        lastContactDate: false,
        nextFollowUp: false,
      }}
      onApply={() => {}}
    />
  );
}

function closedMenu() {
  return renderToStaticMarkup(
    <WorkspaceActionsMenu
      filters={<button type="button">Filters</button>}
      columns={<button type="button">Columns</button>}
      canAddColumn
      onAddColumn={() => {}}
      showAutoSend
      onOpenAutoSend={() => {}}
      showAssignment
      onOpenAssignment={() => {}}
    />
  );
}

describe('workspace actions menu trigger (single visible control)', () => {
  it('renders exactly one icon button with an accessible label', () => {
    const html = closedMenu();
    expect(html).toContain('aria-label="Workspace actions"');
    expect(html).toContain('title="Workspace actions"');
    expect(html).toContain('Workspace actions');
    expect(html).toContain('<svg');
    // The SlidersHorizontal icon is the only trigger affordance.
    expect(html).not.toContain('Filters');
    expect(html).not.toContain('Columns');
    expect(html).not.toContain('Assignment');
    expect(html).not.toContain('Auto-send WhatsApp');
    expect(html).not.toContain('Add Column');
    expect(html).not.toContain('Configure Sheet');
    expect(html).not.toContain('Open Sheet');
  });

  it('exposes popover trigger semantics for hover, focus, and keyboard users', () => {
    const src = menuSrc();
    expect(src).toContain('PopoverTrigger');
    expect(src).toContain('aria-expanded={open}');
    // Shared workspace control token carries the h-9 hit target,
    // hover state, and focus-visible ring; the trigger is a native
    // keyboard-focusable button.
    expect(src).toContain('WS_CONTROL_BUTTON');
    expect(src).toContain('type="button"');
    expect(src).toContain('SlidersHorizontal');
  });
});

describe('workspace actions menu panel (grouped, bounded, collision-aware)', () => {
  it('groups table tools and automation under clear headings', () => {
    const src = menuSrc();
    expect(src).toContain('Table tools');
    expect(src).toContain('Automation');
    expect(src).toContain('aria-label="Table tools"');
    expect(src).toContain('aria-label="Automation & assignment"');
  });

  it('keeps every listed action with its icon and handler', () => {
    const src = menuSrc();
    // Dialog actions close the menu, then run the existing
    // page-level opener — the dialogs mount outside the menu.
    expect(src).toContain('Add Column');
    expect(src).toContain('Auto-send WhatsApp');
    expect(src).toContain('Assignment');
    expect(src).toContain('onAddColumn');
    expect(src).toContain('onOpenAutoSend');
    expect(src).toContain('onOpenAssignment');
    expect(src).toContain('setOpen(false)');
    expect(src).toContain('Plus');
    expect(src).toContain('MessageCircle');
    expect(src).toContain('UserPlus');
    // Panel tools reuse the caller's wired components (slots) —
    // no duplicated business logic.
    expect(src).toContain('filters');
    expect(src).toContain('columns');
    expect(src).toContain('hiddenRows');
    expect(src).toContain('travelCrmSettings');
  });

  it('stays collision-aware and scrolls within the viewport', () => {
    const src = menuSrc();
    expect(src).toContain('PopoverContent');
    expect(src).toContain('align="end"');
    expect(src).toContain('collisionPadding');
    expect(src).toContain('overflow-y-auto');
    expect(src).toContain('92vw');
    expect(src).toContain('70vh');
  });

  it('never reintroduces sheet actions or a second overflow menu', () => {
    const src = menuSrc();
    expect(src).not.toContain('Configure Sheet');
    expect(src).not.toContain('Open Sheet');
    expect(src).not.toContain('sheet-config');
    expect(src).not.toContain('open-sheet');
    expect(src).not.toContain('More actions');
    expect(src).not.toContain('WorkspaceToolbar');
  });
});

describe('filters menu row (icon + label alignment)', () => {
  it('renders the icon and label in one left-aligned row', () => {
    const html = filtersTriggerHtml();
    // One trigger button: fixed-size icon followed by the label.
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(html).toContain('<svg');
    expect(html).toContain('Filters');
    const iconIdx = html.indexOf('<svg');
    const labelIdx = html.indexOf('>Filters<');
    expect(iconIdx).toBeGreaterThan(-1);
    expect(labelIdx).toBeGreaterThan(iconIdx);
    // Single-row flex layout: same h-9 height, border, radius,
    // typography, and hover treatment as the other menu rows —
    // left-justified with no wrapping or centering.
    for (const cls of [
      'inline-flex',
      'items-center',
      'h-9',
      'rounded-lg',
      'border',
      'px-2.5',
      'text-sm',
      'hover:bg-muted',
      'justify-start',
      'whitespace-nowrap',
    ]) {
      expect(html).toContain(cls);
    }
  });

  it('fixes the layout in the shared token, not with per-row overrides', () => {
    // WS_CONTROL_BUTTON carries the flex row (gap only works in a
    // flex context); the preflight block-level svg otherwise drops
    // the icon onto its own line with a centered label.
    expect(tokensSrc()).toContain('inline-flex h-9 items-center gap-1.5');
    // The Filters trigger keeps only alignment guards consistent
    // with the other rows — no bespoke layout reinvention.
    expect(filtersSrc()).toContain('justify-start whitespace-nowrap');
  });

  it('preserves the filter count, state, handlers, and panel behavior', () => {
    const html = filtersTriggerHtml();
    // Accessible label + fixed-size non-shrinking icon.
    expect(html).toContain('aria-label="Filter table"');
    expect(html).toContain('h-4 w-4');
    expect(html).toContain('shrink-0');
    const src = filtersSrc();
    // Count badge, draft state, popover wiring, and Apply/Clear
    // actions are untouched.
    expect(src).toContain('activeCount');
    expect(src).toContain('handleOpenChange');
    expect(src).toContain('Popover');
    expect(src).toContain('PopoverContent');
    expect(src).toContain('handleApply');
    expect(src).toContain('handleClearAll');
  });
});

describe('workspace page wires every tool through the single menu', () => {
  it('passes the existing handlers and permission gates into the menu', () => {
    const src = pageSrc();
    expect(src).toContain('<WorkspaceActionsMenu');
    // Table-tool slots keep their props, state, and API contracts.
    expect(src).toContain('filters={');
    expect(src).toContain('<WorkspaceFilters');
    expect(src).toContain('columns={');
    expect(src).toContain('<ColumnsMenu');
    expect(src).toContain('hiddenRows={');
    expect(src).toContain('<HiddenRowsMenu');
    expect(src).toContain('travelCrmSettings={');
    expect(src).toContain('<TravelCrmSettings');
    // Same gates as the previously visible buttons.
    expect(src).toContain('canAddColumn={canEditSettings}');
    expect(src).toContain('showAutoSend={isMetaTable && isOwner}');
    expect(src).toContain('showAssignment={isOwner}');
    expect(src).toContain('setWhatsappDialogOpen(true)');
    expect(src).toContain('setAssignmentDialogOpen(true)');
    expect(src).toContain('setAddColumnOpen(true)');
  });

  it('keeps the selector and search visible with no other toolbar buttons', () => {
    const src = pageSrc();
    expect(src).toContain('<WorkspaceTableSelector');
    expect(src).toContain('<WorkspaceSearchField');
    // Exactly one menu instance; the old inline toolbar (with its
    // mobile overflow) is gone from the page.
    expect(src).toContain('<WorkspaceActionsMenu');
    expect(src).not.toContain('<WorkspaceToolbar');
    expect(src).not.toContain('More actions');
  });
});
