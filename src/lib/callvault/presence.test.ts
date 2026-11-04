// ============================================================
// classifyPresence / shouldCreateEvent / disconnectDuration
// matrix (src/lib/callvault/presence.ts).
//
// Precedence under test: revoked beats timeout, expired beats
// disconnect, and the 120s boundary is strictly-greater-than
// (exactly-120s still reads connected). Dialog logic is
// untested (node env, consistent with repo — no component
// tests for this surface).
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  classifyPresence,
  disconnectDuration,
  DISCONNECT_TIMEOUT_S,
  isRevokedDevice,
  isSessionExpired,
  isStale,
  shouldCreateEvent,
} from './presence';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

describe('classifyPresence', () => {
  it('reads a freshly-seen, healthy device as connected', () => {
    expect(
      classifyPresence({
        lastSeenAt: iso(NOW - 30_000),
        revoked: false,
        sessionCreatedAt: iso(NOW - 10 * MIN),
        now: NOW,
      }),
    ).toBe('connected');
  });

  it('reads a device unseen past 120s as disconnected', () => {
    expect(
      classifyPresence({
        lastSeenAt: iso(NOW - (DISCONNECT_TIMEOUT_S + 1) * 1000),
        revoked: false,
        sessionCreatedAt: iso(NOW - 10 * MIN),
        now: NOW,
      }),
    ).toBe('disconnected');
  });

  it('treats exactly-120s as still connected (strictly-greater-than rule)', () => {
    expect(
      classifyPresence({
        lastSeenAt: iso(NOW - DISCONNECT_TIMEOUT_S * 1000),
        revoked: false,
        sessionCreatedAt: iso(NOW - 10 * MIN),
        now: NOW,
      }),
    ).toBe('connected');
  });

  it('treats a null last_seen (never reported) as disconnected', () => {
    expect(
      classifyPresence({
        lastSeenAt: null,
        revoked: false,
        sessionCreatedAt: iso(NOW - 10 * MIN),
        now: NOW,
      }),
    ).toBe('disconnected');
  });

  it('revoked beats timeout: a stale revoked device is remote_logout, not disconnected', () => {
    expect(
      classifyPresence({
        lastSeenAt: iso(NOW - 60 * MIN),
        revoked: true,
        sessionCreatedAt: iso(NOW - 10 * MIN),
        now: NOW,
      }),
    ).toBe('remote_logout');
  });

  it('revoked beats freshness too: a recently-seen revoked device is still remote_logout', () => {
    expect(
      classifyPresence({
        lastSeenAt: iso(NOW - 5_000),
        revoked: true,
        sessionCreatedAt: iso(NOW - 10 * MIN),
        now: NOW,
      }),
    ).toBe('remote_logout');
  });

  it('expired beats disconnect: a stale 61-day-old session is session_expired', () => {
    expect(
      classifyPresence({
        lastSeenAt: iso(NOW - 60 * MIN),
        revoked: false,
        sessionCreatedAt: iso(NOW - 61 * 24 * 60 * MIN),
        now: NOW,
      }),
    ).toBe('session_expired');
  });

  it('revoked beats expired: an owner-logged-out old session stays remote_logout', () => {
    expect(
      classifyPresence({
        lastSeenAt: iso(NOW - 60 * MIN),
        revoked: true,
        sessionCreatedAt: iso(NOW - 61 * 24 * 60 * MIN),
        now: NOW,
      }),
    ).toBe('remote_logout');
  });
});

describe('isRevokedDevice', () => {
  it('matches revoked_session_id === session_id (session-scoped)', () => {
    expect(
      isRevokedDevice({
        revokedAt: null,
        revokedSessionId: 'sid-a',
        sessionId: 'sid-a',
      }),
    ).toBe(true);
  });

  it('ignores a stale revoked_session_id after the session healed', () => {
    expect(
      isRevokedDevice({
        revokedAt: null,
        revokedSessionId: 'sid-a',
        sessionId: 'sid-b',
      }),
    ).toBe(false);
  });

  it('treats revoked_at as revoked even without session ids', () => {
    expect(
      isRevokedDevice({ revokedAt: iso(NOW), revokedSessionId: null, sessionId: null }),
    ).toBe(true);
  });

  it('reads a healthy row as not revoked', () => {
    expect(
      isRevokedDevice({ revokedAt: null, revokedSessionId: null, sessionId: 'sid-a' }),
    ).toBe(false);
  });
});

describe('isSessionExpired / isStale', () => {
  it('expires a session created 60d+ ago', () => {
    expect(isSessionExpired(iso(NOW - 61 * 24 * 60 * MIN), NOW)).toBe(true);
    expect(isSessionExpired(iso(NOW - 10 * MIN), NOW)).toBe(false);
  });

  it('never expires on an unparseable created_at', () => {
    expect(isSessionExpired(null, NOW)).toBe(false);
    expect(isSessionExpired('not-a-date', NOW)).toBe(false);
  });

  it('stales null/unparseable last_seen', () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale('garbage', NOW)).toBe(true);
    expect(isStale(iso(NOW - 1_000), NOW)).toBe(false);
  });
});

describe('shouldCreateEvent', () => {
  const base = {
    lastSeenAt: iso(NOW - 10 * MIN),
    revoked: false,
    sessionCreatedAt: iso(NOW - 10 * MIN),
    now: NOW,
    hasOpenEvent: false,
  };

  it('fires for a stale healthy device with no open event', () => {
    expect(shouldCreateEvent(base)).toBe(true);
  });

  it('stays quiet for fresh devices', () => {
    expect(shouldCreateEvent({ ...base, lastSeenAt: iso(NOW - 5_000) })).toBe(false);
  });

  it('never fires for revoked or expired rows', () => {
    expect(shouldCreateEvent({ ...base, revoked: true })).toBe(false);
    expect(
      shouldCreateEvent({ ...base, sessionCreatedAt: iso(NOW - 61 * 24 * 60 * MIN) }),
    ).toBe(false);
  });

  it('never double-fires while an event is already open', () => {
    expect(shouldCreateEvent({ ...base, hasOpenEvent: true })).toBe(false);
  });
});

describe('disconnectDuration', () => {
  it('measures a closed episode', () => {
    expect(disconnectDuration(NOW - 5 * MIN, NOW - 2 * MIN, NOW)).toBe(3 * MIN);
  });

  it('measures an ongoing episode against now', () => {
    expect(disconnectDuration(NOW - 5 * MIN, null, NOW)).toBe(5 * MIN);
  });

  it('floors inverted/garbage inputs at 0', () => {
    expect(disconnectDuration(NOW, NOW - MIN, NOW)).toBe(0);
    expect(disconnectDuration(NaN, null, NOW)).toBe(0);
  });
});
