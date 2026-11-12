import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  navItems,
} from './sidebar';

const root = process.cwd();

describe('Features removal — sidebar', () => {
  it('contains no Features entry', () => {
    expect(navItems.some((i) => i.href === '/features')).toBe(false);
    expect(navItems.some((i) => i.label.toLowerCase() === 'features')).toBe(
      false
    );
  });

  it('leads with Dashboard (Meta Lead Ads route), then Inbox', () => {
    expect(navItems[0]).toMatchObject({ href: '/meta-lead-ads/dashboard', label: 'Dashboard' });
    expect(navItems[1]).toMatchObject({ href: '/inbox' });
  });

  it('places Calls after the Meta Lead Ads entry and Inbox', () => {
    expect(navItems[1]).toMatchObject({ href: '/inbox' });
    expect(navItems[2]).toMatchObject({ href: '/calls', label: 'Call Analytics' });
  });

  it('keeps every other entry in the required order', () => {
    expect(navItems.map((i) => i.href)).toEqual([
      '/meta-lead-ads/dashboard',
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
      '/chat-assignment',
    ]);
  });

  it('contains no Contacts entry', () => {
    expect(navItems.some((i) => i.href === '/contacts')).toBe(false);
    expect(navItems.some((i) => i.label.toLowerCase() === 'contacts')).toBe(
      false
    );
  });

  it('contains no AI Agents entry (sidebar-only visibility change)', () => {
    expect(navItems.some((i) => i.href === '/agents')).toBe(false);
    expect(navItems.some((i) => i.label.toLowerCase() === 'ai agents')).toBe(
      false
    );
  });

  it('contains no old Dashboard route entry (sidebar-only visibility change)', () => {
    // Exact href match only: the label 'Dashboard' now belongs to
    // the Meta Lead Ads route (/meta-lead-ads/dashboard), which
    // stays in the sidebar.
    expect(navItems.some((i) => i.href === '/dashboard')).toBe(false);
    expect(
      navItems.find((i) => i.href === '/meta-lead-ads/dashboard')?.label
    ).toBe('Dashboard');
  });

  it('places Workspace seventh with no Beta badge', () => {
    expect(navItems[6]).toMatchObject({ href: '/workspace' });
    expect(navItems[6].beta ?? false).toBe(false);
  });

  it('places Chat Assignment last', () => {
    const hrefs = navItems.map((i) => i.href);
    expect(hrefs[hrefs.length - 1]).toBe('/chat-assignment');
  });

  it('contains no Lead Assignment entry (sidebar-only visibility change)', () => {
    // The /lead-assignment page, route, APIs, and configuration
    // are untouched — only its sidebar entry is gone.
    const hrefs = navItems.map((i) => i.href);
    expect(hrefs).not.toContain('/lead-assignment');
    expect(
      navItems.some((i) => i.label === 'Lead Assignment')
    ).toBe(false);
    expect(existsSync(join(root, 'src/app/(dashboard)/lead-assignment/page.tsx'))).toBe(true);
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

describe('Contacts removal — sidebar and route are gone', () => {
  it('has no /contacts route directory or page', () => {
    expect(existsSync(join(root, 'src/app/(dashboard)/contacts'))).toBe(false);
  });

  it('points no dashboard quick action at the removed page', () => {
    expect(navItems.some((i) => i.href === '/contacts')).toBe(false);
  });
});

describe('Google Sheets moved to Settings (main sidebar clean)', () => {
  it('has no Google Sheets accordion helpers or markup anymore', () => {
    const sidebarSrc = readFileSync(join(root, 'src/components/layout/sidebar.tsx'), 'utf8');
    expect(sidebarSrc).not.toContain('GOOGLE SHEETS');
    expect(sidebarSrc).not.toContain('resolveSheetsOpen');
    expect(sidebarSrc).not.toContain('DEFAULT_SHEETS_COLLAPSED');
    expect(sidebarSrc).not.toContain('sheetsCollapsed');
  });

  it('shows no sheets group, header, or children', () => {
    const hrefs = navItems.map((i) => i.href);
    expect(hrefs).not.toContain('/data-export');
    expect(hrefs).not.toContain('/all-sheets');
    expect(
      navItems.some((i) => i.label.toLowerCase().includes('sheet'))
    ).toBe(false);
  });

  it('keeps the Flow Sheets and All Sheets pages (navigation-only move)', () => {
    // The pages, routes, APIs, and configuration are untouched —
    // only their sidebar entries are gone (they now live under
    // Settings → Workspace → Google Sheets).
    expect(existsSync(join(root, 'src/app/(dashboard)/data-export/page.tsx'))).toBe(true);
    expect(existsSync(join(root, 'src/app/(dashboard)/all-sheets/page.tsx'))).toBe(true);
  });
});

describe('Features removal — protected areas intact', () => {
  it('Google Sheets navigation moved out (pages untouched)', () => {
    const hrefs = navItems.map((i) => i.href);
    expect(hrefs).not.toContain('/data-export');
    expect(hrefs).not.toContain('/all-sheets');
  });

  it('Workspace navigation still present', () => {
    expect(navItems.map((i) => i.href)).toContain('/workspace');
  });

  it('Follow-ups navigation still present', () => {
    expect(navItems.map((i) => i.href)).toContain('/followups');
  });

  it('Dashboard route still exists (sidebar entry removed only)', () => {
    // The /dashboard page and route are untouched — only its
    // sidebar entry is gone.
    expect(existsSync(join(root, 'src/app/(dashboard)/dashboard'))).toBe(true);
  });
});
