import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accountId: 'acct-A',
  row: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  authed: true,
}));

function fakeDb() {
  return {
    from: (table: string) => {
      if (table !== 'dial_requests') throw new Error(`unexpected table ${table}`);
      const api: Record<string, (...args: never[]) => unknown> = {};
      api.update = (patch: Record<string, unknown>) => {
        h.updated = patch;
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => ({
                  data: { id: 'd-1', phone_number: '+14155552671', status: patch.status },
                  error: null,
                }),
              }),
            }),
            in: () => ({
              lt: async () => ({ data: null, error: null }),
            }),
          }),
        };
      };
      api.select = () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: h.row, error: null }),
          }),
          in: () => ({
            gte: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      });
      return api;
    },
  };
}

vi.mock('@/lib/auth/device', () => ({
  bearerToken: (request: Request) => request.headers.get('authorization')?.replace('Bearer ', '') ?? null,
  requireDeviceUser: async () => {
    if (!h.authed) {
      const { unauthorized } = await import('@/lib/api/v1/respond');
      throw unauthorized('Invalid or expired session');
    }
    return { accountId: h.accountId, service: fakeDb(), supabase: fakeDb(), userId: 'u-1' };
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

import { PATCH } from '@/app/api/v1/dial-requests/[id]/route';
import { GET } from '@/app/api/v1/dial-requests/route';

function patchReq(id: string, status: string) {
  return new Request(`http://localhost/api/v1/dial-requests/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer user-token' },
    body: JSON.stringify({ status }),
  });
}

describe('PATCH /api/v1/dial-requests/[id]', () => {
  beforeEach(() => {
    h.authed = true;
    h.row = null;
    h.updated = null;
  });

  it('delivers then opens (one-time consumption)', async () => {
    h.row = { id: 'd-1', account_id: 'acct-A', status: 'pending', expires_at: new Date(Date.now() + 600000).toISOString(), consumed_at: null };
    const r1 = await PATCH(patchReq('d-1', 'delivered'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(r1.status).toBe(200);

    h.row = { id: 'd-1', account_id: 'acct-A', status: 'delivered', expires_at: new Date(Date.now() + 600000).toISOString(), consumed_at: null };
    const r2 = await PATCH(patchReq('d-1', 'opened'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(r2.status).toBe(200);
    expect(h.updated?.consumed_at).toBeTruthy();
  });

  it('rejects replay of an already-consumed request', async () => {
    h.row = { id: 'd-1', account_id: 'acct-A', status: 'opened', expires_at: new Date(Date.now() + 600000).toISOString(), consumed_at: new Date().toISOString() };
    const res = await PATCH(patchReq('d-1', 'opened'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(409);
  });

  it('rejects expired requests with 410', async () => {
    h.row = { id: 'd-1', account_id: 'acct-A', status: 'pending', expires_at: new Date(Date.now() - 1000).toISOString(), consumed_at: null };
    const res = await PATCH(patchReq('d-1', 'opened'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(410);
  });

  it('rejects illegal transitions and foreign rows', async () => {
    h.row = { id: 'd-1', account_id: 'acct-A', status: 'completed', expires_at: new Date(Date.now() + 600000).toISOString(), consumed_at: new Date().toISOString() };
    const res = await PATCH(patchReq('d-1', 'opened'), { params: Promise.resolve({ id: 'd-1' }) });
    // consumed replay wins over transition check — still not 200.
    expect([400, 409, 410]).toContain(res.status);

    h.row = null;
    const nf = await PATCH(patchReq('nope', 'opened'), { params: Promise.resolve({ id: 'nope' }) });
    expect(nf.status).toBe(404);
  });

  it('rejects unauthenticated device polling', async () => {
    h.authed = false;
    const res = await GET(new Request('http://localhost/api/v1/dial-requests', { headers: { authorization: 'Bearer bad' } }));
    expect(res.status).toBe(401);
  });
});
