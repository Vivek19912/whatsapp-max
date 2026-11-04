// ============================================================
// POST /api/auth/callvault-devices/ack { device_id } — the phone
// confirms it honoured a remote logout.
//
// Device identity auth (requireDeviceIdentity, NOT
// requireDeviceUser): revoked sessions must reach this endpoint
// — routing through the gate would 401 the exact callers that
// need to ack. Accept only when the row (account + user +
// device) exists, its revoked_session_id is non-empty, and the
// token's session (decoded from the VERIFIED bearer, never client
// input) equals that revoked session. On success stamp
// logout_ack_at=now and return { acked: true }.
//
// No-oracle responses: 404 for no row, 403 for session mismatch
// (a revoked phone learns nothing about other devices). No
// tokens logged. Registry read errors are explicit 503.
// ============================================================

import { NextResponse } from 'next/server';

import { requireDeviceIdentity, sanitizeDeviceId } from '@/lib/auth/device';
import { sessionIdFromJwt } from '@/lib/auth/callvault-session';
import {
  badRequest,
  fail,
  toApiErrorResponse,
  unavailable,
} from '@/lib/api/v1/respond';

export async function POST(request: Request) {
  try {
    // Identity-only: revoked sessions must reach the ack.
    const ident = await requireDeviceIdentity(request);
    const tokenSession = sessionIdFromJwt(ident.token);

    const body = (await request.json().catch(() => null)) as {
      device_id?: unknown;
    } | null;
    const deviceId = sanitizeDeviceId(body?.device_id);
    if (!deviceId) {
      throw badRequest("'device_id' is required");
    }

    const { data: row, error } = await ident.service
      .from('callvault_devices')
      .select('device_id, revoked_session_id')
      .eq('account_id', ident.accountId)
      .eq('user_id', ident.userId)
      .eq('device_id', deviceId)
      .maybeSingle();
    if (error) throw unavailable('Device registry temporarily unavailable');
    if (!row) {
      return fail('not_found', 'Device not found', 404);
    }
    const typed = row as { revoked_session_id?: unknown };
    const revoked =
      typeof typed.revoked_session_id === 'string' &&
      typed.revoked_session_id !== '';
    // Session-scoped: only the bearer carrying the revoked
    // session may ack it. Legacy tokens (no session claim) can
    // never ack — 403, same as a mismatched session.
    if (!revoked || !tokenSession || tokenSession !== typed.revoked_session_id) {
      return fail('forbidden', 'Logout not acknowledged', 403);
    }

    const now = new Date().toISOString();
    const { error: updateError } = await ident.service
      .from('callvault_devices')
      .update({ logout_ack_at: now })
      .eq('account_id', ident.accountId)
      .eq('user_id', ident.userId)
      .eq('device_id', deviceId);
    if (updateError) throw unavailable('Device registry temporarily unavailable');

    return NextResponse.json({ acked: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
