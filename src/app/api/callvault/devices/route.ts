// ============================================================
// GET /api/callvault/devices?user_id= — owner lists one member's
// CallVault devices.
//
// OWNER only: agents/admins/viewers get 403. The target must be
// a member of the caller's account, else 404 (no cross-tenant
// existence leak). Rows map to { device_id, device_name,
// device_model, app_version, status, logout_ack_at, last_seen_at,
// created_at, session_expires_at } where session_expires_at is
// created_at + 60 days (computed, display-only).
//
// Status is computed: 'logged_out' when the phone acknowledged
// the logout (logout_ack_at set), 'pending' when revoked but not
// yet acknowledged (revoked_at set, no ack), else 'active'.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { isRevokedDevice } from '@/lib/callvault/presence';

/** CallVault sessions live 60 days (display-only computation). */
export const CALLVAULT_SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export function sessionExpiresAt(createdAt: string): string | null {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + CALLVAULT_SESSION_TTL_MS).toISOString();
}

interface DeviceRow {
  device_id: string;
  device_name: string | null;
  device_model: string | null;
  app_version: string | null;
  session_id: string | null;
  revoked_session_id: string | null;
  revoked_at: string | null;
  logout_ack_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (ctx.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only the account owner can view CallVault devices' },
        { status: 403 },
      );
    }

    const url = new URL(request.url);
    const targetUserId = url.searchParams.get('user_id') ?? '';
    if (!targetUserId) {
      return NextResponse.json({ error: "'user_id' is required" }, { status: 400 });
    }

    const admin = supabaseAdmin();
    // Target must belong to the caller's account — same 404 as a
    // missing member, never a cross-account signal.
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

    const { data: rows, error } = await admin
      .from('callvault_devices')
      .select(
        'device_id, device_name, device_model, app_version, session_id, revoked_session_id, revoked_at, logout_ack_at, last_seen_at, created_at',
      )
      .eq('account_id', ctx.accountId)
      .eq('user_id', targetUserId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const devices = ((rows ?? []) as DeviceRow[]).map((row) => {
      // Revocation-scoped: a stale ack on a healed (active) row
      // never reads logged_out — register clears logout_ack_at
      // on session change, and this mapping requires revoked.
      const acked =
        typeof row.logout_ack_at === 'string' && row.logout_ack_at !== '';
      const revoked = isRevokedDevice({
        revokedAt: row.revoked_at,
        revokedSessionId: row.revoked_session_id,
        sessionId: row.session_id,
      });
      return {
        device_id: row.device_id,
        device_name: row.device_name,
        device_model: row.device_model,
        app_version: row.app_version,
        status: !revoked ? 'active' : acked ? 'logged_out' : 'pending',
        logout_ack_at: row.logout_ack_at,
        last_seen_at: row.last_seen_at,
        created_at: row.created_at,
        session_expires_at: sessionExpiresAt(row.created_at),
      };
    });

    return NextResponse.json({ devices });
  } catch (err) {
    return toErrorResponse(err);
  }
}
