import { describe, expect, it } from 'vitest';

import {
  formatFormCountsSuffix,
  normalizeFormCountsResponse,
  type FormLeadCounts,
} from './form-counts';

describe('form-counts — dropdown labels', () => {
  it('formats the total/matching suffix', () => {
    const c: FormLeadCounts = { total: 250, matching: 85 };
    expect(formatFormCountsSuffix(c)).toBe(' (250 total · 85 matching)');
  });

  it('renders zeros explicitly once counts are known', () => {
    expect(formatFormCountsSuffix({ total: 0, matching: 0 })).toBe(
      ' (0 total · 0 matching)'
    );
  });

  it('renders no suffix while counts are unavailable', () => {
    expect(formatFormCountsSuffix(null)).toBe('');
    expect(formatFormCountsSuffix(undefined)).toBe('');
  });

  it('floors fractional and clamps negative/garbage values', () => {
    expect(formatFormCountsSuffix({ total: 7.9, matching: -3 })).toBe(
      ' (7 total · 0 matching)'
    );
    expect(
      formatFormCountsSuffix({ total: Number.NaN, matching: 'x' as never })
    ).toBe(' (0 total · 0 matching)');
  });
});

describe('form-counts — response normalization', () => {
  it('keys per-flow counts by flowId and keeps All', () => {
    const out = normalizeFormCountsResponse(
      {
        all: { total: 90, matching: 30 },
        forms: [
          { flowId: 'f-1', total: 35, matching: 12 },
          { flowId: 'f-2', total: 55, matching: 18 },
        ],
      },
      ['f-1', 'f-2']
    );
    expect(out.all).toEqual({ total: 90, matching: 30 });
    expect(out.byFlowId['f-1']).toEqual({ total: 35, matching: 12 });
    expect(out.byFlowId['f-2']).toEqual({ total: 55, matching: 18 });
  });

  it('zero-fills visible forms missing from the response', () => {
    const out = normalizeFormCountsResponse(
      {
        all: { total: 35, matching: 12 },
        forms: [{ flowId: 'f-1', total: 35, matching: 12 }],
      },
      ['f-1', 'f-new']
    );
    expect(out.byFlowId['f-new']).toEqual({ total: 0, matching: 0 });
  });

  it('drops entries without a flowId and coerces bad numbers', () => {
    const out = normalizeFormCountsResponse(
      {
        all: { total: 'x', matching: -5 },
        forms: [
          { flowId: '', total: 99, matching: 99 },
          { total: 1, matching: 1 },
          { flowId: 'f-1', total: '35', matching: null },
        ],
      },
      ['f-1']
    );
    expect(Object.keys(out.byFlowId)).toEqual(['f-1']);
    expect(out.byFlowId['f-1']).toEqual({ total: 35, matching: 0 });
    expect(out.all).toEqual({ total: 0, matching: 0 });
  });

  it('handles empty/null responses without throwing', () => {
    expect(normalizeFormCountsResponse(null, ['f-1'])).toEqual({
      all: { total: 0, matching: 0 },
      byFlowId: { 'f-1': { total: 0, matching: 0 } },
    });
    expect(normalizeFormCountsResponse({}, [])).toEqual({
      all: { total: 0, matching: 0 },
      byFlowId: {},
    });
  });
});
