import { describe, expect, it } from 'vitest';

import {
  buildConsumeRejected,
  buildConsumeReply,
  buildDialWsEvent,
  buildStatusEvent,
  buildStatusSnapshot,
  effectiveDisplayStatus,
  isConnectDeliverable,
  isDialRequestId,
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

describe('dial request id validation (shared by route and sidecar)', () => {
  it('accepts canonical UUIDs and rejects everything else', () => {
    expect(isDialRequestId('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isDialRequestId('not-a-uuid')).toBe(false);
    expect(isDialRequestId('')).toBe(false);
    expect(isDialRequestId(null)).toBe(false);
    expect(isDialRequestId(42)).toBe(false);
  });
});

describe('browser status channel (no polling)', () => {
  const now = Date.parse('2026-10-29T08:13:13.000Z');

  it('snapshots map live rows and surface expired TTLs without persisting', () => {
    const snap = buildStatusSnapshot(
      [
        { id: 'a', status: 'pending', expires_at: '2030-01-01T00:00:00.000Z', created_at: '2026-10-29T08:13:12.000Z' },
        { id: 'b', status: 'pending', expires_at: '2000-01-01T00:00:00Z', created_at: '2026-10-29T08:13:12.000Z' },
        { id: 'c', status: 'opened', expires_at: '2000-01-01T00:00:00Z', created_at: '2026-10-29T08:13:12.000Z' },
        { id: '   ', status: 'pending', expires_at: '2030-01-01T00:00:00Z', created_at: '2026-10-29T08:13:12.000Z' },
      ],
      { nowMs: now }
    );
    expect(snap.type).toBe('status_snapshot');
    expect(snap.requests).toEqual([
      { id: 'a', status: 'pending', expires_at: '2030-01-01T00:00:00.000Z', created_at: '2026-10-29T08:13:12.000Z' },
      // Past TTL reads as expired even though the stored status is pending.
      { id: 'b', status: 'expired', expires_at: '2000-01-01T00:00:00Z', created_at: '2026-10-29T08:13:12.000Z' },
      // A terminal status is never rewritten by expiry mapping.
      { id: 'c', status: 'opened', expires_at: '2000-01-01T00:00:00Z', created_at: '2026-10-29T08:13:12.000Z' },
    ]);
  });

  it('builds status events carrying only the persisted transition', () => {
    const event = buildStatusEvent('11111111-1111-4111-8111-111111111111', 'delivered', { nowMs: now });
    expect(event).toEqual({
      type: 'status',
      request_id: '11111111-1111-4111-8111-111111111111',
      status: 'delivered',
      at: '2026-10-29T08:13:13.000Z',
    });
    expect(() => buildStatusEvent('   ', 'delivered')).toThrow();
  });

  it('effectiveDisplayStatus only maps live rows past their TTL', () => {
    expect(effectiveDisplayStatus({ status: 'pending', expires_at: '2000-01-01T00:00:00Z' }, now)).toBe('expired');
    expect(effectiveDisplayStatus({ status: 'delivered', expires_at: '2000-01-01T00:00:00Z' }, now)).toBe('expired');
    expect(effectiveDisplayStatus({ status: 'pending', expires_at: '2030-01-01T00:00:00Z' }, now)).toBe('pending');
    expect(effectiveDisplayStatus({ status: 'failed', expires_at: '2000-01-01T00:00:00Z' }, now)).toBe('failed');
  });
});

describe('consume fast path (server-validated payload over the socket)', () => {
  it('builds a consume reply carrying the server-owned number', () => {
    const reply = buildConsumeReply(row, { nowMs: Date.parse('2026-10-29T08:13:13.000Z') });
    expect(reply).toEqual({
      type: 'consume',
      request_id: row.id,
      phone_number: row.phone_number,
      expires_at: row.expires_at,
      created_at: row.created_at,
      sent_at: '2026-10-29T08:13:13.000Z',
    });
  });

  it('refuses to build consume payloads without an id or number', () => {
    expect(() => buildConsumeReply({ ...row, id: '  ' })).toThrow();
    expect(() => buildConsumeReply({ ...row, phone_number: '  ' })).toThrow();
    expect(() => buildConsumeRejected('   ')).toThrow();
    expect(buildConsumeRejected(row.id)).toEqual({ type: 'consume_rejected', request_id: row.id });
  });
});
