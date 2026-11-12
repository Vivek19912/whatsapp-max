import { describe, expect, it } from 'vitest';

import {
  aggregateRecordingMetrics,
  bucketHourly,
  bucketTrend,
  bucketWeekday,
  callTypeBucket,
  mergeSalespersonRows,
  mergedWhatsappRecordings,
  pickTrendGranularity,
  recordingDirection,
  type CallsRecordingRow,
} from './aggregate';
import { formatTalkTime } from './formatters';

function row(over: Partial<CallsRecordingRow> = {}): CallsRecordingRow {
  return {
    id: 'r-1',
    contact_id: 'c-1',
    direction: 'out',
    call_type: 'phone',
    duration_seconds: 60,
    recorded_at: '2026-10-04T12:00:00.000Z',
    created_at: '2026-10-04T12:00:00.000Z',
    ...over,
  };
}

describe('empty period', () => {
  it('zeros counts and nulls the duration', () => {
    expect(aggregateRecordingMetrics([])).toEqual({
      recordingCount: 0,
      recordingDurationSecs: null,
      incomingRecordings: 0,
      outgoingRecordings: 0,
      phoneRecordings: 0,
      whatsappRecordings: 0,
      whatsappBusinessRecordings: 0,
      uniqueClients: 0,
      unlinkedRecordings: 0,
    });
  });
});

describe('call types', () => {
  it('phone call_type counts Phone', () => {
    const out = aggregateRecordingMetrics([row({ call_type: 'phone' })]);
    expect(out.phoneRecordings).toBe(1);
    expect(out.whatsappRecordings).toBe(0);
    expect(out.whatsappBusinessRecordings).toBe(0);
  });

  it('whatsapp call_type counts WhatsApp', () => {
    const out = aggregateRecordingMetrics([row({ call_type: 'whatsapp' })]);
    expect(out.whatsappRecordings).toBe(1);
    expect(out.phoneRecordings).toBe(0);
  });

  it('underlying stored values stay distinct (authorization depends on it)', () => {
    const wa = aggregateRecordingMetrics([row({ call_type: 'whatsapp' })]);
    const wab = aggregateRecordingMetrics([
      row({ call_type: 'whatsapp_business' }),
    ]);
    expect(wa.whatsappRecordings).toBe(1);
    expect(wa.whatsappBusinessRecordings).toBe(0);
    expect(wab.whatsappRecordings).toBe(0);
    expect(wab.whatsappBusinessRecordings).toBe(1);
  });

  it('NULL call_type counts toward none of the three', () => {
    const out = aggregateRecordingMetrics([row({ call_type: null })]);
    expect(out.phoneRecordings).toBe(0);
    expect(out.whatsappRecordings).toBe(0);
    expect(out.whatsappBusinessRecordings).toBe(0);
    expect(out.recordingCount).toBe(1);
  });

  it('unknown call_type values are excluded, never guessed', () => {
    expect(callTypeBucket('voip')).toBeNull();
    expect(callTypeBucket('telegram')).toBeNull();
    expect(callTypeBucket('')).toBeNull();
    expect(callTypeBucket(null)).toBeNull();
    const out = aggregateRecordingMetrics([row({ call_type: 'voip' })]);
    expect(
      out.phoneRecordings +
        out.whatsappRecordings +
        out.whatsappBusinessRecordings
    ).toBe(0);
  });
});

describe('merged WhatsApp reporting (whatsapp + whatsapp_business = WhatsApp)', () => {
  it('merges 4 + 3 into WhatsApp = 7 while Phone stays 5', () => {
    const rows: CallsRecordingRow[] = [
      ...Array.from({ length: 4 }, (_, i) =>
        row({ id: `wa-${i}`, call_type: 'whatsapp' })
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        row({ id: `wab-${i}`, call_type: 'whatsapp_business' })
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        row({ id: `ph-${i}`, call_type: 'phone' })
      ),
    ];
    const out = aggregateRecordingMetrics(rows);
    expect(mergedWhatsappRecordings(out)).toBe(7);
    expect(out.phoneRecordings).toBe(5);
  });

  it('phone filter excludes both WhatsApp values', () => {
    const out = aggregateRecordingMetrics([
      row({ call_type: 'whatsapp' }),
      row({ call_type: 'whatsapp_business' }),
    ]);
    expect(out.phoneRecordings).toBe(0);
    expect(mergedWhatsappRecordings(out)).toBe(2);
  });
});

describe('directions', () => {
  it('in counts Incoming', () => {
    expect(
      aggregateRecordingMetrics([row({ direction: 'in' })]).incomingRecordings
    ).toBe(1);
  });

  it('out counts Outgoing', () => {
    expect(
      aggregateRecordingMetrics([row({ direction: 'out' })]).outgoingRecordings
    ).toBe(1);
  });

  it('NULL direction counts as neither', () => {
    const out = aggregateRecordingMetrics([row({ direction: null })]);
    expect(out.incomingRecordings).toBe(0);
    expect(out.outgoingRecordings).toBe(0);
    expect(out.recordingCount).toBe(1);
  });

  it('recordingDirection maps only exact values', () => {
    expect(recordingDirection('in')).toBe('in');
    expect(recordingDirection('out')).toBe('out');
    expect(recordingDirection(null)).toBeNull();
    expect(recordingDirection('missed')).toBeNull();
  });
});

describe('contacts', () => {
  it('present contact_id counts toward Unique Clients', () => {
    expect(
      aggregateRecordingMetrics([row({ contact_id: 'c-1' })]).uniqueClients
    ).toBe(1);
  });

  it('NULL contact_id counts toward Unlinked, never Unique Clients', () => {
    const out = aggregateRecordingMetrics([row({ contact_id: null })]);
    expect(out.unlinkedRecordings).toBe(1);
    expect(out.uniqueClients).toBe(0);
  });

  it('multiple recordings for one contact count the contact once', () => {
    const out = aggregateRecordingMetrics([
      row({ id: 'a', contact_id: 'c-1' }),
      row({ id: 'b', contact_id: 'c-1' }),
      row({ id: 'c', contact_id: 'c-2' }),
    ]);
    expect(out.uniqueClients).toBe(2);
    expect(out.recordingCount).toBe(3);
  });
});

describe('durations', () => {
  it('NULL durations are excluded from the sum', () => {
    const out = aggregateRecordingMetrics([
      row({ id: 'a', duration_seconds: 60 }),
      row({ id: 'b', duration_seconds: null }),
    ]);
    expect(out.recordingCount).toBe(2);
    expect(out.recordingDurationSecs).toBe(60);
  });

  it('no measured durations yields null, not zero', () => {
    expect(
      aggregateRecordingMetrics([row({ duration_seconds: null })])
        .recordingDurationSecs
    ).toBeNull();
  });
});

describe('the dashboard example: 22 rows, mixed metadata', () => {
  it('reflects the database exactly', () => {
    const rows: CallsRecordingRow[] = Array.from({ length: 22 }, (_, i) => {
      if (i === 0)
        return row({ id: 'r-out', direction: 'out', call_type: 'phone' });
      if (i < 6)
        return row({ id: `r-wa-${i}`, direction: null, call_type: 'whatsapp' });
      if (i < 8)
        return row({
          id: `r-wab-${i}`,
          direction: null,
          call_type: 'whatsapp_business',
        });
      return row({
        id: `r-${i}`,
        direction: null,
        call_type: null,
        duration_seconds: null,
      });
    });
    const out = aggregateRecordingMetrics(rows);
    expect(out.recordingCount).toBe(22);
    expect(out.outgoingRecordings).toBe(1);
    expect(out.incomingRecordings).toBe(0);
    expect(out.whatsappRecordings).toBe(5);
    expect(out.whatsappBusinessRecordings).toBe(2);
    expect(out.phoneRecordings).toBe(1);
  });
});

describe('duration formatting', () => {
  it('scales from seconds to hours and handles unknown', () => {
    expect(formatTalkTime(538)).toBe('8m 58s');
    expect(formatTalkTime(3725)).toBe('1h 2m');
    expect(formatTalkTime(19)).toBe('0:19');
  });
});

describe('trend granularity picker', () => {
  it('uses daily buckets up to a month, weekly to ~half a year, monthly above', () => {
    const day = 86_400_000;
    expect(pickTrendGranularity(0, 31 * day)).toBe('day');
    expect(pickTrendGranularity(0, 32 * day)).toBe('week');
    expect(pickTrendGranularity(0, 200 * day)).toBe('week');
    expect(pickTrendGranularity(0, 201 * day)).toBe('month');
  });
});

describe('weekly and monthly trend buckets', () => {
  const trow = (over: Partial<CallsRecordingRow> = {}): CallsRecordingRow => ({
    id: `t-${over.recorded_at ?? 'x'}`,
    contact_id: null,
    direction: 'in',
    call_type: 'phone',
    duration_seconds: 60,
    recorded_at: '2026-10-04T12:00:00.000Z',
    created_at: '2026-10-04T12:00:00.000Z',
    ...over,
  });

  it('groups by Monday-start weeks with zero-filled gaps', () => {
    // 2026-10-01 is a Thursday (UTC zone keeps this deterministic).
    const from = Date.parse('2026-10-01T00:00:00Z');
    const to = Date.parse('2026-10-15T00:00:00Z');
    const rows = [
      trow({
        recorded_at: '2026-10-02T10:00:00Z',
        direction: 'in',
        duration_seconds: 60,
      }),
      trow({
        recorded_at: '2026-10-05T10:00:00Z',
        direction: 'out',
        duration_seconds: 30,
      }),
      trow({
        recorded_at: '2026-10-12T10:00:00Z',
        direction: null,
        duration_seconds: null,
      }),
    ];
    const out = bucketTrend(rows, {
      fromMs: from,
      toMs: to,
      timeZone: 'UTC',
      granularity: 'week',
    });
    expect(out.map((b) => b.key)).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
    ]);
    expect(out[0]).toMatchObject({
      inbound: 1,
      outbound: 0,
      unknown: 0,
      durationSecs: 60,
    });
    expect(out[1]).toMatchObject({
      inbound: 0,
      outbound: 1,
      unknown: 0,
      durationSecs: 30,
    });
    expect(out[2]).toMatchObject({
      inbound: 0,
      outbound: 0,
      unknown: 1,
      durationSecs: 0,
    });
  });

  it('drops out-of-window rows instead of fabricating buckets', () => {
    const from = Date.parse('2026-10-01T00:00:00Z');
    const to = Date.parse('2026-10-15T00:00:00Z');
    const out = bucketTrend([trow({ recorded_at: '2026-09-01T10:00:00Z' })], {
      fromMs: from,
      toMs: to,
      timeZone: 'UTC',
      granularity: 'week',
    });
    expect(out.every((b) => b.inbound + b.outbound + b.unknown === 0)).toBe(
      true
    );
  });

  it('groups by calendar month with readable labels', () => {
    const from = Date.parse('2026-01-01T00:00:00Z');
    const to = Date.parse('2026-04-01T00:00:00Z');
    const rows = [
      trow({
        recorded_at: '2026-01-15T10:00:00Z',
        direction: 'in',
        duration_seconds: 10,
      }),
      trow({
        recorded_at: '2026-02-15T10:00:00Z',
        direction: 'out',
        duration_seconds: 20,
      }),
    ];
    const out = bucketTrend(rows, {
      fromMs: from,
      toMs: to,
      timeZone: 'UTC',
      granularity: 'month',
    });
    expect(out.map((b) => b.key)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(out.map((b) => b.label)).toEqual(['Jan', 'Feb', 'Mar']);
    expect(out[0]).toMatchObject({ inbound: 1, durationSecs: 10 });
    expect(out[1]).toMatchObject({ outbound: 1, durationSecs: 20 });
    expect(out[2]).toMatchObject({ inbound: 0, outbound: 0, durationSecs: 0 });
  });
});

describe('hourly buckets', () => {
  it('files rows into their in-zone hour, ignoring out-of-window rows', () => {
    const trow = (recorded_at: string): CallsRecordingRow => ({
      id: recorded_at,
      contact_id: null,
      direction: 'in',
      call_type: 'phone',
      duration_seconds: 60,
      recorded_at,
      created_at: recorded_at,
    });
    const from = Date.parse('2026-10-04T00:00:00Z');
    const to = Date.parse('2026-10-05T00:00:00Z');
    const out = bucketHourly(
      [
        trow('2026-10-04T05:10:00Z'),
        trow('2026-10-04T05:50:00Z'),
        trow('2026-10-04T17:00:00Z'),
        trow('2026-10-03T23:00:00Z'),
      ],
      { fromMs: from, toMs: to, timeZone: 'UTC' }
    );
    expect(out).toHaveLength(24);
    expect(out[5]).toBe(2);
    expect(out[17]).toBe(1);
    expect(out.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('weekday buckets', () => {
  it('files rows Monday-first in-zone, ignoring out-of-window rows', () => {
    // 2026-10-04 is a Sunday, 2026-10-05 a Monday (UTC).
    const mk = (recorded_at: string): CallsRecordingRow => ({
      id: recorded_at,
      contact_id: null,
      direction: 'in',
      call_type: 'phone',
      duration_seconds: 60,
      recorded_at,
      created_at: recorded_at,
    });
    const from = Date.parse('2026-10-03T00:00:00Z');
    const to = Date.parse('2026-10-10T00:00:00Z');
    const out = bucketWeekday(
      [
        mk('2026-10-04T10:00:00Z'),
        mk('2026-10-05T10:00:00Z'),
        mk('2026-10-05T11:00:00Z'),
        mk('2026-09-01T10:00:00Z'),
      ],
      { fromMs: from, toMs: to, timeZone: 'UTC' }
    );
    expect(out).toHaveLength(7);
    expect(out[6]).toBe(1);
    expect(out[0]).toBe(2);
    expect(out.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('salesperson roster merge', () => {
  const row = (over: Record<string, unknown>) => ({
    userId: 'u-1',
    name: 'Sagar',
    recordings: 0,
    durationSecs: 0,
    answered: 0,
    missed: 0,
    answerRate: null as number | null,
    ...over,
  });

  it('keeps RPC rows and appends zero-activity members sorted last', () => {
    const out = mergeSalespersonRows(
      [row({ userId: 'u-2', name: 'Zed', recordings: 2, durationSecs: 10 })],
      [
        { user_id: 'u-1', label: 'Amy' },
        { user_id: 'u-2', label: 'Zed' },
      ]
    );
    expect(out.map((r) => r.userId)).toEqual(['u-2', 'u-1']);
    expect(out[1]).toMatchObject({
      name: 'Amy',
      recordings: 0,
      answerRate: null,
    });
  });

  it('sorts by recordings, then talk time, then name', () => {
    const out = mergeSalespersonRows(
      [
        row({ userId: 'u-1', name: 'B', recordings: 3, durationSecs: 5 }),
        row({ userId: 'u-2', name: 'A', recordings: 3, durationSecs: 9 }),
        row({ userId: 'u-3', name: 'C', recordings: 5, durationSecs: 1 }),
      ],
      []
    );
    expect(out.map((r) => r.userId)).toEqual(['u-3', 'u-2', 'u-1']);
  });

  it('never duplicates a member already present in the rows', () => {
    const out = mergeSalespersonRows(
      [row({ userId: 'u-1' })],
      [{ user_id: 'u-1', label: 'Sagar' }]
    );
    expect(out).toHaveLength(1);
  });
});
