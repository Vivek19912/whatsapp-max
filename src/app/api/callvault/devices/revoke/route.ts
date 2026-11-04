// ============================================================
// POST /api/callvault/devices/revoke { user_id, device_id } —
// owner logs out one CallVault device session remotely.
//
// OWNER only (agents/admins/viewers → 403). The target must be a
// member of the caller's account and the row must belong to that
// member (account + user + device), else 404 — never a
// cross-account signal.
//
// The revocation is session-scoped, NOT user-scoped: the row's
// CURRENT session_id is copied into revoked_session_id, so only
// bearers carrying that session are denied by the HTTP gate and
// the sidecar handshake. GoTrue sessions are untouched (no
// signOut of any scope — the 60-day non-regression rule).
//
// Push: notify-ws.ts exposes only dial-event / status-event
// channels — there is no logout push channel, so none is added
// here. Enforcement is the HTTP gate + sidecar handshake gate +
// the phone's status polling. On failure the revocation still
// succeeds (best-effort push discipline, same as dial nudges).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (ctx.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only the account owner can log out CallVault devices' },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => null)) as {
      user_id?: unknown;
      device_id?: unknown;
    } | null;
    const targetUserId =
      typeof body?.user_id === 'string' ? body.user_id : '';
    const deviceId =
      typeof body?.device_id === 'string' ? body.device_id : '';
    if (!targetUserId || !deviceId) {
      return NextResponse.json(
        { error: "'user_id' and 'device_id' are required" },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();
    const { data: member, error: memberError } = await admin
      .from('profiles')
      .select('user_id')
      .eq('user_id', targetUserId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // The row must belong to the target member (account + user +
    // device) — an owner cannot log out a device that is not
    // this member's.
    const { data: row, error: rowError } = await admin
      .from('callvault_devices')
      .select('device_id, session_id')
      .eq('account_id', ctx.accountId)
      .eq('user_id', targetUserId)
      .eq('device_id', deviceId)
      .maybeSingle();
    if (rowError) throw rowError;
    if (!row) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404 });
    }
    const typed = row as { session_id?: unknown };

    const now = new Date().toISOString();
    const revokedSession =
      typeof typed.session_id === 'string' ? typed.session_id : null;
    const { error: updateError } = await admin
      .from('callvault_devices')
      .update({
        revoked_session_id: revokedSession,
        revoked_at: now,
        revoked_by: ctx.userId,
      })
      .eq('account_id', ctx.accountId)
      .eq('user_id', targetUserId)
      .eq('device_id', deviceId);
    if (updateError) throw updateError;

    const { error: auditError } = await admin.from('callvault_device_audit').insert({
      account_id: ctx.accountId,
      owner_user_id: ctx.userId,
      target_user_id: targetUserId,
      device_id: deviceId,
      revoked_session_id: revokedSession,
      action: 'revoke_device',
    });
    if (auditError) throw auditError;

    return NextResponse.json({ device_id: deviceId, status: 'logged_out' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
