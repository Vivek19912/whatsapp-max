// ============================================================
// Phase 1 call recordings — shared server-side model.
//
// One row of `call_recordings` (migration 105) = one uploaded
// audio file. Bytes live in the dedicated PRIVATE
// `call-recordings` Storage bucket (created in migration 105) —
// never in the public `chat-media` bucket. This module is the
// validation + serialization contract both the upload endpoint
// (`POST /api/v1/recordings`) and the dashboard list
// (`GET /api/recordings`) speak.
//
// The MIME allowlist below MUST stay a subset of the bucket's
// `allowed_mime_types` — anything else is rejected by Storage
// at upload time and would land as a confusing 500 instead of
// a clean 400 here.
// ============================================================

/** Storage bucket recordings live in. PRIVATE — no public reads. */
export const RECORDING_BUCKET = 'call-recordings';

/**
 * 100 MB — mirrors the `call-recordings` `file_size_limit` in
 * migration 105. One limit to reason about (same philosophy as
 * migration 023): the bucket is the hard ceiling, this check
 * just turns its rejection into a clean 400 before any bytes
 * move. (CallVault's default Opus-at-24kbps encodes ~180 KB/min,
 * so this is ~9 hours; AAC/128kbps is ~87 min.)
 */
export const RECORDING_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Audio MIME types the upload endpoint accepts. Exactly the
 * `call-recordings` bucket allowlist (migration 105):
 * CallVault ships Opus-in-`.ogg` by default and AAC-in-`.m4a`
 * as the alternative — the rest covers real-world encoder
 * variance without opening the door to non-audio uploads.
 */
export const RECORDING_ALLOWED_MIME_TYPES = [
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'audio/3gpp',
  'audio/webm',
  'audio/x-m4a',
  'audio/m4a',
] as const;

export type RecordingMimeType = (typeof RECORDING_ALLOWED_MIME_TYPES)[number];

/** A `call_recordings` row as the API serves it. */
export interface CallRecording {
  id: string;
  account_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  uploaded_by: string | null;
  /**
   * Resolved display name of the uploader (`profiles.full_name`,
   * else `profiles.email`, else `'Unknown'`). Joined server-side
   * in one batch — never N+1. Absent on older responses.
   */
  uploader_name?: string | null;
  /**
   * Linked lead's display name (`contacts.name`). Joined server-side
   * in one batch — never N+1. Null when unlinked or the contact has
   * no name; the UI then shows "Unlinked". Absent on older responses.
   */
  contact_name?: string | null;
  /**
   * Linked lead's phone (`contacts.phone`), same batched lookup as
   * the name. Shown in the detail drawer when the recording itself
   * carries no number.
   */
  contact_phone?: string | null;
  storage_bucket: string;
  storage_path: string;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  duration_seconds: number | null;
  recorded_at: string | null;
  created_at: string;
  /**
   * Phase 2B matching evidence (migration 106). Present on rows
   * written after the migration; older rows carry nulls. Additive
   * — readers treat absence as null.
   */
  direction?: string | null;
  phone_number?: string | null;
  /**
   * Call source (migration 107): 'phone' | 'whatsapp' |
   * 'whatsapp_business', or null when unclassified. Stored as
   * sent — validated against the same vocabulary as the DB
   * CHECK, never inferred.
   */
  call_type?: string | null;
}

export function toCallRecording(
  row: Record<string, unknown>,
  uploaderName?: string | null,
  contactName?: string | null,
  contactPhone?: string | null,
): CallRecording {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    uploaded_by: (row.uploaded_by as string | null) ?? null,
    uploader_name: uploaderName ?? null,
    contact_name: contactName ?? null,
    contact_phone: contactPhone ?? null,
    storage_bucket: row.storage_bucket as string,
    storage_path: row.storage_path as string,
    file_name: (row.file_name as string | null) ?? null,
    mime_type: (row.mime_type as string | null) ?? null,
    file_size: (row.file_size as number | null) ?? null,
    duration_seconds: (row.duration_seconds as number | null) ?? null,
    recorded_at: (row.recorded_at as string | null) ?? null,
    created_at: row.created_at as string,
    direction: (row.direction as string | null) ?? null,
    phone_number: (row.phone_number as string | null) ?? null,
    call_type: (row.call_type as string | null) ?? null,
  };
}

/**
 * Display name for an uploader profile: `full_name`, else
 * `email`, else `'Unknown'`. Pure so list routes, the Workspace
 * enrichment, and tests share one rule.
 */
export function resolveUploaderName(profile: {
  full_name?: unknown;
  email?: unknown;
} | null): string {
  const fullName =
    typeof profile?.full_name === 'string' ? profile.full_name.trim() : '';
  if (fullName) return fullName;
  const email =
    typeof profile?.email === 'string' ? profile.email.trim() : '';
  if (email) return email;
  return 'Unknown';
}

/**
 * Effective sort timestamp for a recording: `recorded_at` when
 * present (the call's time), else `created_at` (the upload's
 * time). `recorded_at` is nullable by design, so ordering must
 * never rely on it alone.
 */
export function recordingSortTime(row: {
  recorded_at?: string | null;
  created_at?: string | null;
}): number {
  const recorded = typeof row.recorded_at === 'string' ? Date.parse(row.recorded_at) : NaN;
  if (Number.isFinite(recorded)) return recorded;
  const created = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(created) ? created : 0;
}

/**
 * Latest recording per contact from an already account-scoped
 * row set. Deterministic: effective time DESC, then `created_at`
 * DESC, then `id` DESC. Pure — the table route batches one
 * query for the page's contacts and reduces client-side instead
 * of N+1 requests (PostgREST has no per-group limit, and no new
 * RPC/migration is wanted for Phase 2A).
 */
export function latestByContact<
  T extends { id: string; recorded_at?: string | null; created_at?: string | null },
>(rows: T[], contactIdOf: (row: T) => string | null): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const contactId = contactIdOf(row);
    if (!contactId) continue;
    const prev = out.get(contactId);
    if (!prev) {
      out.set(contactId, row);
      continue;
    }
    const time = recordingSortTime(row);
    const prevTime = recordingSortTime(prev);
    if (
      time > prevTime ||
      (time === prevTime &&
        ((row.created_at ?? '') > (prev.created_at ?? '') ||
          ((row.created_at ?? '') === (prev.created_at ?? '') && row.id > prev.id)))
    ) {
      out.set(contactId, row);
    }
  }
  return out;
}

/** Compact `m:ss` duration for table cells. Null/unknown → em dash. */
export function formatRecordingDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return '—';
  }
  const total = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const IN_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Day-first Indian recorded-at for table cells: "06 Oct 2026, 4:07 PM".
 * Built from date parts (not `toLocaleString()`) so the day-first
 * order and 12-hour AM/PM never depend on the browser locale. Uses
 * the viewer's local zone — the same zone the old `toLocaleString()`
 * rendered in — so no UTC shift is introduced. Invalid → em dash.
 */
export function formatRecordedIndia(
  value: string | null | undefined,
  fallback: string
): string {
  const parts = formatRecordedIndiaParts(value, fallback);
  if (!parts) return '—';
  return `${parts.date}, ${parts.time}`;
}

/**
 * Same computation as [formatRecordedIndia], split for two-line
 * cells that lead with the time (`time`: "4:07 PM",
 * `date`: "06 Oct 2026"). Null when unparseable. Not a second
 * formatter — identical parts, timezone, and no-seconds behavior.
 */
export function formatRecordedIndiaParts(
  value: string | null | undefined,
  fallback: string
): { time: string; date: string } | null {
  const date = new Date(value ?? fallback);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getDate()).padStart(2, '0');
  const month = IN_MONTHS[date.getMonth()] ?? '';
  const year = date.getFullYear();
  const h24 = date.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = h24 < 12 ? 'AM' : 'PM';
  return { time: `${h12}:${minutes} ${suffix}`, date: `${day} ${month} ${year}` };
}

export function isRecordingMimeType(value: unknown): value is RecordingMimeType {
  return (
    typeof value === 'string' &&
    (RECORDING_ALLOWED_MIME_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Validate an uploaded audio file BEFORE it touches Storage, so a
 * bad payload 400s without leaving an orphan object behind (same
 * discipline as `validateSendMessageParams` validating before
 * `resolveConversationByPhone` creates anything). Returns the
 * human-facing problem, or null when the file is acceptable.
 */
export function validateRecordingFile(file: {
  size: number;
  type: string;
}): string | null {
  if (!file.type || !isRecordingMimeType(file.type)) {
    return `Unsupported audio type '${file.type || 'unknown'}'. Supported: ${RECORDING_ALLOWED_MIME_TYPES.join(', ')}.`;
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return 'Empty audio file.';
  }
  if (file.size > RECORDING_MAX_BYTES) {
    return `Audio file is too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum is ${RECORDING_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/**
 * Validate the optional metadata fields. `recorded_at` must be a
 * parseable timestamp; `duration_seconds` a non-negative integer;
 * `direction` is 'in' | 'out' when present; `phone_number` is an
 * optional short string (matching evidence, normalized server-side);
 * `call_type` is 'phone' | 'whatsapp' | 'whatsapp_business' when
 * present. Returns the human-facing problem, or null when acceptable.
 */
export function validateRecordingMetadata(input: {
  recordedAt: string | null;
  durationSeconds: unknown;
  direction?: unknown;
  phoneNumber?: unknown;
  callType?: unknown;
}): string | null {
  if (input.recordedAt !== null && Number.isNaN(Date.parse(input.recordedAt))) {
    return "'recorded_at' must be an ISO 8601 timestamp.";
  }
  if (input.durationSeconds !== null && input.durationSeconds !== undefined) {
    if (
      typeof input.durationSeconds !== 'number' ||
      !Number.isInteger(input.durationSeconds) ||
      input.durationSeconds < 0
    ) {
      return "'duration_seconds' must be a non-negative integer.";
    }
  }
  if (input.direction !== null && input.direction !== undefined) {
    if (input.direction !== 'in' && input.direction !== 'out') {
      return "'direction' must be 'in' or 'out'.";
    }
  }
  if (input.phoneNumber !== null && input.phoneNumber !== undefined) {
    if (typeof input.phoneNumber !== 'string') {
      return "'phone_number' must be a string.";
    }
    if (input.phoneNumber.length > MAX_PHONE_NUMBER_LENGTH) {
      return `'phone_number' must be at most ${MAX_PHONE_NUMBER_LENGTH} characters.`;
    }
  }
  if (input.callType !== null && input.callType !== undefined) {
    if (
      input.callType !== 'phone' &&
      input.callType !== 'whatsapp' &&
      input.callType !== 'whatsapp_business'
    ) {
      return "'call_type' must be 'phone', 'whatsapp', or 'whatsapp_business'.";
    }
  }
  return null;
}

/**
 * Call types the upload endpoint accepts — exactly the
 * migration 107 vocabulary. Single source for validation;
 * CallVault's wire values must match these strings.
 */
export const RECORDING_CALL_TYPES = [
  'phone',
  'whatsapp',
  'whatsapp_business',
] as const;

export type RecordingCallType = (typeof RECORDING_CALL_TYPES)[number];

/**
 * Maximum accepted `phone_number` length. Matching needs ~15
 * digits plus formatting; anything longer is abuse, not a phone
 * number — rejected with 400 before any Storage write.
 */
export const MAX_PHONE_NUMBER_LENGTH = 64;
