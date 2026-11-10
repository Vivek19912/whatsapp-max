import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import {
  detectPdfFromBytes,
  TEMPLATE_DOCUMENT_MAX_BYTES,
  TEMPLATE_DOCUMENT_MIME,
} from '@/lib/whatsapp/template-document'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE header — a plain public
 * URL is not accepted at creation time. This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload, so both the upload path
 * and the legacy URL path actually succeed.
 *
 * No-op unless the header is an image that has a URL but no handle yet.
 * Image-only for now (the #230 scope); video/document handles can follow
 * the same shape.
 */

// Meta's image-header sample limits.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png']

export async function ensureImageHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
  metaAppId?: string | null,
): Promise<void> {
  if (payload.header_type !== 'image') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  // Prefer the account's own Meta App ID (Settings → WhatsApp) so each
  // client can use their own app; fall back to the global env var for
  // single-tenant / local setups.
  const appId = metaAppId?.trim() || process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Image-header templates need a Meta App ID. Add it in Settings → WhatsApp (Meta App ID field), or remove the image header.',
    )
  }

  // Fetch the sample image bytes (works for our uploaded chat-media URL
  // and for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url)
  } catch {
    throw new Error('Could not fetch the header image URL. Make sure it is publicly reachable.')
  }
  if (!res.ok) {
    throw new Error(`Header image URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !ALLOWED_IMAGE_TYPES.includes(contentType)) {
    throw new Error(`Header image must be JPEG or PNG (got ${contentType}).`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error('Header image is empty.')
  }
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error(
      `Header image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's limit is 5 MB.`,
    )
  }

  const mimeType = ALLOWED_IMAGE_TYPES.includes(contentType) ? contentType : 'image/jpeg'
  const fileName = mimeType === 'image/png' ? 'header.png' : 'header.jpg'

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}

// Meta's document-header sample limits (template creation).
const DOCUMENT_MAX_BYTES = TEMPLATE_DOCUMENT_MAX_BYTES
const DOCUMENT_MIME = TEMPLATE_DOCUMENT_MIME
const DOCUMENT_FILE_NAME = 'header.pdf'

function resolveMediaAppId(metaAppId?: string | null): string {
  // Prefer the account's own Meta App ID (Settings → WhatsApp) so each
  // client can use their own app; fall back to the global env var for
  // single-tenant / local setups.
  const appId = metaAppId?.trim() || process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Document-header templates need a Meta App ID. Add it in Settings → WhatsApp (Meta App ID field), or remove the document header.',
    )
  }
  return appId
}

/**
 * Derive a Resumable-Upload handle for a DOCUMENT header sample and
 * write it onto the payload. Accepts both sources the dialog offers:
 * a freshly uploaded `template-media` PDF URL or a pasted public
 * HTTPS link — both are fetched server-side, content-checked
 * (`%PDF-` magic), and uploaded to Meta via the resumable flow.
 *
 * No-op unless the header is a document that has a URL but no handle
 * yet. Throws actionable errors (unreachable URL, non-PDF content,
 * over-limit size, missing App ID) that the route maps to HTTP 400.
 *
 * NOTE: `header_handle` is a creation-time sample handle — it must
 * never be confused with an ordinary WhatsApp message `media_id`
 * used at send time (see template-send-builder.ts).
 */
export async function ensureDocumentHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
  metaAppId?: string | null,
): Promise<void> {
  if (payload.header_type !== 'document') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = resolveMediaAppId(metaAppId)

  // Fetch the sample PDF bytes (works for our just-uploaded
  // template-media URL and for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url)
  } catch {
    throw new Error('Could not fetch the header document URL. Make sure it is publicly reachable.')
  }
  if (!res.ok) {
    throw new Error(`Header document URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  // A clearly non-PDF content type fails fast; an absent/generic type
  // falls through to the magic-byte check on the actual content.
  if (contentType !== '' && contentType !== DOCUMENT_MIME && contentType !== 'application/octet-stream') {
    throw new Error(`Header document must be a PDF (got ${contentType}).`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error('Header document is empty.')
  }
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
    throw new Error(
      `Header document is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's document limit is 100 MB.`,
    )
  }
  if (!detectPdfFromBytes(bytes)) {
    throw new Error('Header document URL did not return a valid PDF (content check failed).')
  }

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName: DOCUMENT_FILE_NAME,
    mimeType: DOCUMENT_MIME,
    bytes,
  })
  payload.header_handle = handle
}

/**
 * Derive the Resumable-Upload handle for any media header that needs
 * one (IMAGE, DOCUMENT). Plain-URL creation is rejected by Meta, so
 * both the uploaded-file URL and the pasted-link URL go through the
 * same server-side fetch → validate → resumable-upload flow, yielding
 * `example.header_handle` for the template payload. VIDEO headers
 * keep the legacy `header_url` fallback (out of scope).
 *
 * No-op for text/none headers and when a handle already exists.
 */
export async function ensureMediaHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
  metaAppId?: string | null,
): Promise<void> {
  if (payload.header_type === 'image') {
    await ensureImageHeaderHandle(payload, accessToken, metaAppId)
    return
  }
  if (payload.header_type === 'document') {
    await ensureDocumentHeaderHandle(payload, accessToken, metaAppId)
    return
  }
}
