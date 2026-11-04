// ============================================================
// POST /api/callvault/devices/revoke-all { user_id } — owner logs
// out EVERY CallVault device session of one member.
//
// OWNER only (agents/admins/viewers → 403). Target must be a
// member of the caller's account, else 404. Each row's current
// session_id becomes its revoked_session_id (session-scoped, no
// GoTrue signOut of any scope). Exactly one audit row with
// device_id = null and action 'revoke_all'.
//
// Persisted-first push (see revoke/route.ts): every row + the
// audit are committed before any live push; offline phones
// enforce on reconnect + status polling. Notify failures never
// fail the revocation (log only).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { notifyDeviceLogout } from '@/lib/dial/notify-ws';

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
    } | null;
    const targetUserId =
      typeof body?.user_id === 'string' ? body.user_id : '';
    if (!targetUserId) {
      return NextResponse.json({ error: "'user_id' is required" }, { status: 400 });
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

    const { data: rows, error: rowsError } = await admin
      .from('callvault_devices')
      .select('device_id, session_id')
      .eq('account_id', ctx.accountId)
      .eq('user_id', targetUserId);
    if (rowsError) throw rowsError;

    const now = new Date().toISOString();
    let revoked = 0;
    const pushed: Array<{ device_id: string; session_id: string | null }> = [];
    for (const row of ((rows ?? []) as Array<{
      device_id?: unknown;
      session_id?: unknown;
    }>)) {
      if (typeof row.device_id !== 'string') continue;
      const revokedSession =
        typeof row.session_id === 'string' ? row.session_id : null;
      const { error: updateError } = await admin
        .from('callvault_devices')
        .update({
          revoked_session_id: revokedSession,
          revoked_at: now,
          revoked_by: ctx.userId,
        })
        .eq('account_id', ctx.accountId)
        .eq('user_id', targetUserId)
        .eq('device_id', row.device_id);
      if (updateError) throw updateError;
      revoked += 1;
      pushed.push({ device_id: row.device_id, session_id: revokedSession });
    }

    const { error: auditError } = await admin.from('callvault_device_audit').insert({
      account_id: ctx.accountId,
      owner_user_id: ctx.userId,
      target_user_id: targetUserId,
      device_id: null,
      revoked_session_id: null,
      action: 'revoke_all',
    });
    if (auditError) throw auditError;

    // Best-effort live push per revoked device, after the commit.
    // Never throws; the revocation result stands regardless.
    for (const target of pushed) {
      await notifyDeviceLogout({
        account_id: ctx.accountId,
        user_id: targetUserId,
        device_id: target.device_id,
        session_id: target.session_id,
      });
    }

    return NextResponse.json({ user_id: targetUserId, revoked });
  } catch (err) {
    return toErrorResponse(err);
  }
}
