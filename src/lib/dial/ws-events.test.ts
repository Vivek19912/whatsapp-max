import { describe, expect, it } from 'vitest';

import {
  buildDialWsEvent,
  isConnectDeliverable,
  isLiveExpiry,
} from '@/lib/dial/ws-events';

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'pending',
  expires_at: '2030-01-01T00:00:00.000Z',
  created_at: '2026-10-29T08:13:12.000Z',
  phone_number: '+919999999999',
};

describe('dial WebSocket event', () => {
  it('carries only the request id and timing — never the number', () => {
    const event = buildDialWsEvent(row, {
      eventId: 'evt-1',
      nowMs: Date.parse('2026-10-29T08:13:13.000Z'),
    });
    expect(event).toEqual({
      type: 'dial_request',
      event_id: 'evt-1',
      request_id: row.id,
      expires_at: row.expires_at,
      created_at: row.created_at,
      sent_at: '2026-10-29T08:13:13.000Z',
    });
    expect(JSON.stringify(event)).not.toContain('9999');
    expect(event).not.toHaveProperty('phone_number');
  });

  it('rejects a row without an id instead of emitting an unusable signal', () => {
    expect(() => buildDialWsEvent({ ...row, id: '   ' })).toThrow();
  });

  it('treats a past or unparseable expiry as dead', () => {
    const now = Date.parse('2026-10-29T08:13:13.000Z');
    expect(isLiveExpiry('2026-10-29T08:13:14.000Z', now)).toBe(true);
    expect(isLiveExpiry('2026-10-29T08:13:12.000Z', now)).toBe(false);
    expect(isLiveExpiry('not-a-date', now)).toBe(false);
  });

  it('replays pending rows on connect but never delivered ones', () => {
    const now = Date.parse('2026-10-29T08:13:13.000Z');
    expect(isConnectDeliverable({ status: 'pending', expires_at: '2030-01-01T00:00:00Z' }, now)).toBe(true);
    // Delivered means the phone already acknowledged it. Replaying it
    // on every reconnect would reopen the dialer repeatedly.
    expect(isConnectDeliverable({ status: 'delivered', expires_at: '2030-01-01T00:00:00Z' }, now)).toBe(false);
    expect(isConnectDeliverable({ status: 'opened', expires_at: '2030-01-01T00:00:00Z' }, now)).toBe(false);
    expect(isConnectDeliverable({ status: 'pending', expires_at: '2000-01-01T00:00:00Z' }, now)).toBe(false);
  });
});
