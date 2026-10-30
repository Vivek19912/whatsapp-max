import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SendMessageError,
  sendReminderToAgent,
  sendReminderViaTemplate,
} from '@/lib/followups/reminder-send';
import { normalizeAgentWhatsappNumber } from '@/lib/followups/types';
import { persistReminderOutboundMessage } from '@/lib/whatsapp/send-message';

// ============================================================
// Reminder scheduler: claim due rows and deliver each reminder TO
// ITS CREATOR's stored WhatsApp number (`recipient_phone`,
// snapshotted at creation) FROM the account's connected WhatsApp
// Business number. Mirrors the automations-cron claim pattern
// (status flip = lock, affected-row check = ownership).
//
// Send selection per attempt: when the agent's number messaged
// the business within the last 24 hours, the reminder goes as
// free text; otherwise it goes through the account's configured
// APPROVED fallback template (`{{1}}` = reminder text). Either
// way the destination is ALWAYS the row's `recipient_phone`
// snapshot — nothing may override it.
//
// A reminder is personal, not a customer message, so this path
// still avoids everything customer-related:
//   - no customer contact / conversation lookup or creation (the
//     Inbox thread below resolves from the RECIPIENT phone only),
//   - no flow-run pausing, no contact phone auto-correct.
// The destination is ALWAYS the row's `recipient_phone` snapshot;
// nothing may override it (not latest messages, assignment, or
// profile state — a later profile-number change does not alter
// already-created reminders).
//
// Inbox visibility: after a successful Meta send, the reminder is
// persisted as a normal outbound `messages` row on the recipient's
// own thread (created via the standard contact/conversation
// helpers), so the Inbox shows it like any business-sent message
// and the status webhook advances it sent → delivered → read on
// the same row. Persistence is best-effort and idempotent on the
// wamid — it never changes the reminder's own sent/failed outcome.
//
// Idempotency: a row is only processed after an atomic
// scheduled→processing flip affecting exactly that row; already-sent
// rows are never re-sent; stale 'processing' rows (crashed worker)
// are reclaimed while attempts < MAX_ATTEMPTS, then failed.
// ============================================================

export const FOLLOWUP_BATCH_LIMIT = 25;
export const FOLLOWUP_MAX_ATTEMPTS = 3;
/** 24-hour customer-service window for free-text sends. */
export const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Crashed-worker reclaim horizon (updated_at older than this). */
export const FOLLOWUP_STALE_MS = 10 * 60 * 1000;

interface FollowupRow {
  id: string;
  account_id: string;
  recipient_phone: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  scheduled_for: string;
  message_text: string;
  template_name: string | null;
  template_language: string | null;
  status: string;
  attempts: number;
  created_by: string | null;
  /**
   * Explicit per-reminder destination override (migration 140).
   * When true, the scheduler never re-points recipient_phone at the
   * creator's current Settings number. Defaults to false so every
   * historical row keeps the legacy refresh behavior.
   */
  recipient_custom: boolean;
}

function toFollowup(row: Record<string, unknown>): FollowupRow {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    recipient_phone: (row.recipient_phone as string | null) ?? null,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    scheduled_for: row.scheduled_for as string,
    message_text: row.message_text as string,
    template_name: (row.template_name as string | null) ?? null,
    template_language: (row.template_language as string | null) ?? null,
    status: row.status as string,
    attempts: (row.attempts as number) ?? 0,
    created_by: (row.created_by as string | null) ?? null,
    recipient_custom: (row.recipient_custom as boolean | null) ?? false,
  };
}

export interface DrainResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

async function markFollowup(
  db: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from('whatsapp_followups').update(patch).eq('id', id);
  if (error) {
    console.error('[followups] status update failed:', error.message);
  }
}

function digitsOnly(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/**
 * Re-point a still-scheduled row whose snapshot went stale: when
 * the creator's CURRENT Reminder WhatsApp Number
 * (`profiles.whatsapp_number`) is valid and differs from the
 * stored snapshot, persist the current number on the row and
 * return it for this send. Returns null when the snapshot stays
 * authoritative (match, no valid current number, or an explicit
 * per-reminder override — `recipient_custom` rows are never
 * re-pointed; the send then proceeds with the snapshot exactly as
 * before). Never throws; never reads the Customer field. Only ever
 * called for rows under an atomic claim — sent/failed/cancelled
 * history is never rewritten.
 */
async function refreshStaleRecipient(
  db: SupabaseClient,
  row: FollowupRow,
  current: FollowupRow,
): Promise<string | null> {
  try {
    if (!row.created_by || !current.recipient_phone) return null;
    if (current.recipient_custom) return null;
    const { data, error } = await db
      .from('profiles')
      .select('whatsapp_number')
      .eq('user_id', row.created_by)
      .maybeSingle();
    if (error || !data) return null;
    const live = normalizeAgentWhatsappNumber(
      (data as { whatsapp_number?: unknown }).whatsapp_number,
    );
    if (!live || live === current.recipient_phone) return null;
    await markFollowup(db, row.id, { recipient_phone: live });
    console.log('[followups] reminder recipient refreshed', {
      reminder_id: row.id,
      from: maskPhoneForLog(current.recipient_phone),
      to: maskPhoneForLog(live),
    });
    return live;
  } catch (err) {
    console.error('[followups] recipient refresh failed:', err);
    return null;
  }
}

/**
 * Is the 24-hour customer-service window open for this recipient?
 * True when the agent's number sent an inbound WhatsApp message to
 * the business within the last 24 hours (matched by trailing
 * digits, so stored/contact formatting differences don't matter).
 * The agent is usually not a contact row, so matching runs by
 * phone, never by contact identity. Any DB failure resolves to
 * closed — the template path always delivers, so failing toward
 * it is the safe direction. Never throws.
 */
export async function isReminderWindowOpen(
  db: SupabaseClient,
  accountId: string,
  recipientPhone: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const suffix = digitsOnly(recipientPhone).slice(-10);
    if (suffix.length < 10) return false;

    const { data: contacts, error: contactsErr } = await db
      .from('contacts')
      .select('id, phone')
      .eq('account_id', accountId);
    if (contactsErr || !contacts) return false;
    const contactIds = (
      (contacts ?? []) as Array<{ id: string; phone?: string | null }>
    )
      .filter((c) => digitsOnly(c.phone).endsWith(suffix))
      .map((c) => c.id);
    if (contactIds.length === 0) return false;

    const { data: conversations, error: convErr } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .in('contact_id', contactIds);
    if (convErr || !conversations) return false;
    const conversationIds = (
      (conversations ?? []) as Array<{ id: string }>
    ).map((c) => c.id);
    if (conversationIds.length === 0) return false;

    const { data: latest, error: msgErr } = await db
      .from('messages')
      .select('created_at')
      .in('conversation_id', conversationIds)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (msgErr || !latest) return false;
    const at = Date.parse(
      (latest as { created_at: string }).created_at,
    );
    if (!Number.isFinite(at)) return false;
    return now.getTime() - at < REMINDER_WINDOW_MS;
  } catch {
    return false;
  }
}

async function processOne(
  db: SupabaseClient,
  row: FollowupRow,
  now: Date = new Date(),
): Promise<'sent' | 'failed' | 'skipped'> {
  // Re-read under the claim: skip anything no longer scheduled
  // (cancelled concurrently) or already finished.
  const { data: fresh, error: freshErr } = await db
    .from('whatsapp_followups')
    .select('*')
    .eq('id', row.id)
    .maybeSingle();
  if (freshErr || !fresh) return 'skipped';
  const current = toFollowup(fresh as Record<string, unknown>);
  if (current.status === 'cancelled' || current.status === 'sent') {
    return 'skipped';
  }
  // The recipient is the immutable creation-time snapshot of the
  // creator's own WhatsApp number. Legacy rows without one fail
  // loudly — the scheduler must never guess (no customer phone,
  // no profile re-read, no conversation inference).
  if (!current.recipient_phone) {
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason:
        'Reminder has no recipient phone number. Re-create it after adding your WhatsApp number in Settings → Your profile.',
    });
    return 'failed';
  }

  // Audit attribution uses the reminder creator. No conversation is
  // opened: a self-reminder is delivered directly, never threaded
  // into a customer conversation.
  if (!row.created_by) {
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: 'Reminder has no creator for audit attribution.',
    });
    return 'failed';
  }

  // Stale-snapshot refresh (scheduled rows only — history is never
  // rewritten): when the creator changed their Reminder WhatsApp
  // Number after scheduling, the stored snapshot points at the old
  // handset. Re-point this row to the CURRENT configured number
  // before sending and log it. The Customer field is never
  // consulted — destination is always the creator's own number.
  const refreshed = await refreshStaleRecipient(db, row, current);
  if (refreshed !== null) {
    current.recipient_phone = refreshed;
  }

  // Routing decision, hoisted for the failure log: which mode
  // was attempted and what the window said when it was attempted.
  let windowOpen = false;
  let sendMode: "text" | "template" = "text";

  try {
    // Window routing per attempt — decided here, never probed by
    // sending: open window → free text (cheapest, exact message);
    // closed window → the account's APPROVED fallback template with
    // the reminder as {{1}}. A closed window NEVER attempts text
    // first (Meta would reject it); template misconfiguration fails
    // loudly with the reason stored.
    windowOpen = await isReminderWindowOpen(
      db,
      current.account_id,
      current.recipient_phone,
      now,
    );
    sendMode = windowOpen ? "text" : "template";
    const result = windowOpen
      ? await sendReminderToAgent(db, current.account_id, {
          to: current.recipient_phone,
          text: current.message_text,
        })
      : await sendReminderViaTemplate(db, current.account_id, {
          to: current.recipient_phone,
          text: current.message_text,
        });
    await markFollowup(db, row.id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      whatsapp_message_id: result.whatsappMessageId,
      failure_reason: null,
    });
    // Inbox persistence (best-effort, never throws): thread the
    // sent reminder onto the RECIPIENT's own conversation so it
    // appears in the Inbox. The wamid dedupes retries; a failure
    // here must not flip the reminder back to failed.
    await persistReminderOutboundMessage(db, {
      accountId: current.account_id,
      recipientPhone: current.recipient_phone,
      auditUserId: row.created_by as string,
      contentText: current.message_text,
      whatsappMessageId: result.whatsappMessageId,
      templateName:
        result.via === 'template' ? (result.templateName ?? null) : null,
    });
    // Delivery diagnostics only (never tokens, never full numbers):
    // one line per accepted send so a future non-delivery is
    // traceable from logs alone — Meta acceptance, addressing, the
    // wamid that later status webhooks correlate on, and which path
    // delivered it.
    console.log('[followups] reminder sent', {
      reminder_id: row.id,
      to: maskPhoneForLog(current.recipient_phone),
      window_open: windowOpen,
      send_mode: sendMode,
      phone_number_id: result.phoneNumberId,
      whatsapp_message_id: result.whatsappMessageId,
      via: result.via ?? 'text',
      ...(result.templateName ? { template_name: result.templateName } : {}),
      ...(result.templateLanguage
        ? { template_language: result.templateLanguage }
        : {}),
      ...(result.recipientWaId ? { recipient_wa_id: result.recipientWaId } : {}),
    });
    return 'sent';
  } catch (err) {
    const reason =
      err instanceof SendMessageError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Send failed.';
    console.error('[followups] reminder send failed', {
      reminder_id: row.id,
      to: maskPhoneForLog(current.recipient_phone),
      window_open: windowOpen,
      send_mode: sendMode,
      error_code: err instanceof SendMessageError ? err.code : 'unknown',
      reason,
    });
    await markFollowup(db, row.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: reason,
    });
    return 'failed';
  }
}

/**
 * Mask a phone number for logs: first two + last two digits only
 * (`9174******19`). Secrets and full numbers must never hit logs.
 */
function maskPhoneForLog(phone: string | null): string {
  if (!phone) return '(none)';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${digits.slice(0, 2)}******${digits.slice(-2)}`;
}

/**
 * Drain due follow-ups. Safe under overlapping workers: each row is
 * claimed atomically and re-checked after the claim. Never throws —
 * per-row failures are counted, and unexpected errors resolve to
 * zeroed counts so cron responses stay stable.
 */
export async function drainDueFollowups(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<DrainResult> {
  const outcome: DrainResult = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  try {
    const staleCutoff = new Date(now.getTime() - FOLLOWUP_STALE_MS).toISOString();
    const { data: due, error } = await db
      .from('whatsapp_followups')
      .select('*')
      .or(
        `and(status.eq.scheduled,scheduled_for.lte.${now.toISOString()}),and(status.eq.processing,updated_at.lt.${staleCutoff})`,
      )
      .order('scheduled_for', { ascending: true })
      .limit(FOLLOWUP_BATCH_LIMIT);
    if (error) {
      console.error('[followups] due query failed:', error.message);
      return outcome;
    }
    for (const raw of (due ?? []) as Record<string, unknown>[]) {
      const row = toFollowup(raw);
      if (row.attempts >= FOLLOWUP_MAX_ATTEMPTS) {
        await markFollowup(db, row.id, {
          status: 'failed',
          failed_at: new Date().toISOString(),
          failure_reason: 'Gave up after repeated attempts.',
        });
        outcome.processed += 1;
        outcome.failed += 1;
        continue;
      }
      // Atomic claim: exactly one worker flips the row. The
      // predicate repeats the due filter so a row claimed moments
      // ago by a live worker (fresh 'processing') can never be
      // re-claimed — only scheduled rows and provably stale
      // processing rows flip.
      const { data: claimed, error: claimErr } = await db
        .from('whatsapp_followups')
        .update({
          status: 'processing',
          attempts: row.attempts + 1,
        })
        .eq('id', row.id)
        .or(
          `and(status.eq.scheduled),and(status.eq.processing,updated_at.lt.${staleCutoff})`,
        )
        .select()
        .maybeSingle();
      if (claimErr || !claimed) continue;
      outcome.processed += 1;
      try {
        const result = await processOne(db, toFollowup(claimed as Record<string, unknown>), now);
        outcome[result] += 1;
      } catch (err) {
        console.error('[followups] row processing failed:', err);
        await markFollowup(db, row.id, {
          status: 'failed',
          failed_at: new Date().toISOString(),
          failure_reason: 'Unexpected processing error.',
        });
        outcome.failed += 1;
      }
    }
    return outcome;
  } catch (err) {
    console.error('[followups] drain failed:', err);
    return outcome;
  }
}
