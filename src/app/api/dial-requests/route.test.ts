import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accountId: 'acct-A',
  userId: 'user-1',
  role: 'agent' as string,
  authed: true,
  contacts: [{ id: 'c-1' }] as Array<{ id: string }>,
  flows: [{ id: 'f-1' }] as Array<{ id: string }>,
  lastInsert: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
}));

function tableMock(table: string) {
  if (table === 'contacts' || table === 'flows') {
    const rows = table === 'contacts' ? h.contacts : h.flows;
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: rows.length ? rows[0] : null,
              error: null,
            }),
          }),
        }),
      }),
    };
  }
  return {
    insert: (obj: Record<string, unknown>) => {
      h.lastInsert = obj;
      return {
        select: () => ({
          single: async () => {
            if ((obj.idempotency_key as string) === 'dup-key' && h.existing) {
              return { data: null, error: { code: '23505' } };
            }
            return {
              data: {
                id: 'd-1',
                phone_number: obj.phone_number,
                status: 'pending',
                expires_at: new Date(Date.now() + 600000).toISOString(),
                created_at: new Date().toISOString(),
              },
              error: null,
            };
          },
        }),
      };
    },
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: h.existing, error: null }),
        }),
      }),
    }),
  };
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    getCurrentAccount: async () => {
      if (!h.authed) throw new actual.UnauthorizedError();
      return {
        supabase: { from: (t: string) => tableMock(t) },
        userId: h.userId,
        accountId: h.accountId,
        role: h.role,
        account: { id: h.accountId, name: 'A' },
      };
    },
  };
});

const notifyDialRequest = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/lib/dial/notify-ws', () => ({ notifyDialRequest }));

import { POST, GET } from '@/app/api/dial-requests/route';

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/dial-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dial-requests', () => {
  beforeEach(() => {
    h.authed = true;
    h.contacts = [{ id: 'c-1' }];
    h.flows = [{ id: 'f-1' }];
    h.existing = null;
    h.lastInsert = null;
    notifyDialRequest.mockClear();
  });

  it('creates a request with normalized number and tel-safe storage', async () => {
    const res = await POST(req({ phone_number: '+91 88856 38563', idempotency_key: 'k-1' }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { tel_uri?: string };
    expect(json.tel_uri).toBe('tel:+918885638563');
    expect(h.lastInsert?.phone_number).toBe('+918885638563');
    // Account/user derive from session, never from body.
    expect(h.lastInsert?.account_id).toBe('acct-A');
    expect(h.lastInsert?.requested_by).toBe('user-1');
    // The durable row is followed by exactly one socket signal,
    // scoped to the clicking user and carrying ids only.
    expect(notifyDialRequest).toHaveBeenCalledTimes(1);
    expect(notifyDialRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'd-1',
        account_id: 'acct-A',
        requested_by: 'user-1',
      })
    );
  });

  it('rejects empty and malformed numbers without touching lead data', async () => {
    for (const bad of ['', 'n/a', '0000000', '123']) {
      const res = await POST(req({ phone_number: bad, idempotency_key: `k-${bad}` }));
      expect(res.status).toBe(400);
    }
    expect(h.lastInsert).toBeNull();
  });

  it('rejects cross-account contacts (404, not 403 oracle)', async () => {
    h.contacts = [];
    const res = await POST(
      req({ phone_number: '+14155552671', contact_id: '11111111-1111-4111-8111-111111111111', idempotency_key: 'k-x' })
    );
    expect(res.status).toBe(404);
  });

  it('returns existing row on duplicate idempotency key', async () => {
    h.existing = { id: 'd-old', phone_number: '+14155552671', status: 'pending' };
    const res = await POST(req({ phone_number: '+14155552671', idempotency_key: 'dup-key' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deduped?: boolean };
    expect(json.deduped).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    h.authed = false;
    const res = await POST(req({ phone_number: '+14155552671' }));
    expect(res.status).toBe(401);
  });

  it('GET by id is account-scoped', async () => {
    const res = await GET(new Request('http://localhost/api/dial-requests?id=not-a-uuid'));
    expect(res.status).toBe(400);
  });
});
