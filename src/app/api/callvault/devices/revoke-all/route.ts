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
// No push channel (see revoke/route.ts): the HTTP gate, the
// sidecar handshake gate, and status polling enforce it.
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

    return NextResponse.json({ user_id: targetUserId, revoked });
  } catch (err) {
    return toErrorResponse(err);
  }
}
