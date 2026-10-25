// ============================================================
// PATCH|POST /api/v1/dial-requests/{id} — device acknowledges a
// handoff. POST is an alias of PATCH: some Android/JDK
// HttpURLConnection stacks reject the PATCH method itself
// ("Invalid HTTP method"), which would make every acknowledgement
// fail before it reaches the server. Both verbs run the identical
// handler below.
//
// Device auth only (user token or API key, same as GET). Enforces:
// - account + device ownership (row must belong to the account),
// - expiry (past-TTL rows become `expired`, 410),
// - one-time consumption (first `opened` wins; replays 409),
// - minimal state machine:
//     pending → delivered → opened → completed
//     pending/delivered → cancelled | failed | expired
// Only the owning account's rows are visible (404 otherwise).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { bearerToken, requireDeviceUser } from '@/lib/auth/device';
import { requireApiKey } from '@/lib/auth/api-context';
import { looksLikeApiKey } from '@/lib/api-keys/keys';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

const TRANSITIONS: Record<string, string[]> = {
  pending: ['delivered', 'opened', 'cancelled', 'failed'],
  delivered: ['opened', 'cancelled', 'failed'],
  opened: ['completed', 'failed'],
};

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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleAck(request, (await params).id, 'PATCH');
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleAck(request, (await params).id, 'POST');
}

async function handleAck(request: Request, id: string, method: string) {
  try {
    const { accountId, db } = await resolveAccount(request);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return fail('bad_request', 'Body must be JSON.', 400);
    }
    const next = typeof body.status === 'string' ? body.status.trim() : '';
    if (!next) return fail('bad_request', "'status' is required.", 400);

    const { data: row, error: readError } = await db
      .from('dial_requests')
      .select('id, account_id, status, expires_at, consumed_at')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (readError) {
      console.error('[api/v1/dial-requests] ack read failed:', readError.message);
      return fail('internal', 'Failed to read dial request.', 500);
    }
    if (!row) {
      console.warn(
        `[api/v1/dial-requests] ack ${String(id).slice(0, 8)} not found (account=${accountId.slice(0, 8)})`
      );
      return fail('not_found', 'Dial request not found.', 404);
    }

    const current = String((row as Record<string, unknown>).status ?? '');
    if (new Date(String((row as Record<string, unknown>).expires_at)).getTime() < Date.now()) {
      await db.from('dial_requests').update({ status: 'expired' }).eq('id', id).eq('account_id', accountId);
      return fail('gone', 'Dial request has expired.', 410);
    }
    if ((row as Record<string, unknown>).consumed_at && next === 'opened') {
      return fail('conflict', 'Dial request was already consumed.', 409);
    }
    if (!TRANSITIONS[current]?.includes(next)) {
      return fail('bad_request', `Cannot move dial request from '${current}' to '${next}'.`, 400);
    }

    const patch: Record<string, unknown> = { status: next };
    const now = new Date().toISOString();
    if (next === 'delivered') patch['delivered_at'] = now;
    if (next === 'opened') {
      patch['opened_at'] = now;
      patch['consumed_at'] = now;
    }

    const { data: updated, error: updateError } = await db
      .from('dial_requests')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, phone_number, status, expires_at, created_at')
      .maybeSingle();
    if (updateError || !updated) {
      console.error(
        `[api/v1/dial-requests] ack ${String(id).slice(0, 8)} ${current}->${next} failed:`,
        updateError?.message ?? 'no row returned'
      );
      return fail('internal', 'Failed to update dial request.', 500);
    }
    // Sanitized: transition + id prefix only, never the number.
    console.log(`[api/v1/dial-requests] ack ${String(id).slice(0, 8)} ${current}->${next} via ${method}`);
    return ok({ dial_request: updated });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
