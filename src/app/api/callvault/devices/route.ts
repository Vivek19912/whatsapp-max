// ============================================================
// GET /api/callvault/devices?user_id= — owner lists one member's
// CallVault devices.
//
// OWNER only: agents/admins/viewers get 403. The target must be
// a member of the caller's account, else 404 (no cross-tenant
// existence leak). Rows map to { device_id, device_name,
// device_model, app_version, status, logout_ack_at, last_seen_at,
// created_at, session_expires_at } where session_expires_at is
// created_at + 60 days (computed, display-only), plus presence
// ('connected' | 'disconnected' | 'remote_logout' |
// 'session_expired', computed server-side with server now via
// src/lib/callvault/presence.ts — revoked/expired NEVER read
// as an ordinary disconnect) and disconnected_since (the open
// callvault_device_events row's disconnected_at, if any).
//
// `history` carries the agent's last 5 RESOLVED disconnect
// episodes (reconnected, newest first) for the dialog's
// "recent disconnects" section.
//
// Status is computed: 'logged_out' when the phone acknowledged
// the logout (logout_ack_at set), 'pending' when revoked but not
// yet acknowledged (revoked_at set, no ack), else 'active'.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { classifyPresence, isRevokedDevice } from '@/lib/callvault/presence';

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

    // Open disconnect episodes (reconnected_at IS NULL), keyed
    // by device for disconnected_since. A missing events table
    // (pre-migration 153 rollout) degrades to "no open events"
    // rather than failing the whole list — presence still
    // computes from the 120s rule on last_seen_at.
    const nowMs = Date.now();
    const openSince = new Map<string, string>();
    try {
      const { data: openRows, error: openError } = await admin
        .from('callvault_device_events')
        .select('device_id, disconnected_at')
        .eq('account_id', ctx.accountId)
        .eq('user_id', targetUserId)
        .is('reconnected_at', null);
      if (openError) throw openError;
      for (const event of (openRows ?? []) as Array<{
        device_id: unknown;
        disconnected_at: unknown;
      }>) {
        if (
          typeof event.device_id === 'string' &&
          typeof event.disconnected_at === 'string'
        ) {
          openSince.set(event.device_id, event.disconnected_at);
        }
      }
    } catch {
      // Degraded: disconnected_since stays null; presence below
      // still reflects staleness. Never fail the list over this.
    }

    // Last 5 resolved episodes for the dialog's history section.
    // Same degradation: history gaps never fail the list.
    let history: Array<{
      id: unknown;
      device_id: unknown;
      disconnected_at: unknown;
      reconnected_at: unknown;
      reason: unknown;
    }> = [];
    try {
      const { data: historyRows, error: historyError } = await admin
        .from('callvault_device_events')
        .select('id, device_id, disconnected_at, reconnected_at, reason')
        .eq('account_id', ctx.accountId)
        .eq('user_id', targetUserId)
        .not('reconnected_at', 'is', null)
        .order('disconnected_at', { ascending: false })
        .limit(5);
      if (historyError) throw historyError;
      history = (historyRows ?? []) as typeof history;
    } catch {
      history = [];
    }

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
        // Server-side presence (server now): revoked/expired
        // never surface as an ordinary disconnect.
        presence: classifyPresence({
          lastSeenAt: row.last_seen_at,
          revoked,
          sessionCreatedAt: row.created_at,
          now: nowMs,
        }),
        disconnected_since: openSince.get(row.device_id) ?? null,
        logout_ack_at: row.logout_ack_at,
        last_seen_at: row.last_seen_at,
        created_at: row.created_at,
        session_expires_at: sessionExpiresAt(row.created_at),
      };
    });

    return NextResponse.json({ devices, history });
  } catch (err) {
    return toErrorResponse(err);
  }
}
