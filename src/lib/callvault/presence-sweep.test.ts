// ============================================================
// runPresenceSweep live-reconciliation (migration 153 P0 fix).
//
// A stale last_seen_at with a fresh sidecar heartbeat must NOT
// open a disconnect event (failed touch writes). Snapshot
// unavailable/malformed fails the sweep with zero writes.
// All doubles are in-memory; no database is touched.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import {
  isLiveInSnapshot,
  parseSnapshotEntry,
  runPresenceSweep,
  type FetchSnapshot,
  type LivePresence,
} from './presence-sweep';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const SID_A = '11111111-2222-4333-8444-555555555555';
const SID_OLD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ACCT_A = 'aaaaaaaa-1111-4333-8444-555555555555';
const AGENT_1 = 'bbbbbbbb-2222-4333-8444-555555555555';
const ACCT_B = 'cccccccc-3333-4333-8444-555555555555';
const AGENT_9 = 'dddddddd-4444-4333-8444-555555555555';

interface State {
  devices: Array<Record<string, unknown>>;
  devicesError: { message: string } | null;
  writes: Array<Record<string, unknown>>;
  openKeys: Set<string>;
}

const state: State = { devices: [], devicesError: null, writes: [], openKeys: new Set() };

function mockAdmin() {
  return {
    from: (table: string) => {
      if (table === 'callvault_devices') {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.or = () => q;
        q.eq = () => q;
        q.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            state.devicesError
              ? { data: null, error: state.devicesError }
              : { data: state.devices, error: null },
          ).then(resolve);
        return q;
      }
      if (table === 'callvault_device_events') {
        return {
          insert: async (row: Record<string, unknown>) => {
            const key = `${row.account_id}:${row.device_id}`;
            if (state.openKeys.has(key)) {
              return { error: { code: '23505', message: 'duplicate key' } };
            }
            state.openKeys.add(key);
            state.writes.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    // oxlint-disable-next-line no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function staleDevice(over: Record<string, unknown> = {}) {
  return {
    account_id: ACCT_A,
    user_id: AGENT_1,
    device_id: 'phone-1',
    session_id: SID_A,
    revoked_session_id: null,
    revoked_at: null,
    last_seen_at: iso(NOW - 10 * MIN),
    created_at: iso(NOW - 10 * MIN),
    ...over,
  };
}

function liveEntry(over: Partial<LivePresence> = {}): LivePresence {
  return {
    accountId: ACCT_A,
    userId: AGENT_1,
    deviceId: 'phone-1',
    sessionId: SID_A,
    lastHeartbeatAtMs: NOW - 20_000,
    ...over,
  };
}

const snapOk = (connections: LivePresence[]): FetchSnapshot => async () => ({
  ok: true,
  connections,
});

beforeEach(() => {
  state.devices = [];
  state.devicesError = null;
  state.writes = [];
  state.openKeys = new Set();
});

describe('live-presence reconciliation', () => {
  it('1. live heartbeat + healthy DB → no event', async () => {
    state.devices = [staleDevice({ last_seen_at: iso(NOW - 20_000) })];
    const res = await runPresenceSweep(
      mockAdmin(),
      new Date(NOW),
      snapOk([liveEntry()]),
    );
    expect(res.disconnected).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it('2. live heartbeat + STALE db timestamp (failed touch) → no false event', async () => {
    state.devices = [staleDevice()];
    const res = await runPresenceSweep(
      mockAdmin(),
      new Date(NOW),
      snapOk([liveEntry()]),
    );
    expect(res.disconnected).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it('3. sustained touch failures + live socket → still no event', async () => {
    state.devices = [staleDevice({ last_seen_at: iso(NOW - 30 * MIN) })];
    for (let i = 0; i < 3; i += 1) {
      const res = await runPresenceSweep(
        mockAdmin(),
        new Date(NOW + i * MIN),
        snapOk([liveEntry({ lastHeartbeatAtMs: NOW + i * MIN - 20_000 })]),
      );
      expect(res.disconnected).toBe(0);
    }
    expect(state.writes).toEqual([]);
  });

  it('4. DB recovers (fresh timestamp) → no event, no contradiction', async () => {
    state.devices = [staleDevice({ last_seen_at: iso(NOW - 20_000) })];
    const res = await runPresenceSweep(
      mockAdmin(),
      new Date(NOW),
      snapOk([]),
    );
    expect(res.disconnected).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it('5. truly stale + absent from snapshot → exactly one event', async () => {
    state.devices = [staleDevice()];
    const res = await runPresenceSweep(
      mockAdmin(),
      new Date(NOW),
      snapOk([]),
    );
    expect(res.disconnected).toBe(1);
    expect(state.writes).toHaveLength(1);
  });

  it('8. malformed snapshot entries are ignored, not trusted', async () => {
    expect(parseSnapshotEntry(null)).toBeNull();
    expect(parseSnapshotEntry({})).toBeNull();
    expect(
      parseSnapshotEntry({
        account_id: 'acct-A',
        user_id: 'agent-1',
        device_id: 'phone-1',
        session_id: SID_A,
        last_heartbeat_at: 'not-a-date',
      }),
    ).toBeNull();
    const good = parseSnapshotEntry({
      account_id: ACCT_A,
      user_id: AGENT_1,
      device_id: 'phone-1',
      session_id: SID_A,
      last_heartbeat_at: iso(NOW - 10_000),
    });
    expect(good?.deviceId).toBe('phone-1');
  });

  it('9. another-account entry never suppresses', async () => {
    state.devices = [staleDevice()];
    const res = await runPresenceSweep(
      mockAdmin(),
      new Date(NOW),
      snapOk([liveEntry({ accountId: ACCT_B })]),
    );
    expect(res.disconnected).toBe(1);
    expect(state.writes).toHaveLength(1);
  });

  it('10. old-session heartbeat never suppresses the current session', async () => {
    state.devices = [staleDevice()];
    const res = await runPresenceSweep(
      mockAdmin(),
      new Date(NOW),
      snapOk([liveEntry({ sessionId: SID_OLD })]),
    );
    expect(res.disconnected).toBe(1);
    expect(state.writes).toHaveLength(1);
  });

  it('11. heartbeat landing mid-sweep suppresses via final freshness check', async () => {
    state.devices = [staleDevice()];
    let calls = 0;
    const fetch: FetchSnapshot = async () => {
      calls += 1;
      // First read: nothing live (stale DB, no heartbeat yet).
      // Second read (pre-insert): the heartbeat just landed.
      return calls === 1
        ? { ok: true, connections: [] }
        : { ok: true, connections: [liveEntry()] };
    };
    const res = await runPresenceSweep(mockAdmin(), new Date(NOW), fetch);
    expect(calls).toBe(2);
    expect(res.disconnected).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it('12. concurrent double sweep → single event (partial unique index)', async () => {
    state.devices = [staleDevice()];
    const empty: FetchSnapshot = async () => ({ ok: true, connections: [] });
    const [a, b] = await Promise.all([
      runPresenceSweep(mockAdmin(), new Date(NOW), empty),
      runPresenceSweep(mockAdmin(), new Date(NOW), empty),
    ]);
    expect(a.disconnected + b.disconnected).toBe(1);
    expect(state.writes).toHaveLength(1);
  });

  it('isLiveInSnapshot requires exact identity + fresh heartbeat', () => {
    const row = {
      account_id: ACCT_A,
      user_id: AGENT_1,
      device_id: 'phone-1',
      session_id: SID_A,
    };
    expect(isLiveInSnapshot(row, [liveEntry()], NOW)).toBe(true);
    expect(
      isLiveInSnapshot(row, [liveEntry({ deviceId: 'phone-2' })], NOW),
    ).toBe(false);
    expect(
      isLiveInSnapshot(
        row,
        [liveEntry({ lastHeartbeatAtMs: NOW - 10 * MIN })],
        NOW,
      ),
    ).toBe(false);
  });
});

describe('snapshot failure semantics', () => {
  it('6. snapshot unavailable → throws (route: 503) with zero writes', async () => {
    state.devices = [staleDevice()];
    const failing: FetchSnapshot = async () => ({
      ok: false,
      reason: 'sidecar unreachable (Error)',
    });
    await expect(
      runPresenceSweep(mockAdmin(), new Date(NOW), failing),
    ).rejects.toThrow(/snapshot unavailable/);
    expect(state.writes).toEqual([]);
  });

  it('snapshot failure precedes any insert (no partial marks)', async () => {
    state.devices = [staleDevice(), staleDevice({ device_id: 'phone-2' })];
    let calls = 0;
    const flaky: FetchSnapshot = async () => {
      calls += 1;
      // Initial read fine; final freshness re-read fails.
      return calls === 1
        ? { ok: true, connections: [] }
        : { ok: false, reason: 'sidecar HTTP 500' };
    };
    await expect(
      runPresenceSweep(mockAdmin(), new Date(NOW), flaky),
    ).rejects.toThrow(/snapshot unavailable/);
    expect(state.writes).toEqual([]);
  });
});
