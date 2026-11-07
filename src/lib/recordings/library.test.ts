// Recordings library data layer — query building and duration text.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatCustomRangeLabel,
  formatDurationLong,
  loadWorkspaceTableOptions,
  recordingsQuery,
  resetRecordingsFilters,
  summaryQuery,
  type RecordingsFilters,
} from './library';

const FILTERS: RecordingsFilters = {
  q: '',
  rangeKey: 'last30',
  customFrom: '',
  customTo: '',
  callType: null,
  direction: null,
  uploadedBy: null,
  workspaceTable: null,
  status: null,
};

const RANGE = { fromISO: '2026-10-01T00:00:00.000Z', toISO: '2026-10-06T00:00:00.000Z' };

describe('recordingsQuery', () => {
  it('always scopes by range with pagination', () => {
    const qs = new URLSearchParams(recordingsQuery(FILTERS, RANGE, 10, 20));
    expect(qs.get('limit')).toBe('10');
    expect(qs.get('offset')).toBe('20');
    expect(qs.get('from')).toBe(RANGE.fromISO);
    expect(qs.get('to')).toBe(RANGE.toISO);
    expect(qs.get('q')).toBeNull();
  });

  it('passes every active filter to the server', () => {
    const qs = new URLSearchParams(
      recordingsQuery(
        {
          ...FILTERS,
          q: '  Akash ',
          callType: 'whatsapp',
          direction: 'unknown',
          uploadedBy: '123e4567-e89b-12d3-a456-426614174000',
          status: 'unlinked',
        },
        RANGE,
        10,
        0
      )
    );
    expect(qs.get('q')).toBe('Akash');
    expect(qs.get('call_type')).toBe('whatsapp');
    expect(qs.get('direction')).toBe('unknown');
    expect(qs.get('uploaded_by')).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(qs.get('status')).toBe('unlinked');
  });

  it('passes the workspace table filter to the server', () => {
    const qs = new URLSearchParams(
      recordingsQuery({ ...FILTERS, workspaceTable: 'flow-1' }, RANGE, 10, 0)
    );
    expect(qs.get('workspace_table')).toBe('flow-1');
    expect(
      new URLSearchParams(recordingsQuery(FILTERS, RANGE, 10, 0)).get('workspace_table')
    ).toBeNull();
    expect(
      new URLSearchParams(summaryQuery({ ...FILTERS, workspaceTable: 'flow-1' }, RANGE)).get(
        'workspace_table'
      )
    ).toBe('flow-1');
  });

  it('resetRecordingsFilters clears the workspace table too', () => {
    expect(resetRecordingsFilters().workspaceTable).toBeNull();
  });
});

describe('summaryQuery', () => {
  it('requests the aggregate, never rows', () => {
    const qs = new URLSearchParams(summaryQuery(FILTERS, RANGE));
    expect(qs.get('summary')).toBe('1');
    expect(qs.get('limit')).toBeNull();
    expect(qs.get('from')).toBe(RANGE.fromISO);
  });
});

describe('formatCustomRangeLabel', () => {
  it('renders a same-year range with the year once', () => {
    expect(formatCustomRangeLabel('2026-11-07', '2026-11-15')).toBe(
      '07 Nov – 15 Nov 2026'
    );
  });

  it('repeats the year when the range spans years', () => {
    expect(formatCustomRangeLabel('2025-12-28', '2026-01-05')).toBe(
      '28 Dec 2025 – 05 Jan 2026'
    );
  });

  it('falls back to Custom for missing, invalid, or inverted ranges', () => {
    expect(formatCustomRangeLabel('', '')).toBe('Custom');
    expect(formatCustomRangeLabel('2026-11-15', '2026-11-07')).toBe('Custom');
    expect(formatCustomRangeLabel('2026-11-07', '2026-11-07')).toBe('Custom');
    expect(formatCustomRangeLabel('not-a-date', '2026-11-07')).toBe('Custom');
    expect(formatCustomRangeLabel('2026-13-01', '2026-11-07')).toBe('Custom');
  });
});

describe('loadWorkspaceTableOptions', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
  });

  it('maps flows to filter options with an Untitled fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          flows: [
            { id: 'f-1', name: 'Meta Lead Ads' },
            { id: 'f-2', name: '   ' },
            { id: null, name: 'Ghost' },
          ],
        }),
      }))
    );
    await expect(loadWorkspaceTableOptions()).resolves.toEqual([
      { flow_id: 'f-1', name: 'Meta Lead Ads' },
      { flow_id: 'f-2', name: 'Untitled Flow' },
    ]);
  });

  it('degrades to no options when the endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      })
    );
    await expect(loadWorkspaceTableOptions()).resolves.toEqual([]);
  });
});

describe('formatDurationLong', () => {
  it('renders seconds for short recordings', () => {
    expect(formatDurationLong(16)).toBe('16 seconds');
    expect(formatDurationLong(1)).toBe('1 second');
    expect(formatDurationLong(0)).toBe('0 seconds');
  });

  it('renders m:ss for longer recordings', () => {
    expect(formatDurationLong(192)).toBe('3:12');
    expect(formatDurationLong(3661)).toBe('61:01');
  });

  it('renders an em dash for unknown durations', () => {
    expect(formatDurationLong(null)).toBe('—');
    expect(formatDurationLong(undefined)).toBe('—');
    expect(formatDurationLong(Number.NaN)).toBe('—');
  });
});
