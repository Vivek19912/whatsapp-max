import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SETTINGS_SHEETS_LINKS,
  resolveSheetsOpen,
} from './settings-rail';

const root = process.cwd();
const railSrc = readFileSync(
  join(root, 'src/components/settings/settings-rail.tsx'),
  'utf8'
);
const settingsPageSrc = readFileSync(
  join(root, 'src/app/(dashboard)/settings/page.tsx'),
  'utf8'
);
const sidebarSrc = readFileSync(
  join(root, 'src/components/layout/sidebar.tsx'),
  'utf8'
);

describe('Settings → Workspace → Google Sheets group', () => {
  it('links to the existing Flow Sheets and All Sheets routes', () => {
    expect(SETTINGS_SHEETS_LINKS).toEqual([
      { href: '/data-export', label: 'Flow Sheets' },
      { href: '/all-sheets', label: 'All Sheets' },
    ]);
  });

  it('starts collapsed and auto-expands on sheets child routes', () => {
    for (const pathname of ['/settings', '/inbox', '/workspace']) {
      expect(resolveSheetsOpen(true, pathname)).toBe(false);
    }
    expect(resolveSheetsOpen(false, '/settings')).toBe(true);
    expect(resolveSheetsOpen(true, '/data-export')).toBe(true);
    expect(resolveSheetsOpen(true, '/all-sheets')).toBe(true);
    expect(resolveSheetsOpen(true, '/data-export/123')).toBe(true);
  });

  it('renders as the final Workspace item, after Webhooks', () => {
    // The group is injected inside the workspace group container,
    // after the section buttons (Webhooks is the last rail section).
    const workspaceAnchor = railSrc.indexOf("group === 'workspace'");
    expect(workspaceAnchor).toBeGreaterThan(-1);
    const groupAnchor = railSrc.indexOf('Google Sheets', workspaceAnchor);
    expect(groupAnchor).toBeGreaterThan(workspaceAnchor);
    // No other rail content follows the group.
    expect(
      railSrc.indexOf('SETTINGS_SHEETS_LINKS.map', groupAnchor)
    ).toBeGreaterThan(groupAnchor);
  });

  it('reuses rail styling and highlights the active child', () => {
    expect(railSrc).toContain('bg-primary-soft text-primary');
    expect(railSrc).toContain("aria-current={isActive ? 'page' : undefined}");
    expect(railSrc).toContain("pathname.startsWith(link.href)");
    expect(railSrc).toContain('ChevronUp');
    expect(railSrc).toContain('ChevronDown');
    expect(railSrc).toContain("aria-expanded={sheetsOpen}");
  });

  it('is owner-gated like the old sidebar entries', () => {
    expect(railSrc).toContain('showSheetsLinks');
    expect(settingsPageSrc).toContain('showSheetsLinks={isOwner}');
  });

  it('does not add settings tabs or change routes', () => {
    // Sheets pages are linked destinations, not ?tab= sections —
    // settings-sections.ts is untouched.
    const sectionsSrc = readFileSync(
      join(root, 'src/components/settings/settings-sections.ts'),
      'utf8'
    );
    expect(sectionsSrc).not.toContain('data-export');
    expect(sectionsSrc).not.toContain('all-sheets');
  });
});

describe('Main sidebar no longer carries Google Sheets', () => {
  it('has no sheets entries, header, or accordion state', () => {
    expect(sidebarSrc).not.toContain('GOOGLE SHEETS');
    expect(sidebarSrc).not.toContain('Google Sheets');
    expect(sidebarSrc).not.toContain('/data-export');
    expect(sidebarSrc).not.toContain('/all-sheets');
    expect(sidebarSrc).not.toContain('resolveSheetsOpen');
  });
});
