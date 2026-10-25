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
  db: SupabaseClient;
}> {
  const presented = bearerToken(request);
  if (presented && !looksLikeApiKey(presented)) {
    const dev = await requireDeviceUser(request);
    return { accountId: dev.accountId, db: dev.service };
  }
  const ctx = await requireApiKey(request, 'recordings:write');
  return { accountId: ctx.accountId, db: ctx.supabase };
}

export async function GET(request: Request) {
  try {
    const { accountId, db } = await resolveAccount(request);

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
    const { data, error } = await db
      .from('dial_requests')
      .select('id, phone_number, contact_id, flow_id, run_id, status, expires_at, created_at')
      .eq('account_id', accountId)
      .in('status', ['pending', 'delivered'])
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) {
      return fail('internal', 'Failed to read dial requests.', 500);
    }
    return ok({ dial_requests: data ?? [] });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
