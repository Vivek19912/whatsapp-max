// ============================================================
// POST /api/auth/callvault-devices/register — a logged-in device
// registers its (device_id, session_id) pair.
//
// Device auth (any agent-or-above session), NOT owner-only: the
// phone calls this on every fresh login. account_id/user_id are
// NEVER accepted from the client — they come from the verified
// bearer via requireDeviceUser.
//
// Body:
//   device_id (required, 1..64 chars, sanitized like the sidecar)
//   session_id (uuid, must equal the JWT's session_id or 403)
//   device_name / device_model / app_version (optional, ≤128)
//
// Upsert on (account_id, device_id). A banned session
// re-registering (incoming session == revoked_session_id) gets
// 403 device_revoked; a new session on a revoked row heals it
// (revocation fields cleared on session change).
// ============================================================

import { NextResponse } from 'next/server';

import { requireDeviceUser, sanitizeDeviceId } from '@/lib/auth/device';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  badRequest,
  fail,
  forbidden,
  toApiErrorResponse,
} from '@/lib/api/v1/respond';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_META_LEN = 128;

function cleanMeta(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_META_LEN);
}

interface DeviceRow {
  session_id?: unknown;
  revoked_session_id?: unknown;
}

export async function POST(request: Request) {
  try {
    const dev = await requireDeviceUser(request);

    const body = (await request.json().catch(() => null)) as {
      device_id?: unknown;
      session_id?: unknown;
      device_name?: unknown;
      device_model?: unknown;
      app_version?: unknown;
    } | null;

    const rawDeviceId = typeof body?.device_id === 'string' ? body.device_id : '';
    if (!rawDeviceId || rawDeviceId.length > 64) {
      throw badRequest("'device_id' is required (1..64 characters)");
    }
    const deviceId = sanitizeDeviceId(rawDeviceId);
    if (!deviceId) {
      throw badRequest("'device_id' must contain at least one letter, digit, dot, underscore, or hyphen");
    }

    const incomingSession =
      typeof body?.session_id === 'string' ? body.session_id : '';
    if (!UUID_RE.test(incomingSession)) {
      throw badRequest("'session_id' must be a UUID");
    }
    // The session being registered must be the session proving
    // this request — a device may never register a session it
    // does not hold.
    if (incomingSession !== dev.sessionId) {
      throw forbidden('Session mismatch');
    }

    const admin = supabaseAdmin();
    const { data: existing, error: readError } = await admin
      .from('callvault_devices')
      .select('session_id, revoked_session_id')
      .eq('account_id', dev.accountId)
      .eq('device_id', deviceId)
      .maybeSingle();
    if (readError) throw readError;

    const existingRow = existing as DeviceRow | null;
    // A banned session re-registering stays banned: the owner
    // logged THIS session out, so healing must not apply to it.
    if (
      existingRow &&
      typeof existingRow.revoked_session_id === 'string' &&
      existingRow.revoked_session_id === incomingSession
    ) {
      return fail('device_revoked', 'This device session has been logged out', 403);
    }

    // Fresh login heals: a new session clears the revocation
    // fields (and any prior logout ack); re-registering the same
    // session preserves them (that path 403s above when revoked).
    const sessionChanged =
      !existingRow || existingRow.session_id !== incomingSession;
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      account_id: dev.accountId,
      user_id: dev.userId,
      device_id: deviceId,
      session_id: incomingSession,
      device_name: cleanMeta(body?.device_name),
      device_model: cleanMeta(body?.device_model),
      app_version: cleanMeta(body?.app_version),
      last_seen_at: now,
    };
    if (sessionChanged) {
      patch.revoked_session_id = null;
      patch.revoked_at = null;
      patch.revoked_by = null;
      patch.logout_ack_at = null;
    }

    const { error: upsertError } = await admin
      .from('callvault_devices')
      .upsert(patch, { onConflict: 'account_id,device_id' });
    if (upsertError) throw upsertError;

    return NextResponse.json({
      device_id: deviceId,
      session_id: incomingSession,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
