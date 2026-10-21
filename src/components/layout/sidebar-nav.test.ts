import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  navItems,
  DEFAULT_SHEETS_COLLAPSED,
  resolveSheetsOpen,
} from './sidebar';

const root = process.cwd();

describe('Features removal — sidebar', () => {
  it('contains no Features entry', () => {
    expect(navItems.some((i) => i.href === '/features')).toBe(false);
    expect(navItems.some((i) => i.label.toLowerCase() === 'features')).toBe(
      false
    );
  });

  it('closes the gap: Dashboard is followed directly by Inbox', () => {
    expect(navItems[0]).toMatchObject({ href: '/dashboard' });
    expect(navItems[1]).toMatchObject({ href: '/inbox' });
  });

  it('places Calls immediately after Inbox', () => {
    expect(navItems[2]).toMatchObject({ href: '/calls', label: 'Calls' });
  });

  it('keeps every other entry in the required order', () => {
    expect(navItems.map((i) => i.href)).toEqual([
      '/dashboard',
      '/inbox',
      '/calls',
      '/recordings',
      '/flows',
      '/followups',
      '/workspace',
      '/broadcasts',
      '/quick-replies',
      '/automations',
      '/notifications',
      '/templates',
      '/contacts',
      '/agents',
      '/data-export',
      '/all-sheets',
      '/chat-assignment',
      '/lead-assignment',
    ]);
  });

  it('places Workspace seventh with its Beta badge', () => {
    expect(navItems[6]).toMatchObject({ href: '/workspace' });
    expect(navItems[6].beta).toBe(true);
  });

  it('places Chat Assignment after the Google Sheets children', () => {
    const hrefs = navItems.map((i) => i.href);
    expect(hrefs.indexOf('/chat-assignment')).toBeGreaterThan(
      hrefs.indexOf('/all-sheets')
    );
    expect(hrefs.indexOf('/all-sheets')).toBe(
      hrefs.indexOf('/data-export') + 1
    );
  });

  it('places Lead Assignment directly after Chat Assignment', () => {
    const hrefs = navItems.map((i) => i.href);
    expect(hrefs.indexOf('/lead-assignment')).toBe(
      hrefs.indexOf('/chat-assignment') + 1
    );
    expect(navItems[hrefs.indexOf('/lead-assignment')]).toMatchObject({
      label: 'Lead Assignment',
    });
  });
});

describe('Features removal — route is gone', () => {
  it('has no /features route directory or page', () => {
    expect(existsSync(join(root, 'src/app/(dashboard)/features'))).toBe(false);
  });

  it('has no features-only components left', () => {
    expect(existsSync(join(root, 'src/components/features'))).toBe(false);
  });
});

describe('Google Sheets accordion visibility', () => {
  it('is collapsed by default', () => {
    expect(DEFAULT_SHEETS_COLLAPSED).toBe(true);
  });

  it('stays collapsed on normal routes (fresh load, refresh, reload)', () => {
    for (const pathname of ['/dashboard', '/inbox', '/workspace', '/flows']) {
      expect(resolveSheetsOpen(true, pathname)).toBe(false);
    }
  });

  it('an explicitly expanded group stays open', () => {
    expect(resolveSheetsOpen(false, '/dashboard')).toBe(true);
  });

  it('toggling twice returns to collapsed (expand then collapse)', () => {
    let collapsed = DEFAULT_SHEETS_COLLAPSED;
    collapsed = !collapsed;
    expect(resolveSheetsOpen(collapsed, '/dashboard')).toBe(true);
    collapsed = !collapsed;
    expect(resolveSheetsOpen(collapsed, '/dashboard')).toBe(false);
  });

  it('a direct child-route visit reveals the section and active item', () => {
    expect(resolveSheetsOpen(true, '/data-export')).toBe(true);
    expect(resolveSheetsOpen(true, '/all-sheets')).toBe(true);
    expect(resolveSheetsOpen(true, '/data-export/123')).toBe(true);
  });
});

describe('Features removal — protected areas intact', () => {
  it('Google Sheets navigation still present', () => {
    const hrefs = navItems.map((i) => i.href);
    expect(hrefs).toContain('/data-export');
    expect(hrefs).toContain('/all-sheets');
  });

  it('Workspace navigation still present', () => {
    expect(navItems.map((i) => i.href)).toContain('/workspace');
  });

  it('Follow-ups navigation still present', () => {
    expect(navItems.map((i) => i.href)).toContain('/followups');
  });

  it('Dashboard navigation still present', () => {
    expect(navItems.map((i) => i.href)).toContain('/dashboard');
  });
});
