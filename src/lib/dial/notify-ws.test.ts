import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notifyDeviceLogout, notifyDialRequest, notifyDialStatus } from './notify-ws';

const TARGET = {
  id: '11111111-1111-4111-8111-111111111111',
  account_id: '22222222-2222-4222-8222-222222222222',
  requested_by: '33333333-3333-4333-8333-333333333333',
  status: 'pending',
  expires_at: '2030-01-01T00:00:00.000Z',
  created_at: '2026-11-01T00:00:00.000Z',
};

describe('dial sidecar notify', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.DIAL_WS_INTERNAL_SECRET;
    delete process.env.DIAL_WS_INTERNAL_URL;
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs?.();
  });

  it('stays silent and false without a configured secret', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(notifyDialRequest(TARGET)).resolves.toBe(false);
    await expect(notifyDialStatus({ ...TARGET, status: 'opened' })).resolves.toBe(false);
    await expect(
      notifyDeviceLogout({
        account_id: TARGET.account_id,
        user_id: TARGET.requested_by,
        device_id: 'phone-1',
        session_id: TARGET.id,
      })
    ).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts the status event with ids only (never the number)', async () => {
    process.env.DIAL_WS_INTERNAL_SECRET = 'test-secret';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response('{"accepted":true}', { status: 202 });
      })
    );
    await expect(notifyDialStatus({ ...TARGET, status: 'opened' })).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:3001/internal/status-event');
    const body = JSON.parse(String((calls[0]!.init as RequestInit).body));
    expect(body).toEqual({
      request_id: TARGET.id,
      account_id: TARGET.account_id,
      user_id: TARGET.requested_by,
      status: 'opened',
    });
    expect(JSON.stringify(calls)).not.toContain('+1');
    const headers = new Headers((calls[0]!.init as RequestInit).headers);
    expect(headers.get('x-dial-internal-secret')).toBe('test-secret');
  });

  it('swallows transport failures and non-2xx without throwing', async () => {
    process.env.DIAL_WS_INTERNAL_SECRET = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('unreachable');
      })
    );
    await expect(notifyDialStatus({ ...TARGET, status: 'failed' })).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(notifyDialStatus({ ...TARGET, status: 'failed' })).resolves.toBe(false);
  });

  it('posts the logout event with identity only (never tokens)', async () => {
    process.env.DIAL_WS_INTERNAL_SECRET = 'test-secret';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response('{"delivered":true}', { status: 200 });
      })
    );
    await expect(
      notifyDeviceLogout({
        account_id: TARGET.account_id,
        user_id: TARGET.requested_by,
        device_id: 'phone-1',
        session_id: TARGET.id,
      })
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:3001/internal/logout-device');
    const body = JSON.parse(String((calls[0]!.init as RequestInit).body));
    expect(body).toEqual({
      account_id: TARGET.account_id,
      user_id: TARGET.requested_by,
      device_id: 'phone-1',
      session_id: TARGET.id,
    });
    const headers = new Headers((calls[0]!.init as RequestInit).headers);
    expect(headers.get('x-dial-internal-secret')).toBe('test-secret');
  });

  it('returns false for logout transport failures and rejections', async () => {
    process.env.DIAL_WS_INTERNAL_SECRET = 'test-secret';
    const target = {
      account_id: TARGET.account_id,
      user_id: TARGET.requested_by,
      device_id: 'phone-1',
      session_id: TARGET.id,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('unreachable');
      })
    );
    await expect(notifyDeviceLogout(target)).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(notifyDeviceLogout(target)).resolves.toBe(false);
  });
});
