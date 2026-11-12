// ============================================================
// POST /api/v1/call-events — phone-call outcome telemetry.
//
// CallVault reports one JSON event per carrier call, sourced from
// the authoritative Android CallLog `Calls.TYPE` — never inferred
// from direction, duration, filenames, or recording existence. A
// missed or rejected call has NO audio: this endpoint takes no
// file, touches no Storage, and requires no recording.
//
// Auth: same dual architecture as POST /api/v1/recordings — a
// legacy API key with the `recordings:write` scope, or an
// authenticated WhatsApp Max user session. account_id / user_id
// always derive server-side from the credential; client-supplied
// identity fields do not exist on this endpoint.
//
// Body (JSON):
//   client_event_id  required string (≤128) — CallVault's UUID
//                    for this call, carried through retries.
//   call_type        required 'phone' — the only supported source
//                    (no reliable VoIP outcome source exists).
//   direction        required 'in' | 'out'.
//   outcome          required 'answered' | 'missed' | 'rejected' |
//                    'unknown'.
//   phone_number     optional string (≤64) — matching evidence
//                    only, resolved via the shared exact matcher.
//   duration_seconds optional non-negative int; legacy CallVault
//                    clients send it as a digits-only JSON string,
//                    which is normalized to a number (see
//                    parseDurationSeconds).
//   occurred_at      required ISO 8601 — the CallLog timestamp.
//
// Contact linking reuses matchContactByPhone (exact unique match
// or NULL — never fuzzy). Idempotent: UNIQUE(account_id,
// client_event_id) turns a retried POST into 200 + the existing
// row ({deduped: true}), never a duplicate.
//
// Response (201): { ...<CallEvent>, "matched": boolean }
// Response (200 on idempotent retry): { ...<CallEvent>, "matched": boolean, "deduped": true }
// (Flat envelope — same convention as POST /api/v1/recordings.)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { requireApiKey } from '@/lib/auth/api-context';
import { bearerToken, requireDeviceUser } from '@/lib/auth/device';
import { looksLikeApiKey } from '@/lib/api-keys/keys';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { matchContactByPhone } from '@/lib/recordings/contact-matching';
import { MAX_PHONE_NUMBER_LENGTH } from '@/lib/recordings/recordings';

const OUTCOMES = ['answered', 'missed', 'rejected', 'unknown'] as const;
type Outcome = (typeof OUTCOMES)[number];

const MAX_CLIENT_EVENT_ID_LENGTH = 128;

export interface CallEvent {
  id: string;
  account_id: string;
  user_id: string | null;
  client_event_id: string;
  call_type: string;
  direction: string;
  outcome: string;
  phone_number: string | null;
  contact_id: string | null;
  duration_seconds: number | null;
  occurred_at: string;
  created_at: string;
}

function toCallEvent(row: Record<string, unknown>): CallEvent {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    user_id: (row.user_id as string | null) ?? null,
    client_event_id: row.client_event_id as string,
    call_type: row.call_type as string,
    direction: row.direction as string,
    outcome: row.outcome as string,
    phone_number: (row.phone_number as string | null) ?? null,
    contact_id: (row.contact_id as string | null) ?? null,
    duration_seconds:
      typeof row.duration_seconds === 'number' ? row.duration_seconds : null,
    occurred_at: row.occurred_at as string,
    created_at: row.created_at as string,
  };
}

function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

/**
 * Strict `duration_seconds` parser. Accepts a non-negative safe
 * integer, or — for CallVault clients that serialize every field as
 * a JSON string — a digits-only numeric string normalized to a
 * number. `null`/`undefined` stay `null` (duration omitted).
 * Everything else (negatives, decimals, blanks, non-numeric
 * strings, booleans, unsafe integers) is invalid: returns
 * `undefined`. No loose coercion — `true` must never become `1`.
 */
export function parseDurationSeconds(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^\d+$/.test(text)) return undefined;
    // Length-gated before Number(): anything above MAX_SAFE_INTEGER
    // (16 digits) can never be a safe integer. Equal-length strings
    // compare lexicographically.
    const digits = text.replace(/^0+/, '') || '0';
    if (digits.length > 16) return undefined;
    if (digits.length === 16 && digits > '9007199254740991') return undefined;
    return Number(digits);
  }
  return undefined;
}

export async function POST(request: Request) {
  try {
    // Same two credentials, one pipeline as the recordings upload.
    const presented = bearerToken(request);
    let accountId: string;
    let userId: string | null;
    let db: SupabaseClient;
    if (presented && !looksLikeApiKey(presented)) {
      const dev = await requireDeviceUser(request);
      accountId = dev.accountId;
      userId = dev.userId;
      db = dev.service;
    } else {
      const ctx = await requireApiKey(request, 'recordings:write');
      accountId = ctx.accountId;
      userId = ctx.createdBy;
      db = ctx.supabase;
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return fail('bad_request', 'Body must be JSON.', 400);
    }

    const clientEventId =
      typeof body.client_event_id === 'string' ? body.client_event_id.trim() : '';
    if (!clientEventId) {
      return fail('bad_request', "'client_event_id' is required.", 400);
    }
    if (clientEventId.length > MAX_CLIENT_EVENT_ID_LENGTH) {
      return fail(
        'bad_request',
        `'client_event_id' must be at most ${MAX_CLIENT_EVENT_ID_LENGTH} characters.`,
        400
      );
    }
    if (body.call_type !== 'phone') {
      return fail(
        'bad_request',
        "'call_type' must be 'phone' — the only supported outcome source.",
        400
      );
    }
    if (body.direction !== 'in' && body.direction !== 'out') {
      return fail('bad_request', "'direction' must be 'in' or 'out'.", 400);
    }
    if (!isOutcome(body.outcome)) {
      return fail(
        'bad_request',
        "'outcome' must be 'answered', 'missed', 'rejected', or 'unknown'.",
        400
      );
    }
    const rawPhone =
      typeof body.phone_number === 'string' && body.phone_number.trim() !== ''
        ? body.phone_number.trim()
        : null;
    if (rawPhone && rawPhone.length > MAX_PHONE_NUMBER_LENGTH) {
      return fail(
        'bad_request',
        `'phone_number' must be at most ${MAX_PHONE_NUMBER_LENGTH} characters.`,
        400
      );
    }
    const duration = parseDurationSeconds(body.duration_seconds);
    if (duration === undefined) {
      return fail('bad_request', "'duration_seconds' must be a non-negative integer.", 400);
    }
    const occurredAt = typeof body.occurred_at === 'string' ? body.occurred_at : null;
    if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
      return fail('bad_request', "'occurred_at' must be an ISO 8601 timestamp.", 400);
    }

    // Contact association: same shared exact matcher as recordings.
    // Unique match links, anything else stays NULL — never fuzzy.
    let contactId: string | null = null;
    let matched = false;
    if (rawPhone) {
      const outcome = await matchContactByPhone(db, accountId, rawPhone);
      if (outcome.kind === 'unique') {
        contactId = outcome.contactId;
        matched = true;
      } else {
        console.log(`[api/v1/call-events] contact match=${outcome.kind}`);
      }
    }

    const { data: created, error: insertError } = await db
      .from('call_events')
      .insert({
        account_id: accountId,
        user_id: userId,
        client_event_id: clientEventId,
        call_type: 'phone',
        direction: body.direction,
        outcome: body.outcome,
        phone_number: rawPhone,
        contact_id: contactId,
        duration_seconds: duration,
        occurred_at: occurredAt,
      })
      .select('*')
      .single();

    if (insertError || !created) {
      // Idempotent retry: the same (account, client_event_id) was
      // already stored — return it with 200, never a duplicate.
      if ((insertError as { code?: string } | null)?.code === '23505') {
        const { data: existing, error: readError } = await db
          .from('call_events')
          .select('*')
          .eq('account_id', accountId)
          .eq('client_event_id', clientEventId)
          .maybeSingle();
        if (!readError && existing) {
          const existingRow = existing as unknown as Record<string, unknown>;
          return ok(
            {
              ...toCallEvent(existingRow),
              matched: !!existingRow.contact_id,
              deduped: true,
            },
            200
          );
        }
      }
      console.error('[api/v1/call-events] insert failed:', insertError?.message);
      return fail('internal', 'Failed to save the call event.', 500);
    }

    return ok({ ...toCallEvent(created as Record<string, unknown>), matched }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
