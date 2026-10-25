// ============================================================
// GET /api/v1/dial-requests — CallVault polls pending handoffs.
//
// Device auth (Supabase user token, same as recordings /
// call-events). Returns only non-expired pending/delivered rows
// for the credential's own account. Expired rows are lazily
// marked `expired` on read. No tokens or secrets are returned.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { bearerToken, requireDeviceUser } from '@/lib/auth/device';
import { requireApiKey } from '@/lib/auth/api-context';
import { looksLikeApiKey } from '@/lib/api-keys/keys';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

async function resolveAccount(request: Request): Promise<{
  accountId: string;
  /** Set for user-token auth: poll only this user's own requests. */
  userId: string | null;
  db: SupabaseClient;
}> {
  const presented = bearerToken(request);
  if (presented && !looksLikeApiKey(presented)) {
    const dev = await requireDeviceUser(request);
    return { accountId: dev.accountId, userId: dev.userId, db: dev.service };
  }
  const ctx = await requireApiKey(request, 'recordings:write');
  return { accountId: ctx.accountId, userId: null, db: ctx.supabase };
}

export async function GET(request: Request) {
  try {
    const { accountId, userId, db } = await resolveAccount(request);

    // Lazy expiry: anything past its TTL leaves pending/delivered.
    await db
      .from('dial_requests')
      .update({ status: 'expired' })
      .eq('account_id', accountId)
      .in('status', ['pending', 'delivered'])
      .lt('expires_at', new Date().toISOString());

    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit') ?? 10) || 10, 1),
      25
    );
    // Recipient targeting: a device authenticated as a user only
    // ever sees requests that user created (requested_by is set to
    // the clicking user at creation). Assigned To is irrelevant and
    // no device can pull another user's requests — first explicit
    // tap consumes the row server-side. Machine keys keep the
    // legacy account-wide view.
    let query = db
      .from('dial_requests')
      .select('id, phone_number, contact_id, flow_id, run_id, status, expires_at, created_at')
      .eq('account_id', accountId);
    if (userId) query = query.eq('requested_by', userId);
    const { data, error } = await query
      .in('status', ['pending', 'delivered'])
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) {
      // Sanitized: error message only, never row contents (phone
      // numbers must not reach logs).
      console.error('[api/v1/dial-requests] read failed:', error.message);
      return fail('internal', 'Failed to read dial requests.', 500);
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      console.log(
        `[api/v1/dial-requests] polled account=${accountId.slice(0, 8)} pending=${rows.length}`
      );
    }
    return ok({ dial_requests: rows });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
