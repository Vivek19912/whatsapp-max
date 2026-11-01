// ============================================================
// POST /api/v1/recordings — upload a phone call recording.
//
// Phase 1 of CallVault → WACRM: a device (CallVault) POSTs one
// recording as multipart/form-data; the API stores the bytes in
// Supabase Storage and catalogs the metadata in
// `call_recordings` (migration 105).
//
// Auth: either a legacy API key with the `recordings:write`
// scope, or an authenticated WhatsApp Max user session (Supabase
// access token) whose account grants upload permission. Either
// way the phone never sees cookies, RLS, or service secrets —
// the credential lookup fixes the account and every write is
// scoped by it. For user sessions, uploaded_by is the actual
// authenticated user; for keys it remains the key minter.
//
// Form fields:
//   audio              File, required — the recording (Opus .ogg
//                      by default, AAC .m4a alternatively).
//   recorded_at        optional ISO 8601 — when the call happened
//                      (defaults to upload time).
//   duration_seconds   optional non-negative int.
//   contact_id         optional UUID — must belong to the account.
//                      Explicit and authoritative: wins over phone
//                      matching when present.
//   conversation_id    optional UUID — must belong to the account.
//   phone_number       optional string (≤64 chars) — the call's
//                      phone number as seen by the device. Matching
//                      EVIDENCE only: normalized server-side and
//                      resolved to contact_id within the key's
//                      account (Phase 2B).
//   direction          optional 'in' | 'out' — anything else 400s.
//   call_type          optional 'phone' | 'whatsapp' |
//                      'whatsapp_business' (migration 107) —
//                      anything else 400s. Stored verbatim, never
//                      inferred; absent for old clients.
//
// Validation runs BEFORE any Storage write so a bad payload 400s
// without leaving an orphan object (same discipline as
// POST /api/v1/messages validating before resolve-or-create).
// The File is passed straight to the Storage upload as a Blob —
// never buffered into a second copy in Node memory.
//
// Response (201): { "data": <CallRecording> }
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { requireApiKey } from '@/lib/auth/api-context';
import { bearerToken, requireDeviceUser } from '@/lib/auth/device';
import { looksLikeApiKey } from '@/lib/api-keys/keys';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { buildMediaPath, resolveUploadContentType } from '@/lib/storage/upload-media';
import {
  RECORDING_BUCKET,
  toCallRecording,
  validateRecordingFile,
  validateRecordingMetadata,
} from '@/lib/recordings/recordings';
import { matchContactByPhone } from '@/lib/recordings/contact-matching';

async function accountOwns(
  supabase: SupabaseClient,
  table: 'contacts' | 'conversations',
  id: string,
  accountId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  return !error && !!data;
}

export async function POST(request: Request) {
  try {
    // Two credentials, one pipeline: a legacy `wacrm_live_` key
    // (recordings:write scope) or a logged-in user's access token.
    // Anything else falls through to the key path, which rejects
    // it as unauthorized.
    const presented = bearerToken(request);
    let accountId: string;
    let uploadedBy: string | null;
    let db: SupabaseClient;
    if (presented && !looksLikeApiKey(presented)) {
      const dev = await requireDeviceUser(request);
      accountId = dev.accountId;
      uploadedBy = dev.userId;
      db = dev.service;
    } else {
      const ctx = await requireApiKey(request, 'recordings:write');
      accountId = ctx.accountId;
      uploadedBy = ctx.createdBy;
      db = ctx.supabase;
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail('bad_request', 'Request body must be multipart/form-data', 400);
    }
    const entry = form.get('audio');
    const file = entry instanceof File ? entry : null;
    if (!file) {
      return fail('bad_request', "Attach the recording as the 'audio' file field", 400);
    }

    const fileProblem = validateRecordingFile({ size: file.size, type: file.type });
    if (fileProblem) {
      return fail('bad_request', fileProblem, 400);
    }

    const rawRecordedAt =
      typeof form.get('recorded_at') === 'string'
        ? (form.get('recorded_at') as string).trim() || null
        : null;
    const rawDuration = form.get('duration_seconds');
    const durationSeconds =
      typeof rawDuration === 'string' && rawDuration.trim() !== ''
        ? Number(rawDuration)
        : null;
    const metaProblem = validateRecordingMetadata({
      recordedAt: rawRecordedAt,
      durationSeconds,
      direction:
        typeof form.get('direction') === 'string'
          ? (form.get('direction') as string).trim() || null
          : null,
      phoneNumber:
        typeof form.get('phone_number') === 'string'
          ? (form.get('phone_number') as string).trim() || null
          : null,
      callType:
        typeof form.get('call_type') === 'string'
          ? (form.get('call_type') as string).trim() || null
          : null,
    });
    if (metaProblem) {
      return fail('bad_request', metaProblem, 400);
    }
    const rawDirection =
      typeof form.get('direction') === 'string' &&
      (form.get('direction') as string).trim() !== ''
        ? (form.get('direction') as string).trim()
        : null;
    const rawPhoneNumber =
      typeof form.get('phone_number') === 'string' &&
      (form.get('phone_number') as string).trim() !== ''
        ? (form.get('phone_number') as string).trim()
        : null;
    // Call source as sent by the device (migration 107 vocabulary,
    // enforced above). Stored verbatim — never inferred, and absent
    // for old clients and unclassified calls alike.
    const rawCallType =
      typeof form.get('call_type') === 'string' &&
      (form.get('call_type') as string).trim() !== ''
        ? (form.get('call_type') as string).trim()
        : null;

    const rawContactId =
      typeof form.get('contact_id') === 'string' &&
      (form.get('contact_id') as string).trim() !== ''
        ? (form.get('contact_id') as string).trim()
        : null;
    const rawConversationId =
      typeof form.get('conversation_id') === 'string' &&
      (form.get('conversation_id') as string).trim() !== ''
        ? (form.get('conversation_id') as string).trim()
        : null;
    // Optional links must belong to the credential's account — a
    // device must not be able to attach a recording to another
    // account's contact by guessing UUIDs.
    if (
      rawContactId &&
      !(await accountOwns(db, 'contacts', rawContactId, accountId))
    ) {
      return fail('bad_request', "'contact_id' does not belong to this account", 400);
    }
    if (
      rawConversationId &&
      !(await accountOwns(db, 'conversations', rawConversationId, accountId))
    ) {
      return fail(
        'bad_request',
        "'conversation_id' does not belong to this account",
        400
      );
    }

    // Contact association, in precedence order: explicit
    // contact_id wins; else server-side phone matching within the
    // credential's account; else unlinked. Matching NEVER fails the
    // upload — ambiguity or lookup trouble degrades to NULL.
    let resolvedContactId = rawContactId;
    let matched = rawContactId !== null;
    if (!resolvedContactId && rawPhoneNumber) {
      const outcome = await matchContactByPhone(
        db,
        accountId,
        rawPhoneNumber
      );
      if (outcome.kind === 'unique') {
        resolvedContactId = outcome.contactId;
        matched = true;
      } else {
        // Safe diagnostics only — never phone numbers or candidates.
        console.log(`[api/v1/recordings] contact match=${outcome.kind}`);
      }
    }

    // Account-scoped path — the same convention (and the same RLS
    // segment) every other media upload uses. `buildMediaPath`
    // sanitizes the CallVault filename (`20260501_120000_+1555….ogg`).
    const storagePath = buildMediaPath(
      accountId,
      file.name || 'recording.ogg'
    );
    // Never store an empty content type (previously became
    // `application/octet-stream`); non-empty types pass through
    // unchanged, so valid audio uploads behave exactly as before.
    const contentType = resolveUploadContentType(file.name, file.type);
    const { error: uploadError } = await db.storage
      .from(RECORDING_BUCKET)
      .upload(
        storagePath,
        file,
        contentType
          ? { cacheControl: '3600', upsert: false, contentType }
          : { cacheControl: '3600', upsert: false },
      );
    if (uploadError) {
      console.error('[api/v1/recordings] storage upload failed:', uploadError.message);
      return fail('internal', 'Failed to store the recording', 500);
    }

    const { data: created, error: insertError } = await db
      .from('call_recordings')
      .insert({
        account_id: accountId,
        contact_id: resolvedContactId,
        conversation_id: rawConversationId,
        // Audit attribution: the actual authenticated user for
        // session uploads, or whoever minted the key (nullable —
        // mirrors the `api_keys.created_by` contract). Never used
        // for authorization; that is account_id + scopes/role.
        uploaded_by: uploadedBy,
        storage_bucket: RECORDING_BUCKET,
        storage_path: storagePath,
        file_name: file.name || null,
        mime_type: file.type,
        file_size: file.size,
        duration_seconds: durationSeconds,
        recorded_at: rawRecordedAt,
        // Raw trimmed device evidence (migration 106). Stored as
        // received — normalization happens only for matching, never
        // by overwriting this column.
        phone_number: rawPhoneNumber,
        direction: rawDirection,
        call_type: rawCallType,
      })
      .select('*')
      .single();
    if (insertError || !created) {
      // The bytes landed but the catalog write failed — remove the
      // orphan so Storage can't accumulate unreachable objects
      // (same GC instinct as `deleteAccountMedia` on failed sends).
      console.error('[api/v1/recordings] catalog insert failed:', insertError?.message);
      await db.storage.from(RECORDING_BUCKET).remove([storagePath]);
      return fail('internal', 'Failed to save the recording', 500);
    }

    return ok(
      { ...toCallRecording(created as Record<string, unknown>), matched },
      201
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
