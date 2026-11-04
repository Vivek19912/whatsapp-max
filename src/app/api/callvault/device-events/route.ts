// ============================================================
// GET /api/callvault/device-events?user_id= — owner lists one
// member's recent disconnect/reconnect episodes.
//
// OWNER only (same gate as GET /api/callvault/devices):
// agents/admins/viewers get 403, cross-account targets 404.
// Returns the newest 50 events for the member (cap is
// server-side) with the agent's display name resolved
// server-side from profiles.full_name — the events table
// stores ids only, never names.
//
// The monitor never revokes and never touches tokens; this
// endpoint is read-only history.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

const HISTORY_LIMIT = 50;

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (ctx.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only the account owner can view CallVault device events' },
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
    // missing member, never a cross-account signal. The full
    // name resolves here, server-side, for the response.
    const { data: member, error: memberError } = await admin
      .from('profiles')
      .select('user_id, full_name')
      .eq('user_id', targetUserId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const { data: rows, error } = await admin
      .from('callvault_device_events')
      .select('id, device_id, last_seen_at, disconnected_at, reconnected_at, reason')
      .eq('account_id', ctx.accountId)
      .eq('user_id', targetUserId)
      .order('disconnected_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw error;

    const agentName =
      typeof (member as { full_name?: unknown }).full_name === 'string' &&
      ((member as { full_name: string }).full_name.trim() !== '')
        ? (member as { full_name: string }).full_name.trim()
        : null;
    const events = ((rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      agent_name: agentName,
    }));

    return NextResponse.json({ events });
  } catch (err) {
    return toErrorResponse(err);
  }
}
