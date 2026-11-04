// ============================================================
// GET /api/auth/callvault-devices/status?device_id= — the phone
// polls its own revocation state.
//
// Device auth; the row must match the token identity
// (account + user + device) or it 404s — no existence leak, no
// cross-device oracle. Response: { revoked: boolean }.
// ============================================================

import { NextResponse } from 'next/server';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  requireDeviceIdentity,
  requireDeviceUser,
  sanitizeDeviceId,
} from '@/lib/auth/device';
import { sessionIdFromJwt } from '@/lib/auth/callvault-session';
import {
  badRequest,
  fail,
  toApiErrorResponse,
  unavailable,
} from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    // A revoked session is denied by the revocation gate inside
    // requireDeviceUser with 401 — but this endpoint exists to
    // REPORT revocation, so on denial fall back to identity-only
    // verification and answer from the registry instead.
    let accountId: string;
    let userId: string;
    let tokenSession: string | null;
    let service: SupabaseClient;
    try {
      const dev = await requireDeviceUser(request);
      accountId = dev.accountId;
      userId = dev.userId;
      tokenSession = dev.sessionId;
      service = dev.service;
    } catch (gateErr) {
      const ident = await requireDeviceIdentity(request).catch(() => null);
      if (!ident) throw gateErr;
      accountId = ident.accountId;
      userId = ident.userId;
      tokenSession = sessionIdFromJwt(ident.token);
      service = ident.service;
    }

    const url = new URL(request.url);
    const deviceId = sanitizeDeviceId(url.searchParams.get('device_id'));
    if (!deviceId) {
      throw badRequest("'device_id' is required");
    }

    const { data: row, error } = await service
      .from('callvault_devices')
      .select('session_id, revoked_session_id')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle();
    // Registry outage is explicit 503 (never generic 500): the
    // phone must distinguish "try again" from "not revoked".
    if (error) throw unavailable('Device registry temporarily unavailable');
    if (!row) {
      return fail('not_found', 'Device not found', 404);
    }
    const typed = row as {
      session_id?: unknown;
      revoked_session_id?: unknown;
    };
    // Revoked iff THIS token's session is the revoked one —
    // session-scoped, exactly like the HTTP gate.
    const revoked =
      typeof tokenSession === 'string' &&
      tokenSession !== '' &&
      typeof typed.revoked_session_id === 'string' &&
      typed.revoked_session_id !== '' &&
      typed.revoked_session_id === tokenSession;
    if (revoked) {
      console.warn('[device-status] revoked=true', { device: deviceId });
    }
    return NextResponse.json({ revoked });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
