// ============================================================
// Meta Lead Ads → WhatsApp auto-send — durable outbox.
//
// Flow (all Meta-only, never Flow Tables):
//   * Configuration is per Workspace table: one
//     `meta_lead_whatsapp_configs` row per (account, Meta form id)
//     plus ordered `meta_lead_whatsapp_templates` items. Each
//     table sends only its own form's leads its own templates.
//   * Ingestion (`processSubmissionById` success) calls
//     `maybeEnqueueWhatsappAutoreplies` AFTER the Workspace write
//     succeeded. Enqueue is one idempotent INSERT per template
//     keyed UNIQUE(account, submission, template, language):
//     polling/webhook retries/concurrent workers collapse to one
//     row. Enqueue NEVER throws into lead processing. Leads whose
//     table has no configured templates are never enqueued.
//   * `drainWhatsappQueue` (cron + prompt post-response drain)
//     claims due rows, resolves each row's table config, and
//     sends via the WhatsApp Cloud API idempotently, recording
//     the provider message id + inbox message row. Rows for
//     paused tables are parked untouched (resume on unpause).
//   * Sends for one lead run sequentially in the configured
//     order: item N is scheduled at lead-time + N * delay, and
//     the drain never sends an item while an earlier item of the
//     same lead is still pending/sending/retryable.
//   * Failures use bounded exponential backoff and never roll
//     back the lead. Terminal problems (no phone, unapproved
//     template, params required) fail fast with an actionable
//     message and unblock later items.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { getOrCreateConversation } from "@/lib/conversations/get-or-create";
import { decrypt } from "@/lib/whatsapp/encryption";
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import {
  isValidE164,
  sanitizePhoneForMeta,
} from "@/lib/whatsapp/phone-utils";
import { isMessageTemplate } from "@/lib/whatsapp/template-row-guard";
import { extractVariableIndices } from "@/lib/whatsapp/template-validators";
import type { MessageTemplate } from "@/types";

import {
  scheduledForForPosition,
  whatsappRetryDelayMs,
  type ValidatedAutoSendTemplate,
} from "./config";

export const WHATSAPP_SWEEP_LIMIT = 20;
export const WHATSAPP_MAX_ATTEMPTS = 8;

const STALE_CLAIM_MS = 5 * 60_000;

export interface TableWhatsappConfig {
  account_id: string;
  form_id: string;
  paused: boolean;
  delay_seconds: number;
}

export interface TableWhatsappItem extends ValidatedAutoSendTemplate {
  id: string;
}

export interface QueueRow {
  id: string;
  account_id: string;
  submission_id: string;
  flow_run_id: string | null;
  form_id: string;
  template_name: string;
  template_language: string;
  position: number;
  status: string;
  attempts: number;
  max_attempts: number;
  scheduled_for: string;
  next_retry_at: string;
  provider_message_id: string | null;
}

interface SubmissionRow {
  id: string;
  account_id: string;
  meta_lead_id: string;
  flow_run_id: string | null;
  form_id: string | null;
  contact_id: string | null;
}

/** Error carrying a terminal verdict: retrying can never succeed. */
export class TerminalSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalSendError";
  }
}

export function isTerminalSendError(err: unknown): boolean {
  return err instanceof TerminalSendError;
}

/**
 * Which send-time values a template requires that auto-send cannot
 * supply (no per-lead mapping exists). Returns human-readable
 * reasons; empty = safely auto-sendable. Pure.
 */
export function templateSendBlockers(
  template: Pick<
    MessageTemplate,
    "header_type" | "header_content" | "body_text" | "buttons"
  >,
): string[] {
  const blockers: string[] = [];
  if (
    template.header_type === "text" &&
    extractVariableIndices(template.header_content ?? "").length > 0
  ) {
    blockers.push("text header contains a {{variable}}");
  }
  if (extractVariableIndices(template.body_text ?? "").length > 0) {
    blockers.push("body contains {{variables}}");
  }
  for (const btn of template.buttons ?? []) {
    if (
      btn.type === "URL" &&
      typeof btn.url === "string" &&
      extractVariableIndices(btn.url).length > 0
    ) {
      blockers.push(`button "${btn.text ?? "URL"}" contains a {{variable}}`);
    }
  }
  // Media headers without any stored media can never send.
  if (
    (template.header_type === "image" ||
      template.header_type === "video" ||
      template.header_type === "document") &&
    !(template as { header_media_url?: string | null }).header_media_url
  ) {
    blockers.push(`${template.header_type} header has no media file`);
  }
  return blockers;
}

/** This table's auto-send config + ordered items. Null = never configured. */
export async function loadTableWhatsappConfig(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<{ config: TableWhatsappConfig; items: TableWhatsappItem[] } | null> {
  const { data: cfg, error: cfgErr } = await db
    .from("meta_lead_whatsapp_configs")
    .select("account_id, form_id, paused, delay_seconds")
    .eq("account_id", accountId)
    .eq("form_id", formId)
    .maybeSingle();
  if (cfgErr) throw cfgErr;
  if (!cfg) return null;
  const config = cfg as TableWhatsappConfig;

  const { data: rows, error: rowsErr } = await db
    .from("meta_lead_whatsapp_templates")
    .select("id, template_name, template_language, position")
    .eq("account_id", accountId)
    .eq("form_id", formId)
    .order("position", { ascending: true });
  if (rowsErr) throw rowsErr;
  const items = ((rows ?? []) as Array<{
    id: string;
    template_name: string;
    template_language: string;
    position: number;
  }>).map((r) => ({
    id: r.id,
    template_name: r.template_name,
    template_language: r.template_language,
    position: r.position,
  }));
  return { config, items };
}

async function loadSubmission(
  db: SupabaseClient,
  accountId: string,
  submissionId: string,
): Promise<SubmissionRow | null> {
  const { data, error } = await db
    .from("meta_lead_submissions")
    .select("id, account_id, meta_lead_id, flow_run_id, form_id, contact_id")
    .eq("id", submissionId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as SubmissionRow | null) ?? null;
}

export interface EnqueueResult {
  enqueued: number;
  alreadyQueued: number;
  skipped: boolean;
}

/**
 * Idempotent enqueue after a lead was created. One row per
 * configured template, scheduled `position * delay` apart. Never
 * throws. Skips when the lead has no Workspace run/form yet, or
 * when this table has no configured templates.
 *
 * Pause does NOT skip enqueue: rows are created pending and the
 * drain parks them while paused, so resuming continues the saved
 * sequence without losing leads that arrived mid-pause.
 */
export async function maybeEnqueueWhatsappAutoreplies(
  db: SupabaseClient,
  args: { accountId: string; submissionId: string },
): Promise<EnqueueResult> {
  const empty: EnqueueResult = { enqueued: 0, alreadyQueued: 0, skipped: true };
  try {
    const submission = await loadSubmission(db, args.accountId, args.submissionId);
    if (!submission) return empty;
    // Only leads that actually became Workspace rows; failed /
    // ignored submissions will enqueue when (if) they process.
    if (!submission.flow_run_id || !submission.form_id) return empty;

    const table = await loadTableWhatsappConfig(
      db,
      args.accountId,
      submission.form_id,
    );
    if (!table || table.items.length === 0) return empty;

    const nowIso = new Date().toISOString();
    let enqueued = 0;
    let alreadyQueued = 0;
    for (const item of table.items) {
      const { error } = await db.from("meta_lead_whatsapp_queue").insert({
        account_id: args.accountId,
        submission_id: submission.id,
        flow_run_id: submission.flow_run_id,
        form_id: submission.form_id,
        template_name: item.template_name,
        template_language: item.template_language,
        position: item.position,
        scheduled_for: scheduledForForPosition(
          nowIso,
          item.position,
          table.config.delay_seconds,
        ),
      });
      if (error) {
        if (isUniqueViolation(error)) {
          alreadyQueued += 1;
          continue;
        }
        throw error;
      }
      enqueued += 1;
    }
    return { enqueued, alreadyQueued, skipped: false };
  } catch (err) {
    console.error(
      "[meta-whatsapp] enqueue failed (lead processing unaffected):",
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}

export interface SendFnArgs {
  accountId: string;
  contactId: string;
  auditUserId: string;
  templateName: string;
  templateLanguage: string;
}

export interface SendFnResult {
  providerMessageId: string;
  conversationId: string;
  inboxMessageId: string;
}

/** Injectable transport so drains are unit-testable without Meta. */
export type WhatsappSendFn = (
  db: SupabaseClient,
  args: SendFnArgs,
) => Promise<SendFnResult>;

/**
 * Real transport: approved-template check + WhatsApp Cloud API send
 * + Inbox persistence. Throws TerminalSendError for problems that
 * can never self-heal, plain Errors for transient failures.
 */
export async function sendTemplateToLeadContact(
  db: SupabaseClient,
  args: SendFnArgs,
): Promise<SendFnResult> {
  const { data: contact, error: contactErr } = await db
    .from("contacts")
    .select("id, phone")
    .eq("id", args.contactId)
    .eq("account_id", args.accountId)
    .maybeSingle();
  if (contactErr) throw contactErr;
  const phone = (contact as { phone?: unknown } | null)?.phone;
  if (typeof phone !== "string" || phone.trim() === "") {
    throw new TerminalSendError("Lead has no phone number; nothing to send to.");
  }
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new TerminalSendError(
      "Lead phone number is not a valid international number.",
    );
  }

  const { data: config, error: configErr } = await db
    .from("whatsapp_config")
    .select("*")
    .eq("account_id", args.accountId)
    .maybeSingle();
  if (configErr) throw configErr;
  if (!config) {
    throw new Error(
      "WhatsApp is not configured for this account yet; will retry.",
    );
  }
  const cfg = config as {
    access_token: string;
    phone_number_id: string;
  };
  const accessToken = decrypt(cfg.access_token);

  const { data: templateRow } = await db
    .from("message_templates")
    .select("*")
    .eq("account_id", args.accountId)
    .eq("name", args.templateName)
    .eq("language", args.templateLanguage)
    .maybeSingle();
  if (!templateRow || !isMessageTemplate(templateRow)) {
    throw new TerminalSendError(
      `Template "${args.templateName}" (${args.templateLanguage}) no longer exists; remove it from this table's auto-send list.`,
    );
  }
  const template = templateRow as unknown as MessageTemplate;
  if (template.status !== "APPROVED") {
    throw new TerminalSendError(
      `Template "${args.templateName}" (${args.templateLanguage}) is ${template.status ?? "not approved"}; only APPROVED templates can be auto-sent.`,
    );
  }
  const blockers = templateSendBlockers(template);
  if (blockers.length > 0) {
    throw new TerminalSendError(
      `Template "${args.templateName}" needs values auto-send cannot provide: ${blockers.join("; ")}.`,
    );
  }

  let providerMessageId: string;
  try {
    const result = await sendTemplateMessage({
      phoneNumberId: cfg.phone_number_id,
      accessToken,
      to: sanitized,
      templateName: args.templateName,
      language: args.templateLanguage,
      template,
      params: [],
    });
    providerMessageId = result.messageId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Meta rejections for the content itself (e.g. parameter /
    // policy errors) can never self-heal; quota/rate/network
    // problems stay retryable.
    if (/(\b13[01]\d{3}\b|parameter|policy|rejected|not.*approved)/i.test(message)) {
      throw new TerminalSendError(`Meta rejected the send: ${message}`);
    }
    throw err instanceof Error ? err : new Error(message);
  }

  const resolved = await getOrCreateConversation(
    db,
    args.accountId,
    args.contactId,
    args.auditUserId,
  );
  if (!resolved) {
    throw new Error("Message sent but the Inbox thread could not be resolved.");
  }
  const conversationId = resolved.conversation.id as string;

  // Idempotency: a retried row carrying the same provider message
  // id must not duplicate the Inbox row.
  const { data: existing } = await db
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("message_id", providerMessageId)
    .maybeSingle();
  if (existing) {
    return {
      providerMessageId,
      conversationId,
      inboxMessageId: (existing as { id: string }).id,
    };
  }

  const { data: inserted, error: insertErr } = await db
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_type: "agent",
      content_type: "template",
      content_text: template.body_text || `[${args.templateName}]`,
      template_name: args.templateName,
      message_id: providerMessageId,
      status: "sent",
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    throw new Error(
      `Message sent to Meta but failed to save to the Inbox: ${insertErr?.message ?? "unknown"}`,
    );
  }
  const inboxMessageId = (inserted as { id: string }).id;

  await db
    .from("conversations")
    .update({
      last_message_text: template.body_text || `[${args.templateName}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  return { providerMessageId, conversationId, inboxMessageId };
}

async function markRowTerminal(
  db: SupabaseClient,
  row: QueueRow,
  message: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await db
    .from("meta_lead_whatsapp_queue")
    .update({
      status: "failed",
      attempts: row.max_attempts,
      last_error: message.slice(0, 500),
      // Far-future retry keeps the row visible without hammering.
      next_retry_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      claimed_at: null,
      updated_at: nowIso,
    })
    .eq("id", row.id);
}

async function markRowFailed(
  db: SupabaseClient,
  row: QueueRow,
  message: string,
): Promise<void> {
  const attempt = row.attempts + 1;
  const terminal = attempt >= row.max_attempts;
  await db
    .from("meta_lead_whatsapp_queue")
    .update({
      status: "failed",
      attempts: attempt,
      last_error: message.slice(0, 500),
      next_retry_at: terminal
        ? new Date(Date.now() + 24 * 60 * 60_000).toISOString()
        : new Date(Date.now() + whatsappRetryDelayMs(attempt)).toISOString(),
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
}

/**
 * True when an earlier item of the same lead still owns the turn:
 * pending, claimed, or retryably failed. Terminal rows
 * (attempts exhausted) unblock later items so one dead template
 * never stalls the rest of the sequence.
 */
async function hasBlockingEarlierRow(
  db: SupabaseClient,
  row: QueueRow,
): Promise<boolean> {
  const { data, error } = await db
    .from("meta_lead_whatsapp_queue")
    .select("id, status, attempts, max_attempts")
    .eq("account_id", row.account_id)
    .eq("submission_id", row.submission_id)
    .lt("position", row.position)
    .neq("status", "sent");
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    status: string;
    attempts: number;
    max_attempts: number;
  }>;
  return rows.some((r) => {
    if (r.status === "sent") return false;
    if (r.status === "pending" || r.status === "sending") return true;
    // failed: retryable rows block; exhausted rows don't.
    return r.attempts < r.max_attempts;
  });
}

export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
  skippedPaused: number;
  skippedNoConfig: number;
  skippedNoPhone: number;
  skippedOutOfOrder: number;
}

/**
 * Drain due auto-send rows. Never throws for per-row failures;
 * each outcome is recorded on its row. Idempotent: claiming is
 * atomic, the UNIQUE key prevents double-enqueue, and the Inbox
 * write is keyed on the provider message id.
 */
export async function drainWhatsappQueue(
  db: SupabaseClient,
  opts: {
    limit?: number;
    onlyAccountId?: string;
    onlyFormId?: string;
    sendImpl?: WhatsappSendFn;
  } = {},
): Promise<DrainResult> {
  const sendImpl = opts.sendImpl ?? sendTemplateToLeadContact;
  const limit = Math.max(1, Math.min(opts.limit ?? WHATSAPP_SWEEP_LIMIT, 100));
  const result: DrainResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedPaused: 0,
    skippedNoConfig: 0,
    skippedNoPhone: 0,
    skippedOutOfOrder: 0,
  };
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  // Reclaim stale `sending` rows from crashed workers.
  await db
    .from("meta_lead_whatsapp_queue")
    .update({ status: "pending", claimed_at: null, updated_at: nowIso })
    .eq("status", "sending")
    .lte("updated_at", staleIso);

  let query = db
    .from("meta_lead_whatsapp_queue")
    .select(
      "id, account_id, submission_id, flow_run_id, form_id, template_name, template_language, position, status, attempts, max_attempts, scheduled_for, next_retry_at, provider_message_id",
    )
    .in("status", ["pending", "failed"])
    .lte("scheduled_for", nowIso)
    .lte("next_retry_at", nowIso)
    .order("scheduled_for", { ascending: true })
    .order("position", { ascending: true })
    .limit(limit);
  if (opts.onlyAccountId) query = query.eq("account_id", opts.onlyAccountId);
  const { data: due, error } = await query;
  if (error) {
    console.error("[meta-whatsapp] due-jobs scan failed:", error.message);
    return result;
  }
  const rows = (due ?? []) as QueueRow[];

  for (const row of rows) {
    result.attempted += 1;
    // Atomic claim.
    const { data: claimed } = await db
      .from("meta_lead_whatsapp_queue")
      .update({ status: "sending", claimed_at: nowIso, updated_at: nowIso })
      .eq("id", row.id)
      .in("status", ["pending", "failed"])
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      if (opts.onlyFormId && row.form_id !== opts.onlyFormId) {
        await db
          .from("meta_lead_whatsapp_queue")
          .update({ status: "pending", claimed_at: null, updated_at: nowIso })
          .eq("id", row.id);
        continue;
      }

      // Sequential order: an earlier item still in flight owns the turn.
      if (await hasBlockingEarlierRow(db, row)) {
        await db
          .from("meta_lead_whatsapp_queue")
          .update({ status: "pending", claimed_at: null, updated_at: nowIso })
          .eq("id", row.id);
        result.skippedOutOfOrder += 1;
        continue;
      }

      const submission = await loadSubmission(db, row.account_id, row.submission_id);
      if (!submission) {
        // Submission gone — drop the queue row (nothing to send to).
        await db.from("meta_lead_whatsapp_queue").delete().eq("id", row.id);
        continue;
      }
      if (!submission.contact_id) {
        await markRowTerminal(
          db,
          row,
          "Lead has no phone number (no contact was linked); nothing to send to.",
        );
        result.skippedNoPhone += 1;
        result.failed += 1;
        continue;
      }

      const table = await loadTableWhatsappConfig(
        db,
        row.account_id,
        row.form_id,
      );
      if (!table || table.items.length === 0) {
        // Config removed after enqueue: park the row untouched so a
        // reconfigure resumes it (mirrors the Sheets no-config path).
        await db
          .from("meta_lead_whatsapp_queue")
          .update({ status: "pending", claimed_at: null, updated_at: nowIso })
          .eq("id", row.id);
        result.skippedNoConfig += 1;
        continue;
      }
      if (table.config.paused) {
        // Paused: release the claim untouched. History, order, and
        // delay survive; unpausing resumes the same sequence.
        await db
          .from("meta_lead_whatsapp_queue")
          .update({ status: "pending", claimed_at: null, updated_at: nowIso })
          .eq("id", row.id);
        result.skippedPaused += 1;
        continue;
      }
      // The template may have been removed from the table after
      // enqueue — park rather than fail so re-adding resumes it.
      const stillConfigured = table.items.some(
        (t) =>
          t.template_name === row.template_name &&
          t.template_language === row.template_language,
      );
      if (!stillConfigured) {
        await db
          .from("meta_lead_whatsapp_queue")
          .update({ status: "pending", claimed_at: null, updated_at: nowIso })
          .eq("id", row.id);
        result.skippedNoConfig += 1;
        continue;
      }

      // Audit user for the conversation thread: prefer the flow
      // run's owner, else any account member (id is audit-only).
      const auditUserId = await resolveAuditUser(db, row);
      const sent = await sendImpl(db, {
        accountId: row.account_id,
        contactId: submission.contact_id,
        auditUserId,
        templateName: row.template_name,
        templateLanguage: row.template_language,
      });

      await db
        .from("meta_lead_whatsapp_queue")
        .update({
          status: "sent",
          last_error: null,
          next_retry_at: nowIso,
          claimed_at: null,
          provider_message_id: sent.providerMessageId,
          conversation_id: sent.conversationId,
          inbox_message_id: sent.inboxMessageId,
          sent_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", row.id);
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isTerminalSendError(err)) {
        await markRowTerminal(db, row, message);
      } else {
        await markRowFailed(db, row, message);
      }
      result.failed += 1;
    }
  }
  return result;
}

async function resolveAuditUser(
  db: SupabaseClient,
  row: QueueRow,
): Promise<string> {
  // Prefer the flow run's owner (the account member who owns the
  // lead's Workspace row); fall back to any profile of the
  // account. The id is only used as the conversation audit column.
  if (row.flow_run_id) {
    const { data } = await db
      .from("flow_runs")
      .select("user_id")
      .eq("id", row.flow_run_id)
      .maybeSingle();
    const userId = (data as { user_id?: unknown } | null)?.user_id;
    if (typeof userId === "string" && userId !== "") return userId;
  }
  const { data } = await db
    .from("profiles")
    .select("user_id")
    .eq("account_id", row.account_id)
    .limit(1)
    .maybeSingle();
  const userId = (data as { user_id?: unknown } | null)?.user_id;
  if (typeof userId === "string" && userId !== "") return userId;
  return "";
}

/**
 * Retry terminal/failed rows for one table (manual "retry now").
 * Resets retryable failures to pending when their backoff elapsed
 * and re-schedules them immediately; exhausted rows are revived
 * for one more sequence (attempts reset) so an admin fix (approve
 * the template, connect WhatsApp) can actually deliver.
 */
export async function retryTableWhatsappQueue(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<{ revived: number }> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("meta_lead_whatsapp_queue")
    .update({
      status: "pending",
      attempts: 0,
      last_error: null,
      next_retry_at: nowIso,
      scheduled_for: nowIso,
      claimed_at: null,
      updated_at: nowIso,
    })
    .eq("account_id", accountId)
    .eq("form_id", formId)
    .eq("status", "failed")
    .select("id");
  if (error) throw error;
  return { revived: ((data ?? []) as unknown[]).length };
}

export interface TableWhatsappStatus {
  configured: boolean;
  paused: boolean;
  delay_seconds: number;
  items: Array<{
    template_name: string;
    template_language: string;
    position: number;
  }>;
  counts: {
    pending: number;
    sending: number;
    sent: number;
    failed: number;
  };
}

/** Per-table status for the settings UI (config + send history counts). */
export async function getTableWhatsappStatus(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<TableWhatsappStatus> {
  const table = await loadTableWhatsappConfig(db, accountId, formId);
  const { data: counts } = await db
    .from("meta_lead_whatsapp_queue")
    .select("status")
    .eq("account_id", accountId)
    .eq("form_id", formId);
  const tally = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const r of ((counts ?? []) as Array<{ status: string }>)) {
    if (r.status in tally) tally[r.status as keyof typeof tally] += 1;
  }
  if (!table) {
    return {
      configured: false,
      paused: false,
      delay_seconds: 0,
      items: [],
      counts: tally,
    };
  }
  return {
    configured: table.items.length > 0,
    paused: table.config.paused,
    delay_seconds: table.config.delay_seconds,
    items: table.items.map((t) => ({
      template_name: t.template_name,
      template_language: t.template_language,
      position: t.position,
    })),
    counts: tally,
  };
}
