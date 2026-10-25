import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accountId: 'acct-A',
  row: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  authed: true,
  list: [] as Array<Record<string, unknown>>,
  failUpdate: false,
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
                maybeSingle: async () =>
                  h.failUpdate
                    ? { data: null, error: { message: 'boom' } }
                    : {
                        data: {
                          id: 'd-1',
                          phone_number: '+14155552671',
                          status: patch.status,
                        },
                        error: null,
                      },
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
                limit: async () => ({ data: h.list, error: null }),
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

import { PATCH, POST as ACK_POST } from '@/app/api/v1/dial-requests/[id]/route';
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

  it('completes the full tap lifecycle delivered -> opened -> completed', async () => {
    h.row = { id: 'd-1', account_id: 'acct-A', status: 'opened', expires_at: new Date(Date.now() + 600000).toISOString(), consumed_at: new Date().toISOString() };
    const res = await PATCH(patchReq('d-1', 'completed'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { dial_request: { status: string } } };
    expect(json.data.dial_request.status).toBe('completed');
  });

  it('accepts the POST alias with the identical handler', async () => {
    // Device transport is POST (some HttpURLConnection stacks
    // reject the PATCH method itself); both verbs share handleAck.
    h.row = { id: 'd-1', account_id: 'acct-A', status: 'pending', expires_at: new Date(Date.now() + 600000).toISOString(), consumed_at: null };
    const res = await ACK_POST(
      new Request('http://localhost/api/v1/dial-requests/d-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer user-token' },
        body: JSON.stringify({ status: 'delivered' }),
      }),
      { params: Promise.resolve({ id: 'd-1' }) }
    );
    expect(res.status).toBe(200);
  });

  it('surfaces persistence failures instead of false success', async () => {
    h.failUpdate = true;
    h.row = { id: 'd-1', account_id: 'acct-A', status: 'pending', expires_at: new Date(Date.now() + 600000).toISOString(), consumed_at: null };
    const res = await PATCH(patchReq('d-1', 'delivered'), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(500);
    h.failUpdate = false;
  });

  it('rejects unauthenticated device polling', async () => {
    h.authed = false;
    const res = await GET(new Request('http://localhost/api/v1/dial-requests', { headers: { authorization: 'Bearer bad' } }));
    expect(res.status).toBe(401);
    h.authed = true;
  });
});

describe('GET /api/v1/dial-requests (device poll contract)', () => {
  beforeEach(() => {
    h.authed = true;
    h.list = [];
  });

  it('returns the exact envelope CallVault parses', async () => {
    // Must stay in lockstep with DialRequests.parseList on Android:
    // { data: { dial_requests: [ {id, phone_number, contact_id,
    // flow_id, run_id, status, expires_at, created_at} ] } }.
    h.list = [
      {
        id: 'd-1',
        phone_number: '+14155552671',
        contact_id: 'c-1',
        flow_id: 'f-1',
        run_id: 'r-1',
        status: 'pending',
        expires_at: '2030-01-01T00:00:00Z',
        created_at: '2030-01-01T00:00:00Z',
      },
      {
        id: 'd-2',
        phone_number: '+442079460958',
        contact_id: null,
        flow_id: null,
        run_id: null,
        status: 'delivered',
        expires_at: '2030-01-01T00:00:00Z',
        created_at: '2030-01-01T00:00:00Z',
      },
    ];
    const res = await GET(
      new Request('http://localhost/api/v1/dial-requests', {
        headers: { authorization: 'Bearer user-token' },
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { dial_requests: Array<Record<string, unknown>> };
    };
    expect(json.data.dial_requests).toHaveLength(2);
    const first = json.data.dial_requests[0] as Record<string, unknown>;
    for (const field of [
      'id',
      'phone_number',
      'contact_id',
      'flow_id',
      'run_id',
      'status',
      'expires_at',
      'created_at',
    ]) {
      expect(first, `field ${field}`).toHaveProperty(field);
    }
    expect(first.phone_number).toBe('+14155552671');
  });

  it('returns an empty list (not an error) when nothing is pending', async () => {
    h.list = [];
    const res = await GET(
      new Request('http://localhost/api/v1/dial-requests', {
        headers: { authorization: 'Bearer user-token' },
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { dial_requests: unknown[] } };
    expect(json.data.dial_requests).toEqual([]);
  });
});
