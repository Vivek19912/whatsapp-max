import { createClient } from "@/lib/supabase/client";

/**
 * Shared media-upload helper for Supabase Storage buckets that use the
 * account-scoped path convention introduced in migration 020
 * (`flow-media`) and reused by migration 023 (`chat-media`):
 *
 *   <bucket>/account-<account_id>/<timestamp>-<basename>.<ext>
 *
 * The first path segment (`account-<uuid>`) is what the bucket's RLS
 * write policies match on, so every caller MUST go through here rather
 * than hand-rolling a path — a mismatched segment is silently rejected
 * by RLS. Both the Flows builder (`node-config-form`) and the inbox
 * composer call this so the logic lives in exactly one place.
 */

/**
 * MIME types the platform accepts for WhatsApp image headers. Kept
 * narrow on purpose: an incorrect image/* label breaks Meta media
 * fetch, while an unknown type must never be guessed as an image.
 */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const KNOWN_IMAGE_MIMES = new Set(Object.values(IMAGE_MIME_BY_EXTENSION));

/**
 * Detect an image MIME type from file magic bytes. Returns null when
 * the signature is not a recognized PNG/JPEG/GIF/WebP image.
 * Pure + unit-tested; used to cross-check uploads when bytes are
 * available and to never mislabel unknown files.
 */
export function detectImageMimeFromBytes(
  bytes: Uint8Array | ArrayBuffer,
): string | null {
  const b =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  if (b.length < 3) return null;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (b.length < 6) return null;
  // GIF87a / GIF89a
  if (
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  ) {
    return "image/gif";
  }
  if (b.length < 8) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  if (b.length < 12) return null;
  // WebP: RIFF....WEBP
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Resolve the Content-Type to store for an upload.
 *
 * Rules (in order):
 * 1. A browser-supplied type that is a known image MIME is preserved
 *    when it agrees with the bytes (if bytes were supplied).
 * 2. Any other non-empty browser type is preserved untouched (video,
 *    audio, documents and all non-image behaviour unchanged).
 * 3. When the browser type is empty/missing, infer PNG/JPG/JPEG/WebP/
 *    GIF from the file extension.
 * 4. Otherwise return null so callers omit `contentType` instead of
 *    storing an empty value (empty previously became
 *    `application/octet-stream`, which breaks Meta image fetch).
 * 5. Prefer actual file signatures over filename extensions when the
 *    two disagree: a mismatch resolves to null, never to a wrong
 *    image label.
 */
export function resolveUploadContentType(
  fileName: string,
  browserType: string | null | undefined,
  bytes?: Uint8Array | ArrayBuffer,
): string | null {
  const trimmed = (browserType ?? "").trim();
  if (trimmed !== "" && !KNOWN_IMAGE_MIMES.has(trimmed)) return trimmed;
  if (trimmed !== "") {
    if (!bytes) return trimmed;
    const sniffed = detectImageMimeFromBytes(bytes);
    return sniffed === trimmed ? trimmed : null;
  }
  const match = /\.([^.]+)$/.exec(fileName ?? "");
  const inferred =
    (match ? IMAGE_MIME_BY_EXTENSION[match[1].toLowerCase()] : undefined) ??
    null;
  if (!inferred) return null;
  if (!bytes) return inferred;
  const sniffed = detectImageMimeFromBytes(bytes);
  return sniffed === inferred ? inferred : null;
}

/** 16 MB — matches the `file_size_limit` on both buckets (migrations 016/020/023). */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file that the bucket would accept (≤16 MB) but Meta would reject is
 * caught client-side BEFORE upload — otherwise it lands in storage as an
 * orphan and the send fails with a confusing 400. Images are Meta's
 * tightest cap at 5 MB; documents are held at the 16 MB bucket limit
 * (Meta allows 100 MB, but the bucket — and shared-hosting upload UX —
 * caps lower).
 */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
  sticker: 512 * 1024,
} as const;

/**
 * Build the account-scoped object path for an upload. Pure + exported so
 * it can be unit-tested without a Supabase client.
 *
 * - `basename` is stripped of its extension, lower-cased non-safe chars
 *   are collapsed to `_`, and it's capped at 40 chars (falls back to
 *   "file" when empty).
 * - The timestamp + the original name keep collisions between two
 *   concurrent uploads astronomically unlikely.
 */
export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number = Date.now(),
): string {
  // Only treat the trailing segment as an extension when there's a real
  // one — a bare name like "README" has no extension and falls back to
  // "bin" rather than becoming "readme".
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  return `account-${accountId}/${now}-${safeBase}.${ext}`;
}

export interface UploadAccountMediaResult {
  /** Public URL Meta can fetch at send time. */
  publicUrl: string;
  /** Storage object path (account-scoped). */
  path: string;
}

/**
 * Upload a file to an account-scoped Storage bucket and return its public
 * URL. Throws with a user-facing message on auth / account-resolution /
 * upload failure — callers surface it via a toast.
 *
 * Size validation is the caller's responsibility (limits can differ per
 * feature); `MEDIA_MAX_BYTES` is exported for the common case.
 */
export async function uploadAccountMedia(
  bucket: string,
  file: File,
): Promise<UploadAccountMediaResult> {
  const supabase = createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new Error("Not signed in.");
  }

  // Resolve account_id so the path is account-scoped (matches the
  // bucket's RLS write policy from migration 020/023). User-scoped
  // paths would be rejected.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (profileErr || !profile?.account_id) {
    throw new Error("Could not resolve your account.");
  }

  const path = buildMediaPath(profile.account_id as string, file.name);
  // Never store an empty content type: empty previously became
  // `application/octet-stream`, which breaks Meta image fetch for
  // WhatsApp template headers. Extension-inferred for known image
  // formats; omitted (Storage default) otherwise.
  const contentType = resolveUploadContentType(file.name, file.type);
  const { error: upErr } = await supabase.storage.from(bucket).upload(
    path,
    file,
    contentType
      ? { cacheControl: "3600", upsert: false, contentType }
      : { cacheControl: "3600", upsert: false },
  );
  if (upErr) throw new Error(upErr.message);

  const {
    data: { publicUrl },
  } = supabase.storage.from(bucket).getPublicUrl(path);

  return { publicUrl, path };
}

/**
 * Delete a previously-uploaded object. Used to GC media that was staged
 * (uploaded) but never sent — a cancelled draft or a failed Meta send —
 * so abandoned attachments don't accumulate in the public bucket. The
 * DELETE is gated by the same account-scoped RLS policy as the upload,
 * so a caller can only remove objects under their own account folder.
 *
 * Best-effort: callers fire-and-forget and swallow errors (a missed
 * delete is a storage nit, not something to surface to the user).
 */
export async function deleteAccountMedia(
  bucket: string,
  path: string,
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) throw new Error(error.message);
}
