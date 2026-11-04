// ============================================================
// GET /api/auth/callvault-devices/status?device_id= — the phone
// polls its own revocation state.
//
// Device auth; the row must match the token identity
// (account + user + device) or it 404s — no existence leak, no
// cross-device oracle. Response: { revoked: boolean }.
// ============================================================

import { NextResponse } from 'next/server';

import { requireDeviceUser, sanitizeDeviceId } from '@/lib/auth/device';
import {
  badRequest,
  fail,
  toApiErrorResponse,
} from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const dev = await requireDeviceUser(request);

    const url = new URL(request.url);
    const deviceId = sanitizeDeviceId(url.searchParams.get('device_id'));
    if (!deviceId) {
      throw badRequest("'device_id' is required");
    }

    const { data: row, error } = await dev.service
      .from('callvault_devices')
      .select('session_id, revoked_session_id')
      .eq('account_id', dev.accountId)
      .eq('user_id', dev.userId)
      .eq('device_id', deviceId)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      return fail('not_found', 'Device not found', 404);
    }
    const typed = row as {
      session_id?: unknown;
      revoked_session_id?: unknown;
    };
    const revoked =
      typeof typed.revoked_session_id === 'string' &&
      typed.revoked_session_id !== '' &&
      typed.revoked_session_id === typed.session_id;
    return NextResponse.json({ revoked });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
