import { createHash } from 'crypto'
import { getMediaUrl } from './meta-api'

/**
 * Inbound WhatsApp media archival.
 *
 * Meta only keeps webhook media IDs for 7 days (Cloud API reference:
 * "Media IDs in webhooks expire after 7 days"). The inbox used to store
 * `/api/whatsapp/media/{id}` and re-resolve the bytes from Meta on every
 * view, so anything older than a week became permanently unopenable.
 *
 * This module is the single source of truth for the archive:
 *
 *   bucket: inbound-media   (private; service-role access only)
 *   path:   {account_id}/{media_id}
 *
 * The path is deterministic, which means:
 *   - the media route can look up an archived object without any DB
 *     change (the media id is already in `messages.media_url`),
 *   - account isolation is part of the key, and
 *   - re-delivered webhooks overwrite nothing (duplicate = success).
 *
 * No credentials are ever logged. Failures are bounded and swallowed by
 * callers so message ingestion is never blocked.
 */

export const INBOUND_MEDIA_BUCKET = 'inbound-media'

/** Live bucket limit on this deployment is 50 MB (provider cap). */
export const INBOUND_MEDIA_MAX_BYTES = 50 * 1024 * 1024

const RETRY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 300
const TOTAL_BUDGET_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 8_000
const UPLOAD_TIMEOUT_MS = 10_000

export interface ArchiveInboundMediaArgs {
  accountId: string
  mediaId: string
  accessToken: string
  /** MIME from the webhook payload, with Meta's response as fallback. */
  mimeType?: string | null
  /** Original filename for documents (Meta provides it only on webhook). */
  fileName?: string | null
  /** Already-resolved Meta CDN URL, to avoid a second metadata call. */
  downloadUrl?: string
  conversationId?: string | null
  whatsappMessageId?: string | null
  receivedAt?: string | null
}

export interface ArchiveInboundMediaResult {
  ok: boolean
  path: string
  size?: number
  sha256?: string
  /** True when the object already existed (duplicate webhook delivery). */
  alreadyArchived?: boolean
  error?: string
}

/**
 * Deterministic storage key. Both segments are opaque IDs; validating
 * them keeps path traversal out of the storage URL.
 */
export function inboundMediaPath(accountId: string, mediaId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId)) {
    throw new Error('Invalid account id for inbound media path')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(mediaId)) {
    throw new Error('Invalid media id for inbound media path')
  }
  return `${accountId}/${mediaId}`
}

function storageBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) throw new Error('Supabase URL is not configured')
  return base.replace(/\/+$/, '')
}

function serviceHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('Supabase service role key is not configured')
  return { apikey: key, Authorization: `Bearer ${key}` }
}

function storageObjectUrl(path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${storageBaseUrl()}/storage/v1/object/${INBOUND_MEDIA_BUCKET}/${encoded}`
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function metadataHeader(meta: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value !== null && value !== undefined && value !== '') clean[key] = value
  }
  return Buffer.from(JSON.stringify(clean), 'utf8').toString('base64')
}

/**
 * Download the media from Meta and store it in the private bucket.
 *
 * Bounded: 3 attempts within a 20 s budget. Every failure is logged and
 * returned as `{ ok: false }` — this function never throws, so a webhook
 * can await it without risking message ingestion.
 */
export async function archiveInboundMedia(
  args: ArchiveInboundMediaArgs
): Promise<ArchiveInboundMediaResult> {
  const { accountId, mediaId, accessToken } = args
  let path = ''

  try {
    path = inboundMediaPath(accountId, mediaId)
  } catch (error) {
    console.error(
      '[inbound-media] invalid archive path:',
      error instanceof Error ? error.message : 'unknown'
    )
    return { ok: false, path, error: 'invalid_path' }
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS
  let lastError = 'unknown'

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const sourceUrl =
        args.downloadUrl ??
        (await getMediaUrl({ mediaId, accessToken })).url

      const downloadTimeout = Math.max(
        1,
        Math.min(DOWNLOAD_TIMEOUT_MS, deadline - Date.now())
      )
      const download = await fetch(sourceUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(downloadTimeout),
      })
      if (!download.ok) {
        throw new Error(`download failed: ${download.status}`)
      }

      const declaredSize = Number(download.headers.get('content-length') || 0)
      if (declaredSize > INBOUND_MEDIA_MAX_BYTES) {
        console.error(
          '[inbound-media] skipping archive, media exceeds bucket limit:',
          JSON.stringify({
            accountId,
            mediaId,
            bytes: declaredSize,
            limit: INBOUND_MEDIA_MAX_BYTES,
          })
        )
        return { ok: false, path, error: 'too_large' }
      }

      const bytes = Buffer.from(await download.arrayBuffer())
      if (bytes.length > INBOUND_MEDIA_MAX_BYTES) {
        console.error(
          '[inbound-media] skipping archive, media exceeds bucket limit:',
          JSON.stringify({
            accountId,
            mediaId,
            bytes: bytes.length,
            limit: INBOUND_MEDIA_MAX_BYTES,
          })
        )
        return { ok: false, path, error: 'too_large' }
      }

      const digest = sha256(bytes)
      const mimeType =
        args.mimeType || download.headers.get('content-type') || 'application/octet-stream'

      const metadata = {
        account_id: accountId,
        media_id: mediaId,
        conversation_id: args.conversationId ?? null,
        wa_message_id: args.whatsappMessageId ?? null,
        mime_type: mimeType,
        original_filename: args.fileName ?? null,
        received_at: args.receivedAt ?? null,
        archived_at: new Date().toISOString(),
        sha256: digest,
        size: bytes.length,
      }

      const uploadTimeout = Math.max(
        1,
        Math.min(UPLOAD_TIMEOUT_MS, deadline - Date.now())
      )
      const upload = await fetch(storageObjectUrl(path), {
        method: 'POST',
        headers: {
          ...serviceHeaders(),
          'Content-Type': mimeType,
          'x-upsert': 'false',
          'x-metadata': metadataHeader(metadata),
        },
        body: bytes,
        signal: AbortSignal.timeout(uploadTimeout),
      })

      if (upload.ok) {
        return { ok: true, path, size: bytes.length, sha256: digest }
      }
      if (upload.status === 409) {
        // Another delivery (or the recovery backfill) already archived it.
        return {
          ok: true,
          path,
          size: bytes.length,
          sha256: digest,
          alreadyArchived: true,
        }
      }
      throw new Error(`upload failed: ${upload.status}`)
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'unknown'
      if (Date.now() >= deadline || attempt === RETRY_ATTEMPTS) break
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
    }
  }

  console.error(
    '[inbound-media] archive failed after retries:',
    JSON.stringify({ accountId, mediaId, attempts: RETRY_ATTEMPTS, error: lastError })
  )
  return { ok: false, path, error: lastError }
}

export interface FetchArchivedInboundMediaArgs {
  accountId: string
  mediaId: string
  /** Browser Range header, forwarded so PDF/video seeking still works. */
  range?: string | null
}

/**
 * Read an archived object. Returns `null` when the object does not exist
 * (so the caller can fall back to Meta) and also on transient storage
 * errors — Meta fallback is always preferable to a hard failure while
 * the upstream media is still within its 7-day window.
 */
export async function fetchArchivedInboundMedia(
  args: FetchArchivedInboundMediaArgs
): Promise<Response | null> {
  let path: string
  try {
    path = inboundMediaPath(args.accountId, args.mediaId)
  } catch {
    return null
  }

  try {
    const headers: Record<string, string> = serviceHeaders()
    if (args.range) headers.Range = args.range
    const response = await fetch(storageObjectUrl(path), {
      headers,
      signal: AbortSignal.timeout(20_000),
    })

    // Supabase Storage returns 400 + NoSuchKey for a missing object and
    // 404 for an unknown bucket/path. Both mean "not archived".
    if (response.status === 400 || response.status === 404) {
      return null
    }
    if (!response.ok && response.status !== 206) {
      console.error(
        '[inbound-media] storage read failed:',
        JSON.stringify({
          accountId: args.accountId,
          mediaId: args.mediaId,
          status: response.status,
        })
      )
      return null
    }
    return response
  } catch (error) {
    console.error(
      '[inbound-media] storage read failed:',
      JSON.stringify({
        accountId: args.accountId,
        mediaId: args.mediaId,
        error: error instanceof Error ? error.message : 'unknown',
      })
    )
    return null
  }
}
