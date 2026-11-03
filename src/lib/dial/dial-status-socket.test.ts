import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetDialStatusSocketForTest,
  subscribeDialStatus,
} from './dial-status-socket';
import type { DialSocketSupabase } from './dial-status-socket';

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  }),
}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(): void {}
  close(): void {
    this.closed = true;
  }
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  fail(): void {
    this.readyState = 3;
    this.onerror?.();
  }
}

describe('browser dial status socket (no polling)', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
    vi.stubGlobal('window', {
      location: { protocol: 'https:', host: 'app.test', hostname: 'app.test' },
    } as unknown as Window & typeof globalThis);
    __resetDialStatusSocketForTest();
  });

  afterEach(() => {
    __resetDialStatusSocketForTest();
    vi.unstubAllGlobals();
  });

  it('opens an authenticated browser socket on first subscribe', async () => {
    const seen: unknown[] = [];
    subscribeDialStatus('req-1', (u) => seen.push(u));
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const url = FakeSocket.instances[0]!.url;
    expect(url).toContain('/ws/dial?client=browser');
    expect(url).toContain('access_token=test-token');
    expect(url.startsWith('wss://')).toBe(true);
    expect(seen).toEqual([]);
  });

  it('dispatches status events only to the matching request subscriber', async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    subscribeDialStatus('req-a', (u) => a.push(u));
    subscribeDialStatus('req-b', (u) => b.push(u));
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    FakeSocket.instances[0]!.receive({ type: 'status', request_id: 'req-a', status: 'delivered' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    expect(a[0]).toMatchObject({ requestId: 'req-a', status: 'delivered' });
  });

  it('applies the connect snapshot to all tracked requests at once', async () => {
    const seen: unknown[] = [];
    subscribeDialStatus('req-1', (u) => seen.push(u));
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    FakeSocket.instances[0]!.receive({
      type: 'status_snapshot',
      requests: [
        { id: 'req-1', status: 'opened', expires_at: '2030-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
        { id: 'req-2', status: 'pending', expires_at: '2030-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
      ],
    });
    expect(seen).toEqual([
      { requestId: 'req-1', status: 'opened', expiresAt: '2030-01-01T00:00:00Z' },
    ]);
  });

  it('ignores malformed, foreign and non-status frames', async () => {
    const seen: unknown[] = [];
    subscribeDialStatus('req-1', (u) => seen.push(u));
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const sock = FakeSocket.instances[0]!;
    sock.receive('not json');
    sock.receive({ type: 'dial_request', request_id: 'req-1' });
    sock.receive({ type: 'status', request_id: 42 });
    sock.receive(null);
    expect(seen).toEqual([]);
  });

  it('stops delivering after unsubscribe', async () => {
    const seen: unknown[] = [];
    const off = subscribeDialStatus('req-1', (u) => seen.push(u));
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    off();
    FakeSocket.instances[0]!.receive({ type: 'status', request_id: 'req-1', status: 'delivered' });
    expect(seen).toEqual([]);
  });

  it('reconnects after close and replays the snapshot (no polling)', async () => {
    vi.useFakeTimers();
    try {
      const seen: unknown[] = [];
      subscribeDialStatus('req-1', (u) => seen.push(u));
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
      FakeSocket.instances[0]!.onclose?.();
      // First backoff is 1s; the replays arrive via a fresh snapshot.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));
      FakeSocket.instances[1]!.receive({
        type: 'status_snapshot',
        requests: [{ id: 'req-1', status: 'delivered', expires_at: null, created_at: 'x' }],
      });
      expect(seen.at(-1)).toMatchObject({ requestId: 'req-1', status: 'delivered' });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Auth-recovery tests (MOCKED supabase clients — no network, no live server).
// The shared-client mock above only stubs getSession; these tests inject
// per-test clients via the subscribe() options seam to cover the
// getSession→getUser fallback and the onAuthStateChange lifecycle.
// ---------------------------------------------------------------------------

function stubBrowserGlobals(): void {
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.stubGlobal('window', {
    location: { protocol: 'https:', host: 'app.test', hostname: 'app.test' },
  } as unknown as Window & typeof globalThis);
}

describe('dial status socket auth recovery (mocked)', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    stubBrowserGlobals();
    __resetDialStatusSocketForTest();
  });

  afterEach(() => {
    __resetDialStatusSocketForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('falls back to a bounded getUser() refresh when getSession() is empty', async () => {
    let refreshed = false;
    const getUser = vi.fn(async () => {
      refreshed = true;
      return { data: { user: { id: 'u-1' } } };
    });
    const client: DialSocketSupabase = {
      auth: {
        getSession: async () =>
          refreshed
            ? { data: { session: { access_token: 'fresh-token' } } }
            : { data: { session: null } },
        getUser,
      },
    };
    subscribeDialStatus('req-1', () => {}, { supabase: client });
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances[0]!.url).toContain('access_token=fresh-token');
  });

  it('reconnects with the rotated token on TOKEN_REFRESHED', async () => {
    let currentToken = 'token-a';
    const authCbs: Array<(event: string) => void> = [];
    const client: DialSocketSupabase = {
      auth: {
        getSession: async () => ({
          data: { session: { access_token: currentToken } },
        }),
        onAuthStateChange: (cb) => {
          authCbs.push(cb);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
    };
    subscribeDialStatus('req-1', () => {}, { supabase: client });
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    expect(FakeSocket.instances[0]!.url).toContain('access_token=token-a');

    currentToken = 'token-b';
    authCbs.forEach((cb) => cb('TOKEN_REFRESHED'));
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    expect(FakeSocket.instances[1]!.url).toContain('access_token=token-b');
  });

  it('closes and stops reconnecting on SIGNED_OUT', async () => {
    vi.useFakeTimers();
    try {
      const authCbs: Array<(event: string) => void> = [];
      const client: DialSocketSupabase = {
        auth: {
          getSession: async () => ({
            data: { session: { access_token: 'token-a' } },
          }),
          onAuthStateChange: (cb) => {
            authCbs.push(cb);
            return { data: { subscription: { unsubscribe: () => {} } } };
          },
        },
      };
      subscribeDialStatus('req-1', () => {}, { supabase: client });
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));

      authCbs.forEach((cb) => cb('SIGNED_OUT'));
      expect(FakeSocket.instances[0]!.closed).toBe(true);
      // Parked: no retry loop against the dead session.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-verifies the token (one getUser check) before backing off on 4401', async () => {
    vi.useFakeTimers();
    try {
      const getUser = vi.fn(async () => ({ data: { user: { id: 'u-1' } } }));
      let reads = 0;
      const client: DialSocketSupabase = {
        auth: {
          getSession: async () => {
            reads += 1;
            // Stale local session keeps returning the rejected token;
            // the getUser() round-trip is what lets rotation recover.
            return { data: { session: { access_token: 'stale-token' } } };
          },
          getUser,
        },
      };
      subscribeDialStatus('req-1', () => {}, { supabase: client });
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
      const readsAfterConnect = reads;

      const sock = FakeSocket.instances[0]!;
      (sock.onclose as unknown as ((e: { code: number }) => void) | null)?.({
        code: 4401,
      });
      // One extra verify, then the normal 1s backoff lane (no hot retry).
      await vi.waitFor(() =>
        expect(reads).toBeGreaterThan(readsAfterConnect),
      );
      expect(getUser).toHaveBeenCalledTimes(1);
      expect(FakeSocket.instances.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
