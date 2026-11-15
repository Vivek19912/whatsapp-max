/**
 * Call Recorder (CallVault) APK distribution.
 *
 * One permanent, version-independent download endpoint:
 *   https://whatsappmax.in/download/call-recorder
 * Publishing a newer approved release means replacing the artifact
 * behind this endpoint — the QR code and the Download button never
 * change. Both encode/link this exact URL (never a version-specific
 * URL, never an expiring signed URL, never localhost).
 */

export const CALL_RECORDER_DOWNLOAD_PATH = '/download/call-recorder';

/** Canonical production host — the fallback when the site URL env is unset. */
export const CALL_RECORDER_PRODUCTION_HOST = 'https://whatsappmax.in';

/**
 * Public origin of this deployment. Never localhost: when
 * NEXT_PUBLIC_SITE_URL is unset we fall back to the canonical
 * production host so a QR baked from this URL is always scannable.
 */
export function callRecorderSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '');
  if (raw) return raw;
  return CALL_RECORDER_PRODUCTION_HOST;
}

/** Absolute permanent download URL encoded in the QR and used by the button. */
export function callRecorderDownloadUrl(): string {
  return `${callRecorderSiteUrl()}${CALL_RECORDER_DOWNLOAD_PATH}`;
}
