// ============================================================
// POST /api/dial-requests — create a click-to-dial handoff.
//
// Session auth (browser Workspace). The account + user derive from
// the session — never from client-supplied account ids. The phone
// number is validated server-side; contact/flow ownership is
// verified so a request cannot be forged for another account's
// lead. Duplicate clicks reuse `idempotency_key` (unique per
// account) instead of creating duplicate notifications.
// Rate limited per user. Never touches recordings / call_events.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  isDialablePhoneNumber,
  normalizeDialNumber,
} from '@/lib/dial/validation';
import { notifyDialRequest } from '@/lib/dial/notify-ws';

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const DIAL_TTL_MS = 10 * 60 * 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`dial:${ctx.userId}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!limit.success) return rateLimitResponse(limit);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
    }

    const rawPhone =
      typeof body.phone_number === 'string' ? body.phone_number.trim() : '';
    if (!rawPhone || !isDialablePhoneNumber(rawPhone)) {
      return NextResponse.json(
        { error: 'A valid phone_number is required.' },
        { status: 400 }
      );
    }
    const phoneNumber = normalizeDialNumber(rawPhone);

    const contactId =
      typeof body.contact_id === 'string' && body.contact_id.trim()
        ? body.contact_id.trim()
        : null;
    const flowId =
      typeof body.flow_id === 'string' && body.flow_id.trim()
        ? body.flow_id.trim()
        : null;
    const runId =
      typeof body.run_id === 'string' && body.run_id.trim()
        ? body.run_id.trim().slice(0, 128)
        : null;
    let idempotencyKey =
      typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
        ? body.idempotency_key.trim().slice(0, MAX_IDEMPOTENCY_KEY_LENGTH)
        : null;
    if (!idempotencyKey) {
      idempotencyKey = `${ctx.userId}:${phoneNumber}:${Date.now()}`;
    }

    if (contactId && !UUID_RE.test(contactId)) {
      return NextResponse.json({ error: 'Invalid contact_id.' }, { status: 400 });
    }
    if (flowId && !UUID_RE.test(flowId)) {
      return NextResponse.json({ error: 'Invalid flow_id.' }, { status: 400 });
    }

    // Ownership: the contact / flow must belong to the caller's
    // account, otherwise 404 (never 403 — avoids oracle probes).
    if (contactId) {
      const { data, error } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('id', contactId)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error || !data) {
        return NextResponse.json({ error: 'Contact not found.' }, { status: 404 });
      }
    }
    if (flowId) {
      const { data, error } = await ctx.supabase
        .from('flows')
        .select('id')
        .eq('id', flowId)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error || !data) {
        return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
      }
    }

    void RATE_LIMITS;

    const expiresAt = new Date(Date.now() + DIAL_TTL_MS).toISOString();
    const { data: created, error: insertError } = await ctx.supabase
      .from('dial_requests')
      .insert({
        account_id: ctx.accountId,
        requested_by: ctx.userId,
        phone_number: phoneNumber,
        contact_id: contactId,
        flow_id: flowId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select('id, phone_number, status, expires_at, created_at')
      .single();

    if (insertError || !created) {
      // Duplicate click with the same key → return the existing row
      // (200) instead of a second notification.
      if ((insertError as { code?: string } | null)?.code === '23505') {
        const { data: existing } = await ctx.supabase
          .from('dial_requests')
          .select('id, phone_number, status, expires_at, created_at')
          .eq('account_id', ctx.accountId)
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (existing) return NextResponse.json({ dial_request: existing, deduped: true });
      }
      return NextResponse.json({ error: 'Failed to create dial request.' }, { status: 500 });
    }

    // Wake the requesting user's connected device over the local
    // WebSocket sidecar. Fire-and-forget: the durable row is the
    // source of truth, and a sidecar outage must not fail the click.
    // The event carries ids only — never the phone number.
    void notifyDialRequest({
      id: created.id,
      account_id: ctx.accountId,
      requested_by: ctx.userId,
      status: created.status,
      expires_at: created.expires_at,
      created_at: created.created_at,
    });

    return NextResponse.json(
      {
        dial_request: created,
        tel_uri: `tel:${phoneNumber}`,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** GET /api/dial-requests?id= — read one request's status once (owner account only). Not polled. */
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const id = (url.searchParams.get('id') ?? '').trim();
    if (!id || !UUID_RE.test(id)) {
      return NextResponse.json({ error: 'A valid id is required.' }, { status: 400 });
    }
    const { data, error } = await ctx.supabase
      .from('dial_requests')
      .select('id, phone_number, status, expires_at, created_at, delivered_at, opened_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: 'Failed to read dial request.' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

    // Lazy expiry for an explicit status read: without this a row
    // past its TTL keeps reporting `pending`. Device reads do the same.
    const row = data as {
      id: string;
      status?: string;
      expires_at?: string;
    };
    const expiresMs = Date.parse(String(row.expires_at ?? ''));
    if (
      (row.status === 'pending' || row.status === 'delivered') &&
      Number.isFinite(expiresMs) &&
      expiresMs <= Date.now()
    ) {
      await ctx.supabase
        .from('dial_requests')
        .update({ status: 'expired' })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      row.status = 'expired';
    }
    return NextResponse.json({ dial_request: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
