import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accountId: 'acct-A',
  userId: 'u-9',
  row: null as Record<string, unknown> | null,
  notified: [] as Array<Record<string, unknown>>,
  authed: true,
}));

function chainableRead() {
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  chain.eq = () => chain;
  chain.maybeSingle = (async () => ({ data: h.row, error: null })) as (...args: unknown[]) => unknown;
  return chain;
}

function fakeDb() {
  return {
    from: (table: string) => {
      if (table !== 'dial_requests') throw new Error(`unexpected table ${table}`);
      const api: Record<string, never> = {};
      (api as Record<string, (...args: unknown[]) => unknown>).select = () => chainableRead();
      (api as Record<string, (...args: unknown[]) => unknown>).update = (...uargs: unknown[]) => {
        const patch = uargs[0] as Record<string, unknown>;
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => ({
                  data: h.row ? { ...h.row, ...patch } : null,
                  error: h.row ? null : { message: 'no row' },
                }),
              }),
            }),
          }),
        };
      };
      return api;
    },
  };
}

vi.mock('@/lib/auth/device', () => ({
  bearerToken: (request: Request) => request.headers.get('authorization')?.replace('Bearer ', '') ?? null,
  requireDeviceUser: async () => {
    if (!h.authed) throw new Error('unauthorized');
    return { accountId: h.accountId, service: fakeDb(), supabase: fakeDb(), userId: h.userId };
  },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => {
    throw new Error('should not use api key path in these tests');
  },
}));

vi.mock('@/lib/api-keys/keys', () => ({
  looksLikeApiKey: (t: string | null) => !!t?.startsWith('wacrm_live_'),
}));

vi.mock('@/lib/dial/notify-ws', () => ({
  notifyDialRequest: async () => true,
  notifyDialStatus: async (target: Record<string, unknown>) => {
    h.notified.push(target);
    return true;
  },
}));

import { PATCH } from '@/app/api/v1/dial-requests/[id]/route';

function patchReq(id: string, status: string) {
  return new Request(`http://localhost/api/v1/dial-requests/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer user-token' },
    body: JSON.stringify({ status }),
  });
}

const liveRow = () => ({
  id: 'd-1',
  account_id: 'acct-A',
  requested_by: 'u-9',
  status: 'delivered',
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  consumed_at: null,
});

describe('v1 ack fans out the persisted transition (no polling needed)', () => {
  beforeEach(() => {
    h.authed = true;
    h.row = liveRow();
    h.notified = [];
  });

  it('notifies the sidecar with the persisted status after opened', async () => {
    const res = await PATCH(patchReq('d-1', 'opened'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    // Fire-and-forget: exactly one status event, keyed by the row's
    // owning user (not the caller), with the confirmed new status.
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toEqual({
      id: 'd-1',
      account_id: 'acct-A',
      requested_by: 'u-9',
      status: 'opened',
    });
  });

  it('notifies on failed too, so the browser leaves Queued', async () => {
    const res = await PATCH(patchReq('d-1', 'failed'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    expect(h.notified).toEqual([
      { id: 'd-1', account_id: 'acct-A', requested_by: 'u-9', status: 'failed' },
    ]);
  });

  it('never notifies on rejected transitions', async () => {
    // completed -> opened is not an allowed transition... use a
    // terminal row so the ack fails before any write.
    h.row = { ...liveRow(), status: 'completed', consumed_at: new Date().toISOString() };
    const res = await PATCH(patchReq('d-1', 'opened'), { params: Promise.resolve({ id: 'd-1' }) });
    expect([400, 409]).toContain(res.status);
    expect(h.notified).toHaveLength(0);
  });

  it('uses the row owner when the caller has no user context', async () => {
    // API-key callers carry no user id; the row's requested_by is
    // the only correct broadcast target (never a client-supplied id).
    h.row = { ...liveRow(), requested_by: 'u-other' };
    const res = await PATCH(patchReq('d-1', 'cancelled'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    expect(h.notified[0]).toMatchObject({ requested_by: 'u-other', status: 'cancelled' });
  });
});
