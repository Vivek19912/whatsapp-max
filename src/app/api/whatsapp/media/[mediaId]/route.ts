import { NextResponse } from 'next/server'
import { requireAuthenticatedUser } from '@/lib/auth/account'
import { canViewConversation, resolveViewerCaps } from '@/lib/inbox/assignment-access'
import { getMediaUrl, downloadMediaStream } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchArchivedInboundMedia } from '@/lib/whatsapp/inbound-media'

/**
 * Relay an upstream response (archived object or Meta CDN) to the
 * browser, preserving the headers that PDF/video viewers need.
 */
function buildMediaResponse(
  upstream: Response,
  request: Request,
  fallbackContentType?: string,
) {
  const headers = new Headers()
  const contentType =
    upstream.headers.get('content-type') ||
    fallbackContentType ||
    'application/octet-stream'
  headers.set('Content-Type', contentType)
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers.set('Content-Length', contentLength)
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) headers.set('Content-Range', contentRange)
  const acceptRanges = upstream.headers.get('accept-ranges')
  headers.set('Accept-Ranges', acceptRanges || 'bytes')
  // Inline rendering by default (image/video/audio/PDF preview);
  // the Inbox Download button passes ?download=1 (or uses the
  // download attribute) to force an attachment instead.
  const asAttachment = new URL(request.url).searchParams.get('download') === '1'
  if (asAttachment) {
    headers.set('Content-Disposition', 'attachment')
  }
  headers.set('Cache-Control', 'public, max-age=86400')

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const guard = await requireAuthenticatedUser()
    if (!guard.ok) {
      return NextResponse.json(guard.body, { status: guard.status })
    }
    const { supabase, userId } = guard

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id, account_role')
      .eq('user_id', userId)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    const callerRole = (profile as { account_role?: string } | null)?.account_role ?? null
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Assignment gate: an inbound media URL belongs to a message in a
    // thread. Agents may only fetch media from threads assigned to
    // them (owner/admin: anywhere; viewers: legacy read parity). The
    // media row is located by its exact stored proxy URL. No row
    // match (e.g. template header art) keeps the legacy behavior.
    // A row whose thread is outside this account 404s instead of
    // falling through, so a known media id can never cross accounts.
    {
      const { data: msg } = await supabase
        .from('messages')
        .select('conversation_id')
        .eq('media_url', `/api/whatsapp/media/${mediaId}`)
        .limit(1)
        .maybeSingle()
      const threadId = (msg as { conversation_id: string } | null)?.conversation_id
      if (threadId) {
        const { data: conv } = await supabase
          .from('conversations')
          .select('assigned_agent_id')
          .eq('id', threadId)
          .eq('account_id', accountId)
          .maybeSingle()
        if (!conv) {
          return NextResponse.json({ error: 'Media not found' }, { status: 404 })
        }
        // View-all agents pass via caps; everyone else follows the
        // base assignment rule. Caps resolve server-side from the
        // permissions table (never from client claims).
        const caps = await resolveViewerCaps(supabase, accountId, userId, callerRole)
        const assigned = (conv as { assigned_agent_id: string | null }).assigned_agent_id ?? null
        if (!canViewConversation({ role: callerRole, userId }, assigned, caps)) {
          return NextResponse.json({ error: 'Media not found' }, { status: 404 })
        }
      }
    }

    // Storage-first: inbound bytes archived at webhook time live in the
    // private `inbound-media` bucket. Serve those even after Meta's
    // 7-day webhook media window has passed. Missing/transient objects
    // fall through to the live Meta fetch below.
    const archived = await fetchArchivedInboundMedia({
      accountId,
      mediaId,
      range: request.headers.get('range'),
    })
    if (archived) {
      return buildMediaResponse(archived, request)
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta (short-lived — resolved fresh on
    // every request, never persisted).
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Stream Meta's bytes straight through to the browser — nothing is
    // buffered in Node memory, nothing is stored. The browser's Range
    // header (video/audio seeking, progressive PDFs) is forwarded so
    // Meta's 206 partial response relays back intact.
    const upstream = await downloadMediaStream({
      downloadUrl: mediaInfo.url,
      accessToken,
      range: request.headers.get('range'),
    })

    return buildMediaResponse(upstream, request, mediaInfo.mimeType)
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    const message = error instanceof Error ? error.message : ''
    // Meta code 100 / subcode 33 ("Unsupported get request ... does not
    // exist") means the webhook media ID has passed its 7-day window and
    // no archived copy exists. Return 410 (not a generic 500) so the UI
    // can explain it is permanently gone instead of "try again".
    if (
      message.includes('(code 100') ||
      message.includes('subcode 33') ||
      message.toLowerCase().includes('does not exist')
    ) {
      return NextResponse.json(
        { error: 'Attachment expired and not archived' },
        { status: 410 }
      )
    }
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
