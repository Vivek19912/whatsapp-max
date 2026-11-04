// ============================================================
// GET /api/callvault/device-events — owner-only history;
// agents/admins/viewers 403; cross-account targets 404;
// newest-50 cap enforced server-side; agent name resolved
// server-side from profiles.full_name.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'owner' as string,
  accountId: 'acct-A',
  member: { user_id: 'agent-1', full_name: 'Agent One' } as {
    user_id: string;
    full_name: string;
  } | null,
  events: [] as Array<Record<string, unknown>>,
  limitArg: 0,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => {
    if (!h.role) throw statusError(401, 'Unauthorized');
    return {
      supabase: {},
      accountId: h.accountId,
      userId: 'owner-1',
      role: h.role,
      account: { id: h.accountId, name: 'Acme' },
    };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && 'status' in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status },
    );
  },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: h.member, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'callvault_device_events') {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.order = () => q;
        q.limit = async (n: number) => {
          h.limitArg = n;
          return { data: h.events, error: null };
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { GET } = await import('./route');

function req(userId?: string) {
  const qs = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
  return new Request(`https://app.test/api/callvault/device-events${qs}`);
}

beforeEach(() => {
  h.role = 'owner';
  h.accountId = 'acct-A';
  h.member = { user_id: 'agent-1', full_name: 'Agent One' };
  h.events = [];
  h.limitArg = 0;
});

describe('GET /api/callvault/device-events', () => {
  it('returns recent events with the server-resolved agent name', async () => {
    h.events = [
      {
        id: 'evt-1',
        device_id: 'phone-1',
        last_seen_at: '2026-11-04T10:00:00.000Z',
        disconnected_at: '2026-11-04T10:02:00.000Z',
        reconnected_at: '2026-11-04T10:10:00.000Z',
        reason: 'disconnect',
      },
    ];
    const res = await GET(req('agent-1'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { events: Array<Record<string, unknown>> };
    expect(json.events).toHaveLength(1);
    expect(json.events[0]).toMatchObject({
      device_id: 'phone-1',
      reason: 'disconnect',
      agent_name: 'Agent One',
    });
  });

  it('caps history at 50 server-side', async () => {
    await GET(req('agent-1'));
    expect(h.limitArg).toBe(50);
  });

  it('400s without user_id', async () => {
    const res = await GET(req());
    expect(res.status).toBe(400);
  });

  it('403s for agent, admin, and viewer callers', async () => {
    for (const role of ['agent', 'admin', 'viewer']) {
      h.role = role;
      const res = await GET(req('agent-1'));
      expect(res.status).toBe(403);
    }
  });

  it('404s for a cross-account target (no existence leak)', async () => {
    h.member = null;
    const res = await GET(req('user-other-account'));
    expect(res.status).toBe(404);
  });
});
