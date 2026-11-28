import { describe, expect, it } from 'vitest';

import { resolveExportDateRange } from './date-presets';

const NOW = new Date('2026-11-28T15:30:00');

describe('resolveExportDateRange (Submission Time only)', () => {
  it('All Time returns null (no filter)', () => {
    expect(resolveExportDateRange('allTime', {}, NOW)).toBeNull();
  });

  it('Today covers local midnight to tomorrow', () => {
    const r = resolveExportDateRange('today', {}, NOW)!;
    expect(r.from).toBe(new Date(2026, 10, 28).toISOString());
    expect(r.to).toBe(new Date(2026, 10, 29).toISOString());
  });

  it('Yesterday covers the prior local day', () => {
    const r = resolveExportDateRange('yesterday', {}, NOW)!;
    expect(r.from).toBe(new Date(2026, 10, 27).toISOString());
    expect(r.to).toBe(new Date(2026, 10, 28).toISOString());
  });

  it('Last 7 / Last 30 are inclusive of today', () => {
    const r7 = resolveExportDateRange('last7', {}, NOW)!;
    expect(r7.from).toBe(new Date(2026, 10, 22).toISOString());
    const r30 = resolveExportDateRange('last30', {}, NOW)!;
    expect(r30.from).toBe(new Date(2026, 9, 30).toISOString());
  });

  it('This Month / Last Month resolve calendar months', () => {
    const thisM = resolveExportDateRange('thisMonth', {}, NOW)!;
    expect(thisM.from).toBe(new Date(2026, 10, 1).toISOString());
    expect(thisM.to).toBe(new Date(2026, 11, 1).toISOString());
    const lastM = resolveExportDateRange('lastMonth', {}, NOW)!;
    expect(lastM.from).toBe(new Date(2026, 9, 1).toISOString());
    expect(lastM.to).toBe(new Date(2026, 10, 1).toISOString());
  });

  it('Custom range is inclusive (to +1 day) with boundaries', () => {
    const r = resolveExportDateRange(
      'custom',
      { from: '2026-11-20', to: '2026-11-21' },
      NOW
    )!;
    expect(r.from).toBe(new Date(2026, 10, 20).toISOString());
    expect(r.to).toBe(new Date(2026, 10, 22).toISOString());
  });

  it('Custom rejects missing/inverted dates', () => {
    expect(() =>
      resolveExportDateRange('custom', { from: null, to: '2026-11-21' }, NOW)
    ).toThrow();
    expect(() =>
      resolveExportDateRange(
        'custom',
        { from: '2026-11-22', to: '2026-11-21' },
        NOW
      )
    ).toThrow();
  });
});
