import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { getOrCreateConversation } from '@/lib/conversations/get-or-create'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  buildDeliveryErrorRows,
  persistDeliveryErrors,
} from '@/lib/whatsapp/delivery-errors'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { isForwardMessageStatus } from '@/lib/whatsapp/message-status'
import { reconcileReminderDelivery } from '@/lib/followups/delivery'
import { resolveAssignment } from '@/lib/assignment/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { cleanupCompletedIncompleteRows } from '@/lib/flows/incomplete-sheet-cleanup'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { sendPushToAccount, buildPreview } from '@/lib/push/send'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Resolve which App Secret should validate this webhook's signature,
 * based on the phone_number_id in the incoming payload. Falls back to
 * the global META_APP_SECRET env var when the matching row has no
 * app_secret set (legacy / single-tenant accounts).
 */
async function resolveWebhookSecret(
  phoneNumberId: string | undefined,
): Promise<string | null> {
  if (phoneNumberId) {
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('app_secret')
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle()

    if (error) {
      console.error(
        '[webhook] failed to look up app_secret for phone_number_id:',
        phoneNumberId,
        error,
      )
    } else if (data?.app_secret) {
      try {
        return decrypt(data.app_secret)
      } catch (err) {
        console.error(
          '[webhook] app_secret decryption failed for phone_number_id:',
          phoneNumberId,
          err,
        )
      }
    }
  }

  return process.env.META_APP_SECRET ?? null
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
  /**
   * Present on the first message when the customer arrived via a
   * click-to-WhatsApp ad or a website "Chat on WhatsApp" button.
   * `source_url` is the ad/site the click came from; `source_type` is
   * 'ad' or 'post'. We persist these onto the contact (first-touch).
   */
  referral?: {
    source_url?: string
    source_type?: string
    source_id?: string
    headline?: string
    body?: string
    ctwa_clid?: string
  }
  /**
   * Populated by Meta when `type` is 'unsupported' — explains why the
   * message couldn't be relayed (view-once media, polls, disappearing
   * messages, etc). Not present on normal messages.
   */
  errors?: Array<{ code: number; title: string; message?: string }>
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
        errors?: Array<{
          code?: number
          title?: string
          message?: string
          href?: string
        }>
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

async function forwardRawToWebhooks(rawBody: string) {
  try {
    // Get all active webhook endpoints across all accounts
    const { data: endpoints } = await supabaseAdmin()
      .from('webhook_endpoints')
      .select('id, url, secret')
      .eq('is_active', true)

    if (!endpoints || endpoints.length === 0) return

    const { buildSignatureHeader } = await import('@/lib/webhooks/sign')
    const { decrypt } = await import('@/lib/whatsapp/encryption')
    const { isDeliverableUrl } = await import('@/lib/webhooks/ssrf')
    const tsSeconds = Math.floor(Date.now() / 1000)

    await Promise.allSettled(
      endpoints.map(async (endpoint: { id: string; url: string; secret: string }) => {
        try {
          if (!(await isDeliverableUrl(endpoint.url))) return
          const secret = decrypt(endpoint.secret)
          await fetch(endpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Wacrm-Signature': buildSignatureHeader(rawBody, secret, tsSeconds),
            },
            body: rawBody, // exact bytes Meta sent, untouched
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          })
        } catch (err) {
          console.error('[webhook] forward failed for', endpoint.id, err)
        }
      })
    )
  } catch (err) {
    console.error('[webhook] forwardRawToWebhooks failed:', err)
  }
}
// POST - Receive messages
// export async function POST(request: Request) {
//   // TEMP DEBUG — confirms whether Hostinger's Runtime Logs capture
//   // console.log (stdout) output from this route at all. Remove once
//   // logging visibility is confirmed.
//   console.log('[webhook] TEST LOG - request received at', new Date().toISOString())

//   // Read raw body first so we can HMAC-verify the exact bytes Meta
//   // signed. request.json() would re-encode and break the signature.
//   const rawBody = await request.text()
//   const signature = request.headers.get('x-hub-signature-256')

//   if (!verifyMetaWebhookSignature(rawBody, signature)) {
//     // 401 (not 200) — we want Meta's delivery dashboard to show failures
//     // loudly if a misconfiguration causes signatures to stop matching,
//     // rather than silently eating events.
//     console.warn('[webhook] rejected request with invalid signature')
//     return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
//   }

//   let body: { entry?: WhatsAppWebhookEntry[] }
//   try {
//     body = JSON.parse(rawBody)
//   } catch {
//     return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
//   }

//   // Process AFTER the response so we ack Meta within their ~20s timeout
//   // (a slow ack triggers Meta retries + duplicate inserts), while still
//   // guaranteeing the work runs to completion.
//   //
//   // This MUST use `after()` rather than a detached `processWebhook(body)`
//   // promise: on serverless platforms (we run on Vercel) the function can
//   // be frozen or terminated the moment the response is sent, so a floating
//   // promise's DB writes are not guaranteed to finish. That dropped a
//   // non-deterministic *subset* of inbound messages — contacts/conversations
//   // were created but the message insert never landed, leaving conversations
//   // that show in the inbox with an empty thread, and no logs to explain it
//   // (see issue #301). `after()` hands the callback to the runtime, which
//   // keeps the function alive until it resolves (within the route's
//   // maxDuration).
//   after(async () => {
//     try {
//       await forwardRawToWebhooks(rawBody)
//       await processWebhook(body)
//     } catch (error) {
//       console.error('Error processing webhook:', error)
//     }
//   })

//   return NextResponse.json({ status: 'received' }, { status: 200 })
// }
export async function POST(request: Request) {
  console.log('[webhook] TEST LOG - request received at', new Date().toISOString())

  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  // Parse early (read-only) so we can resolve the right App Secret
  // before verifying. Does not affect verification — that still runs
  // against the untouched rawBody bytes below.
  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const phoneNumberId =
    body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id

  const secret = await resolveWebhookSecret(phoneNumberId)

  if (!verifyMetaWebhookSignature(rawBody, signature, secret)) {
    console.warn(
      '[webhook] rejected request with invalid signature',
      phoneNumberId ? `(phone_number_id: ${phoneNumberId})` : '(no phone_number_id in payload)',
    )
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  after(async () => {
    try {
      await forwardRawToWebhooks(rawBody)
      await processWebhook(body)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        )
        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map((r: { account_id: string; user_id: string }) => `${r.account_id} (admin ${r.user_id})`)
        )
        continue
      }

      const config = configRows[0]

      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.user_id,
          decryptedAccessToken,
          body
        )
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
  errors?: Array<{
    code?: number
    title?: string
    message?: string
    href?: string
    error_data?: { details?: string }
  }>
}) {
  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()`: message_id is NOT unique (migration 009 — Meta ids
  //    repeat across numbers), so this updates 0..N rows and must not
  //    assume a single row.
  //    Forward-only: Meta redelivers and reorders status webhooks, so
  //    a late/duplicate `delivered` (or `sent`) arriving after `read`
  //    must never flip a Seen row back to Unseen. Rows already at or
  //    past the incoming status are left untouched.
  const { data: statusRows, error: statusFetchErr } = await supabaseAdmin()
    .from('messages')
    .select('id, status')
    .eq('message_id', status.id)

  // 1b) Persist Meta's errors[] (delivery diagnostics). Forward-only
  //     status rules below are unchanged; this only appends diagnostic
  //     rows. Account is resolved in step (3) via the same wamid
  //     lookup; unattributable wamids are skipped (table requires an
  //     account for tenant isolation).
  const forwardIds: string[] =
    !statusFetchErr && statusRows
      ? (
          (statusRows ?? []) as Array<{ id: string; status: string }>
        )
          .filter((row) => isForwardMessageStatus(row.status, status.status))
          .map((row) => row.id)
      : []

  if (statusFetchErr) {
    console.error('Error fetching messages for status update:', statusFetchErr)
  } else {
    if (forwardIds.length > 0) {
      const { error: msgErr } = await supabaseAdmin()
        .from('messages')
        .update({ status: status.status })
        .in('id', forwardIds)

      if (msgErr) {
        console.error('Error updating message status:', msgErr)
      }
    }
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 2b) Mirror onto whatsapp_followups via the reminder's own
  //     whatsapp_message_id. Reminders deliberately have no
  //     `messages` row, so steps (1) and (2) can never reach them —
  //     without this, a row would sit on `sent` forever even after
  //     Meta reported failure. `sent` is a no-op (acceptance was
  //     recorded at send time); `delivered`/`read` fill receipt
  //     timestamps; `failed` flips the row with Meta error detail.
  //     Never throws — reconciliation must not break webhook intake.
  try {
    await reconcileReminderDelivery(supabaseAdmin(), status.id, {
      status: status.status,
      timestamp: status.timestamp,
      errors: status.errors ?? null,
    })
  } catch (err) {
    console.error('Error reconciling reminder delivery:', err)
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
    // 1c) Persist Meta's errors[] for this status (delivery
    //     diagnostics). Best-effort: never throws, never blocks the
    //     mirrors above. Skipped when the wamid resolves to no
    //     account or carries no errors.
    if (accountId && status.errors && status.errors.length > 0) {
      const matchedIds = !statusFetchErr && statusRows
        ? ((statusRows ?? []) as Array<{ id: string }>).map((row) => row.id)
        : []
      await persistDeliveryErrors(
        supabaseAdmin(),
        buildDeliveryErrorRows({
          accountId,
          messageIds: matchedIds,
          providerMessageId: status.id,
          errors: status.errors,
          providerTimestampIso: tsIso,
        }),
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

/**
 * Plain text of an inbound message: the body, a media caption, or the
 * title of a tapped button/list row. Null for anything with no text
 * (audio, sticker, location, reaction).
 */
function inboundText(message: WhatsAppMessage): string | null {
  return (
    message.text?.body ??
    message.image?.caption ??
    message.video?.caption ??
    message.document?.caption ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    null
  )
}

/**
 * Text of the conversation's first *customer* message — the `first_message`
 * assignment trait. The inbound being processed hasn't been inserted yet at
 * assignment time, so a brand-new thread has no rows to read and falls back
 * to the text of this message.
 */
async function getFirstMessageText(
  conversationId: string,
  currentMessage: WhatsAppMessage
): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('messages')
    .select('content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return data?.content_text ?? inboundText(currentMessage)
}

/**
 * Resolve the display name for an inbound Meta contact entry.
 *
 * Meta does not guarantee `contacts[].profile` on every payload
 * (privacy-restricted senders, some message types, batched payloads
 * where the paired entry is missing). A direct `contact.profile.name`
 * throws `TypeError: Cannot read properties of undefined
 * (reading 'name')` and drops the whole webhook batch, so fall back
 * to the normalized sender phone when profile/name is absent.
 * `findOrCreateContact` already maps a falsy name to the phone on
 * insert (`name || phone`) and skips blank renames on update, so an
 * empty profile name still ends up as the phone downstream.
 */
export function resolveInboundContactName(
  contact: { profile?: { name?: string }; wa_id?: string } | undefined | null,
  fallbackPhone: string,
): string {
  return contact?.profile?.name ?? fallbackPhone
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile?: { name?: string }; wa_id: string },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string,
   rawMetaBody: { entry?: WhatsAppWebhookEntry[] }
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = resolveInboundContactName(contact, senderPhone)

  // Click-to-WhatsApp referral, if this inbound came from an ad/link.
  const referralSource = message.referral?.source_url
    ? {
        url: message.referral.source_url,
        type: message.referral.source_type,
        clid: message.referral.ctwa_clid,
      }
    : undefined

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName,
    referralSource
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Auto-assign. For an unassigned conversation this picks an agent; for
  // one that's already assigned the engine only returns a new agent when
  // reassign-on-offline is enabled and the current owner has gone offline.
  try {
    const traits: Record<string, string | null> = {
      name: contactRecord.name ?? null,
      phone: contactRecord.phone ?? null,
      city: contactRecord.city ?? null,
      country: contactRecord.country ?? null,
      source: contactRecord.source_url ?? null,
      ad_name: contactRecord.source_type ?? null,
      first_message: await getFirstMessageText(conversation.id, message),
    }
    const agentId = await resolveAssignment(supabaseAdmin(), accountId, traits, {
      currentAgentId: conversation.assigned_agent_id ?? null,
    })
    if (agentId && agentId !== conversation.assigned_agent_id) {
      await supabaseAdmin()
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('id', conversation.id)
      conversation.assigned_agent_id = agentId
    }
  } catch (err) {
    console.error('[webhook] auto-assignment failed:', err)
  }

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  // if (convResult.created) {
  //   await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
  //     conversation_id: conversation.id,
  //     contact_id: contactRecord.id,
  //   })
  // }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // ------------------------------------------------------------------
  // Silently drop Meta's "unsupported" placeholder messages.
  //
  // Meta sends `type: 'unsupported'` for things it can't relay: view-once
  // media, disappearing photos/videos, polls, payment requests, some
  // forwarded/Instagram-share formats. In practice this often arrives as
  // a *separate* message alongside a perfectly normal image/video (e.g.
  // a forwarded Instagram post sends the media as one message and a
  // "shared to..." marker as a second, unsupported one). It carries no
  // content we can show, so we log it for debugging and return before
  // ever touching `messages` — no bubble, no unread bump, no automation
  // dispatch. This intentionally runs before parseMessageContent so we
  // don't even build the "[Unsupported message type: ...]" text.
  // ------------------------------------------------------------------
  if (message.type === 'unsupported') {
    if (message.errors?.length) {
      console.warn(
        '[webhook] dropping unsupported message, errors:',
        JSON.stringify(message.errors)
      )
    } else {
      console.warn('[webhook] dropping unsupported message, id:', message.id)
    }
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, mediaFileName, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, media_file_name, media_mime_type, template_name,
  //   message_id, status, created_at
  // mediaType/mediaFileName are lightweight references (MIME +
  // original filename) — no bytes ever touch the DB.

  // The messages.content_type CHECK constraint (widened in migrations
  // 010 + 077) allows:
  //   text, image, document, audio, video, sticker, location,
  //   template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video', 'sticker',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // ------------------------------------------------------------------
  // Dedup / upgrade-in-place check.
  //
  // Meta's webhook delivery is at-least-once — the same message.id can
  // arrive more than once (e.g. a media message whose content wasn't
  // fully processed yet gets redelivered once it is). Rather than insert
  // a second bubble, check whether we already stored a row for this
  // exact (conversation_id, message_id) pair:
  //   - if the existing row is already "real" content and this delivery
  //     is just a repeat, skip it.
  //   - if the existing row somehow lacks content this delivery has
  //     (or the type changed), upgrade the row in place instead of
  //     inserting a duplicate.
  // ------------------------------------------------------------------
  const { data: existingMsg, error: existingMsgErr } = await supabaseAdmin()
    .from('messages')
    .select('id, content_type')
    .eq('conversation_id', conversation.id)
    .eq('message_id', message.id)
    .maybeSingle()

  if (existingMsgErr) {
    console.error('Error checking for existing message:', existingMsgErr)
  }

  if (existingMsg) {
    if (existingMsg.content_type === contentType && !mediaUrl) {
      // Identical redelivery of an already-complete message — skip.
      return
    }

    if (existingMsg.content_type !== contentType || mediaUrl) {
      const { error: upgradeErr } = await supabaseAdmin()
        .from('messages')
        .update({
          content_type: contentType,
          content_text: contentText,
          media_url: mediaUrl,
        })
        .eq('id', existingMsg.id)

      if (upgradeErr) {
        console.error('Error upgrading placeholder message:', upgradeErr)
      }
      return
    }

    return
  }

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    media_file_name: mediaFileName,
    media_mime_type: mediaType,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    // Only populated for content_type='interactive'. Migration 010 added
    // the column; null for every other content_type so existing inserts
    // behave identically.
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Update conversation
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // Web Push fan-out — notify account members who enabled notifications.
  // Awaited (inside the route's `after()` block) rather than fire-and-
  // forget: on serverless, an un-awaited promise can be frozen when the
  // `after()` callback resolves, aborting in-flight push requests before
  // they reach the slower push services — which shows up as "one device
  // gets it minutes later". `sendPushToAccount` is internally bounded
  // (per-subscription timeout) and never throws, so awaiting it can't
  // block the webhook or push a failure into the message pipeline.
  const senderPhoneDisplay = senderPhone ? `+${senderPhone}` : 'Unknown number'
  await sendPushToAccount(accountId, {
    title: senderPhoneDisplay,
    body: buildPreview(contentText) || `[${message.type}]`,
    url: `/inbox?c=${conversation.id}`,
    tag: `conversation-${conversation.id}`,
  })

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // A timed-out run can resume when the customer replies later. Once that
  // same run reaches its completed Google Sheets node, remove its keyed row
  // from the incomplete-runs sheet immediately. The flows cron performs the
  // same cleanup as a retry safety net for temporary Google/token failures.
  if (flowResult.outcome === 'completed') {
    try {
      await cleanupCompletedIncompleteRows(supabaseAdmin())
    } catch (error) {
      console.error(
        '[flows] immediate incomplete-sheet cleanup failed:',
        error instanceof Error ? error.message : error,
      )
    }
  }

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        ...(flowResult.flow_run_id ? { flow_run_id: flowResult.flow_run_id } : {}),
      },
      // Exact Flow-run pin (validated inside the engine against
      // account+contact). Especially relevant for first_inbound /
      // new_contact paths that still fire after flow consumption.
      flowRunId: flowResult.flow_run_id ?? null,
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
    raw_payload: rawMetaBody,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /** Original filename for inbound documents (Meta provides it
   *  transiently); null for everything else. */
  mediaFileName: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    mediaFileName: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
          mediaFileName: message.document.filename || null,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      // Meta uses type 'unsupported' when it received something the
      // Cloud API can't relay (view-once media, disappearing photos/
      // videos, polls, payment requests, some forwarded formats). The
      // `errors` array on the message explains why — log it so this
      // shows up as a real reason instead of a bare label.
      //
      // NOTE: 'unsupported' messages are now intercepted and dropped
      // earlier, in processMessage(), before parseMessageContent is
      // even called — so this branch only fires for a genuinely
      // unrecognized WhatsApp type we haven't explicitly modeled above
      // (future Meta additions, etc). Kept as a safe fallback.
      if (message.errors?.length) {
        console.warn(
          '[webhook] unsupported message errors:',
          JSON.stringify(message.errors)
        )
      }
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
  // Click-to-WhatsApp referral origin, when this inbound carried one.
  source?: { url?: string; type?: string; clid?: string }
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Build a patch for whatever changed. Name updates as before.
    const patch: Record<string, unknown> = {}
    if (name && name !== existingContact.name) {
      patch.name = name
    }
    // First-touch attribution: only stamp the referral source if the
    // contact doesn't already have one, so the original ad/link that
    // brought them in is preserved across later messages.
    if (source?.url && !existingContact.source_url) {
      patch.source_url = source.url
      if (source.type) patch.source_type = source.type
    }
    // First-touch for the click id too (independent of source_url so a
    // referral carrying only a clid is still captured once).
    if (source?.clid && !existingContact.ctwa_clid) {
      patch.ctwa_clid = source.clid
    }
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString()
      await supabaseAdmin()
        .from('contacts')
        .update(patch)
        .eq('id', existingContact.id)
    }
    return {
      contact: { ...existingContact, ...patch },
      wasCreated: false,
    }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  //
  // The source_* columns are only included when a referral is actually
  // present. This keeps the common (no-referral) insert byte-identical
  // to before, so it can't fail if the 035 migration hasn't been applied
  // yet — only genuine ad/link clicks touch the new columns.
  const insertData: Record<string, unknown> = {
    account_id: accountId,
    user_id: configOwnerUserId,
    phone,
    name: name || phone,
  }
  if (source?.url) {
    insertData.source_url = source.url
    if (source.type) insertData.source_type = source.type
  }
  if (source?.clid) {
    insertData.ctwa_clid = source.clid
  }
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert(insertData)
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Atomic single-thread-per-(account, contact) guarantee lives in
  // the shared helper (SELECT fast-path → INSERT → on 23505 re-SELECT
  // the racing winner, backed by migration 062's UNIQUE index).
  // Returns null only on genuine DB failure so callers keep their
  // existing drop-and-log behavior.
  try {
    return await getOrCreateConversation(
      supabaseAdmin(),
      accountId,
      contactId,
      configOwnerUserId,
    )
  } catch (err) {
    console.error('Error creating conversation:', err)
    return null
  }
}
