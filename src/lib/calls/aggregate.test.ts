import { describe, expect, it } from 'vitest';

import {
  aggregateRecordingMetrics,
  callTypeBucket,
  mergedWhatsappRecordings,
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
    const wab = aggregateRecordingMetrics([row({ call_type: 'whatsapp_business' })]);
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
    expect(out.phoneRecordings + out.whatsappRecordings + out.whatsappBusinessRecordings).toBe(0);
  });
});

describe('merged WhatsApp reporting (whatsapp + whatsapp_business = WhatsApp)', () => {
  it('merges 4 + 3 into WhatsApp = 7 while Phone stays 5', () => {
    const rows: CallsRecordingRow[] = [
      ...Array.from({ length: 4 }, (_, i) => row({ id: `wa-${i}`, call_type: 'whatsapp' })),
      ...Array.from({ length: 3 }, (_, i) => row({ id: `wab-${i}`, call_type: 'whatsapp_business' })),
      ...Array.from({ length: 5 }, (_, i) => row({ id: `ph-${i}`, call_type: 'phone' })),
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
      aggregateRecordingMetrics([row({ duration_seconds: null })]).recordingDurationSecs
    ).toBeNull();
  });
});

describe('the dashboard example: 22 rows, mixed metadata', () => {  it('reflects the database exactly', () => {
    const rows: CallsRecordingRow[] = Array.from({ length: 22 }, (_, i) => {
      if (i === 0) return row({ id: 'r-out', direction: 'out', call_type: 'phone' });
      if (i < 6) return row({ id: `r-wa-${i}`, direction: null, call_type: 'whatsapp' });
      if (i < 8)
        return row({ id: `r-wab-${i}`, direction: null, call_type: 'whatsapp_business' });
      return row({ id: `r-${i}`, direction: null, call_type: null, duration_seconds: null });
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
