'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, ChevronUp, Sheet } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './settings-sections';

// Width at/above which the rail is a vertical column (already in view, so
// no auto-scroll needed). Mirrors the Tailwind `lg:` breakpoint that
// drives the row→column switch in the markup below — keep the two in sync.
const RAIL_DESKTOP_MIN_PX = 1024;

/**
 * Child links of the Settings → Workspace → Google Sheets group.
 * Same destinations as the old main-sidebar group — routes and
 * pages are untouched, only the navigation entry point moved.
 */
export const SETTINGS_SHEETS_LINKS = [
  { href: '/data-export', label: 'Flow Sheets' },
  { href: '/all-sheets', label: 'All Sheets' },
] as const;

/**
 * Whether the Google Sheets group shows its children. An
 * explicitly expanded group is always open; a collapsed group
 * still opens when the user is on a sheets child route so the
 * active row is never hidden.
 */
export function resolveSheetsOpen(
  sheetsCollapsed: boolean,
  pathname: string
): boolean {
  if (!sheetsCollapsed) return true;
  return (
    pathname.startsWith('/data-export') || pathname.startsWith('/all-sheets')
  );
}

/**
 * The settings left rail — grouped, vertical on desktop and a
 * horizontal scroller on narrow screens (mirrors the mockup's ≤920px
 * behaviour). The active item auto-scrolls into view when the rail is
 * horizontal so a deep-linked section is never off-screen.
 */
export function SettingsRail({
  active,
  onSelect,
  hints,
  visibleSections,
  showSheetsLinks = false,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  hints?: Partial<Record<SettingsSection, ReactNode>>;
  visibleSections?: ReadonlySet<SettingsSection>;
  /**
   * Show the Google Sheets group (Flow Sheets + All Sheets) as the
   * final Workspace item. Owner-only, matching the old main-sidebar
   * visibility — the routes themselves are untouched.
   */
  showSheetsLinks?: boolean;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  // Google Sheets starts collapsed on every mount (no persistence,
  // same as the old sidebar group). Forced open while a sheets
  // child route is active so the highlighted row is never hidden
  // inside a closed group.
  const [sheetsCollapsed, setSheetsCollapsed] = useState(true);
  const sheetsOpen = resolveSheetsOpen(sheetsCollapsed, pathname ?? '');

  // When horizontal (mobile), keep the active chip in view. On desktop
  // the rail is a static column, so skip.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia(`(min-width: ${RAIL_DESKTOP_MIN_PX}px)`).matches) return;
    activeRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [active]);

  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        'flex gap-1 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'border-b border-border',
        'lg:sticky lg:top-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0',
      )}
    >
      {RAIL_GROUPS.map(({ label, group }) => {
        const items = SETTINGS_SECTIONS.filter(
          (s) => SECTION_META[s].group === group && !SECTION_META[s].hideFromRail && (!visibleSections || visibleSections.has(s)),
        );
        if (items.length === 0) return null;
        return (
          <div
            key={group}
            className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5"
          >
            {label ? (
              <div className="hidden px-3 pt-3.5 pb-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase lg:block">
                {label}
              </div>
            ) : null}
            {items.map((s) => {
              const meta = SECTION_META[s];
              const Icon = meta.icon;
              const isActive = s === active;
              return (
                <button
                  key={s}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => onSelect(s)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors',
                    'lg:w-full',
                    isActive
                      ? 'bg-primary-soft text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1">{meta.label}</span>
                  {hints?.[s] != null ? (
                    <span
                      className={cn(
                        'hidden items-center gap-1.5 text-xs lg:inline-flex',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                    >
                      {hints[s]}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {/* Google Sheets is always the final Workspace item,
                after Webhooks. Collapsible group linking to the
                existing Flow Sheets / All Sheets routes. */}
            {group === 'workspace' && showSheetsLinks ? (
              <div className="flex shrink-0 flex-col gap-0.5">
                <button
                  key="google-sheets"
                  type="button"
                  onClick={() => setSheetsCollapsed((v) => !v)}
                  aria-expanded={sheetsOpen}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors',
                    'lg:w-full',
                    sheetsOpen
                      ? 'bg-primary-soft text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Sheet className="size-4 shrink-0" />
                  <span className="flex-1">Google Sheets</span>
                  {sheetsOpen ? (
                    <ChevronUp className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
                  )}
                </button>
                {sheetsOpen
                  ? SETTINGS_SHEETS_LINKS.map((link) => {
                      const isActive =
                        pathname != null && pathname.startsWith(link.href);
                      return (
                        <Link
                          key={link.href}
                          href={link.href}
                          aria-current={isActive ? 'page' : undefined}
                          className={cn(
                            'flex shrink-0 items-center gap-2.5 rounded-lg py-2 pr-3 pl-9 text-left text-sm font-medium whitespace-nowrap transition-colors',
                            'lg:w-full',
                            isActive
                              ? 'bg-primary-soft text-primary'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          <Sheet className="size-4 shrink-0" aria-hidden="true" />
                          <span className="flex-1">{link.label}</span>
                        </Link>
                      );
                    })
                  : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
