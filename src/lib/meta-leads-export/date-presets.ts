// ============================================================
// Meta Leads Export — date presets (Submission Time only).
//
// Submission Time = flow_runs.started_at (half-open [from, to)).
// Never metaCreatedTime. Bounds resolve in the viewer's LOCAL
// timezone (same tz the table uses to display Submission Time),
// serialized as UTC ISO for TIMESTAMPTZ comparison server-side.
//
// Extends WORKSPACE_DATE_PRESETS with the export-required
// allTime/thisMonth/lastMonth (existing presets live in
// lib/flows/workspace-filters and are reused, not duplicated).
// ============================================================

import type { WorkspaceDateRange } from '@/lib/flows/workspace-filters';

export const EXPORT_DATE_PRESETS = [
  'allTime',
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
  'custom',
] as const;

export type ExportDatePreset = (typeof EXPORT_DATE_PRESETS)[number];

export const EXPORT_DATE_PRESET_LABELS: Record<ExportDatePreset, string> = {
  allTime: 'All Time',
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 Days',
  last30: 'Last 30 Days',
  thisMonth: 'This Month',
  lastMonth: 'Last Month',
  custom: 'Custom Date Range',
};

export function isExportDatePreset(v: unknown): v is ExportDatePreset {
  return (
    typeof v === 'string' &&
    (EXPORT_DATE_PRESETS as readonly string[]).includes(v)
  );
}

function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addLocalDays(midnight: Date, n: number): Date {
  return new Date(
    midnight.getFullYear(),
    midnight.getMonth(),
    midnight.getDate() + n
  );
}

function parseCustomDay(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d)
    return null;
  return dt;
}

/**
 * Resolve an export date preset to a half-open [from, to) UTC ISO
 * range over Submission Time. Returns null for All Time (no filter).
 * Throws on invalid custom input.
 */
export function resolveExportDateRange(
  preset: ExportDatePreset,
  custom: { from?: string | null; to?: string | null },
  now: Date = new Date()
): WorkspaceDateRange | null {
  const today = localMidnight(now);
  switch (preset) {
    case 'allTime':
      return null;
    case 'today':
      return {
        from: today.toISOString(),
        to: addLocalDays(today, 1).toISOString(),
      };
    case 'yesterday':
      return {
        from: addLocalDays(today, -1).toISOString(),
        to: today.toISOString(),
      };
    case 'last7':
      return {
        from: addLocalDays(today, -6).toISOString(),
        to: addLocalDays(today, 1).toISOString(),
      };
    case 'last30':
      return {
        from: addLocalDays(today, -29).toISOString(),
        to: addLocalDays(today, 1).toISOString(),
      };
    case 'thisMonth': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      return { from: first.toISOString(), to: next.toISOString() };
    }
    case 'lastMonth': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const next = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: first.toISOString(), to: next.toISOString() };
    }
    case 'custom': {
      const fromDay = parseCustomDay(custom.from);
      const toDay = parseCustomDay(custom.to);
      if (!fromDay || !toDay)
        throw new Error('Choose both a From and a To date.');
      if (fromDay.getTime() > toDay.getTime()) {
        throw new Error('The From date must be on or before the To date.');
      }
      return {
        from: fromDay.toISOString(),
        to: addLocalDays(toDay, 1).toISOString(),
      };
    }
  }
}
