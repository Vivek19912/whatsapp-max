// ============================================================
// GET /api/callvault/presence-cron + runPresenceSweep.
//
// Covered: Bearer auth (401 bad secret, 503 unconfigured),
// counts-only response, double-run dedupe via the partial
// unique index (23505 → 1 event), revoked + expired skips,
// per-row cross-account isolation, and 503 with ZERO writes
// when the registry is unreachable (never mark on infra
// failure). Dialog logic is untested (node env, consistent
// with repo).
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const SID_A = '11111111-2222-4333-8444-555555555555';

const h = vi.hoisted(() => ({
  devices: [] as Array<Record<string, unknown>>,
  devicesError: null as { message: string } | null,
  writes: [] as Array<Record<string, unknown>>,
  // Keys already holding an OPEN event: inserts for these raise
  // 23505, exactly like the partial unique index under a
  // concurrent cron run.
  openKeys: new Set<string>(),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'callvault_devices') {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.or = () => q;
        q.eq = () => q;
        q.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            h.devicesError
              ? { data: null, error: h.devicesError }
              : { data: h.devices, error: null },
          ).then(resolve);
        return q;
      }
      if (table === 'callvault_device_events') {
        return {
          insert: async (row: Record<string, unknown>) => {
            const key = `${row.account_id}:${row.device_id}`;
            if (h.openKeys.has(key)) {
              return { error: { code: '23505', message: 'duplicate key' } };
            }
            h.openKeys.add(key);
            h.writes.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { GET } = await import('./route');
const { runPresenceSweep } = await import('@/lib/callvault/presence-sweep');
const { supabaseAdmin } = await import('@/lib/flows/admin-client');

function authed() {
  return new Request('https://app.test/api/callvault/presence-cron', {
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
}

function staleDevice(over: Record<string, unknown> = {}) {
  return {
    account_id: 'acct-A',
    user_id: 'agent-1',
    device_id: 'phone-1',
    session_id: SID_A,
    revoked_session_id: null,
    revoked_at: null,
    last_seen_at: iso(NOW - 10 * MIN),
    created_at: iso(NOW - 10 * MIN),
    ...over,
  };
}

beforeEach(() => {
  h.devices = [];
  h.devicesError = null;
  h.writes = [];
  h.openKeys = new Set<string>();
  process.env.CALLVAULT_CRON_SECRET = 'test-cron-secret';
  delete process.env.CRON_SECRET;
  process.env.DIAL_WS_INTERNAL_SECRET = 'test-sidecar-secret';
  // Sidecar snapshot stub (default: no live sockets). Individual
  // tests override via stubSnapshot().
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ connections: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DIAL_WS_INTERNAL_SECRET;
});

function stubSnapshot(connections: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ connections }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function liveEntry() {
  return {
    account_id: 'aaaaaaaa-1111-4333-8444-555555555555',
    user_id: 'bbbbbbbb-2222-4333-8444-555555555555',
    device_id: 'phone-1',
    session_id: SID_A,
    last_heartbeat_at: iso(NOW - 20_000),
  };
}

function uuidDevice(over: Record<string, unknown> = {}) {
  return staleDevice({
    account_id: 'aaaaaaaa-1111-4333-8444-555555555555',
    user_id: 'bbbbbbbb-2222-4333-8444-555555555555',
    ...over,
  });
}

describe('GET /api/callvault/presence-cron auth', () => {
  it('401s on a bad secret', async () => {
    const res = await GET(
      new Request('https://app.test/api/callvault/presence-cron', {
        headers: { Authorization: 'Bearer wrong' },
      }),
    );
    expect(res.status).toBe(401);
    expect(h.writes).toHaveLength(0);
  });

  it('503s when no cron secret is configured (zero writes)', async () => {
    delete process.env.CALLVAULT_CRON_SECRET;
    const res = await GET(authed());
    expect(res.status).toBe(503);
    expect(h.writes).toHaveLength(0);
  });

  it('accepts the CRON_SECRET fallback', async () => {
    delete process.env.CALLVAULT_CRON_SECRET;
    process.env.CRON_SECRET = 'fallback-secret';
    const res = await GET(
      new Request('https://app.test/api/callvault/presence-cron', {
        headers: { Authorization: 'Bearer fallback-secret' },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('runPresenceSweep', () => {
  it('opens one disconnect event for a stale device (counts only, no ids)', async () => {
    h.devices = [staleDevice()];
    const result = await runPresenceSweep(supabaseAdmin(), new Date(NOW));
    expect(result).toEqual({ checked: 1, disconnected: 1, expired: 0 });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      account_id: 'acct-A',
      user_id: 'agent-1',
      device_id: 'phone-1',
      reason: 'disconnect',
    });
    expect(typeof h.writes[0].disconnected_at).toBe('string');
  });

  it('dedupes a double run into 1 event (23505 ignored)', async () => {
    h.devices = [staleDevice()];
    const admin = supabaseAdmin();
    const first = await runPresenceSweep(admin, new Date(NOW));
    const second = await runPresenceSweep(admin, new Date(NOW + MIN));
    expect(first.disconnected).toBe(1);
    expect(second).toEqual({ checked: 1, disconnected: 0, expired: 0 });
    expect(h.writes).toHaveLength(1);
  });

  it('skips fresh devices and revoked rows (remote_logout never alerts)', async () => {
    h.devices = [
      staleDevice({ device_id: 'fresh', last_seen_at: iso(NOW - 5_000) }),
      staleDevice({
        device_id: 'revoked',
        revoked_session_id: SID_A,
        revoked_at: iso(NOW - MIN),
      }),
    ];
    const result = await runPresenceSweep(supabaseAdmin(), new Date(NOW));
    expect(result).toEqual({ checked: 2, disconnected: 0, expired: 0 });
    expect(h.writes).toHaveLength(0);
  });

  it('closes 60-day sessions silently as session_expired (no disconnect count)', async () => {
    h.devices = [
      staleDevice({ device_id: 'old', created_at: iso(NOW - 61 * 24 * 60 * MIN) }),
    ];
    const result = await runPresenceSweep(supabaseAdmin(), new Date(NOW));
    expect(result).toEqual({ checked: 1, disconnected: 0, expired: 1 });
    expect(h.writes[0]).toMatchObject({ device_id: 'old', reason: 'session_expired' });
  });

  it('keeps per-row cross-account isolation (each event carries its own account)', async () => {
    h.devices = [
      staleDevice({ account_id: 'acct-A', user_id: 'agent-1', device_id: 'phone-1' }),
      staleDevice({ account_id: 'acct-B', user_id: 'agent-9', device_id: 'phone-9' }),
    ];
    const result = await runPresenceSweep(supabaseAdmin(), new Date(NOW));
    expect(result).toEqual({ checked: 2, disconnected: 2, expired: 0 });
    const byDevice = Object.fromEntries(h.writes.map((w) => [w.device_id, w]));
    expect(byDevice['phone-1']).toMatchObject({ account_id: 'acct-A', user_id: 'agent-1' });
    expect(byDevice['phone-9']).toMatchObject({ account_id: 'acct-B', user_id: 'agent-9' });
  });
});

describe('GET /api/callvault/presence-cron infra failure', () => {
  it('503s with ZERO writes when the registry is unreachable', async () => {
    h.devices = [staleDevice()];
    h.devicesError = { message: 'connection reset' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await GET(authed());
    expect(res.status).toBe(503);
    expect(h.writes).toHaveLength(0);
    expect(err).toHaveBeenCalled();
  });

  it('returns {checked, disconnected, expired} counts on success', async () => {
    h.devices = [staleDevice()];
    const res = await GET(authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 1, disconnected: 1, expired: 0 });
  });

  it('suppresses the event when the sidecar reports a live heartbeat', async () => {
    // Time-relative (not the frozen NOW fixture): suppression
    // compares the heartbeat receipt stamp against the real now
    // the route passes to the sweep.
    const nowMs = Date.now();
    h.devices = [
      uuidDevice({
        last_seen_at: iso(nowMs - 10 * MIN),
        created_at: iso(nowMs - 10 * MIN),
      }),
    ];
    stubSnapshot([
      { ...liveEntry(), last_heartbeat_at: iso(nowMs - 20_000) },
    ]);
    const res = await GET(authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 1, disconnected: 0, expired: 0 });
    expect(h.writes).toHaveLength(0);
  });

  it('503s with zero writes when the sidecar snapshot is unreachable', async () => {
    h.devices = [staleDevice()];
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await GET(authed());
    expect(res.status).toBe(503);
    expect(h.writes).toHaveLength(0);
    expect(err).toHaveBeenCalled();
  });

  it('503s with zero writes on snapshot 401 / malformed payload', async () => {
    h.devices = [staleDevice()];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"error":"unauthorized"}', { status: 401 }),
    );
    expect((await GET(authed())).status).toBe(503);
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"connections":"nope"}', { status: 200 }),
    );
    expect((await GET(authed())).status).toBe(503);
    expect(h.writes).toHaveLength(0);
    expect(err).toHaveBeenCalled();
  });
});
