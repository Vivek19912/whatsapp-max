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
//     same lead is still in flight.
//   * Template variables resolve against the lead's OWN Workspace
//     row on every attempt (including retries) using the table's
//     stored per-template mappings. Missing/empty values fail the
//     row (retryable, with the field named) so a corrected row or
//     mapping heals the send; placeholders are never transmitted.
//   * Failures use bounded exponential backoff and never roll
//     back the lead. Terminal problems (no phone, unapproved or
//     deleted template, unmappable media) fail fast with an
//     actionable message and unblock later items.
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
import type { MessageTemplate } from "@/types";

import {
  scheduledForForPosition,
  whatsappRetryDelayMs,
  type ValidatedAutoSendTemplate,
} from "./config";
import { loadAssigneeSequence } from "./assignee-sequences";
import {
  buildAvailableVariableFields,
  buildVariableSendParams,
  getTemplateVariableSlots,
  renderVariablePreview,
  resolveLeadVariableFieldMap,
  resolveVariableValues,
  templateMediaBlockers,
  validateVariableMappings,
  type VariableFieldDef,
} from "./variables";
import type { SendTimeParams } from "@/lib/whatsapp/template-send-builder";

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
  /**
   * Salesperson-sequence discriminator (see
   * assignee-sequences.ts). NULL = table-wide sequence row
   * (existing behavior); set = per-salesperson row. Blocking,
   * ordering, and config resolution scope to the same key so the
   * two automations never stall each other.
   */
  assignee_key: string | null;
}

interface SubmissionRow {
  id: string;
  account_id: string;
  meta_lead_id: string;
  flow_run_id: string | null;
  form_id: string | null;
  form_name: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  source: string | null;
  meta_created_time: string | null;
  created_at: string;
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
 * Normalize a stored `variable_mappings` JSON value into a slot →
 * field record. Corrupt values degrade to {} (the drain then
 * reports the missing mapping on the row instead of crashing).
 * Pure.
 */
export function normalizeStoredMappings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [slotKey, fieldKey] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (typeof fieldKey === "string" && fieldKey.trim() !== "") {
      out[slotKey] = fieldKey.trim();
    }
  }
  return out;
}

/**
 * Structural problems mappings can never fix (media header with
 * no stored file). Template variables are NOT blockers — they
 * are satisfied by per-table mappings. Kept for the send path
 * and pre-existing callers; new code should prefer
 * `templateMediaBlockers` + `getTemplateVariableSlots`.
 */
export function templateSendBlockers(
  template: Pick<
    MessageTemplate,
    "header_type" | "header_content" | "body_text" | "buttons"
  >,
): string[] {
  return templateMediaBlockers(template);
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
    .select(
      "id, template_name, template_language, position, variable_mappings",
    )
    .eq("account_id", accountId)
    .eq("form_id", formId)
    .order("position", { ascending: true });
  if (rowsErr) throw rowsErr;
  const items = ((rows ?? []) as Array<{
    id: string;
    template_name: string;
    template_language: string;
    position: number;
    variable_mappings?: unknown;
  }>).map((r) => ({
    id: r.id,
    template_name: r.template_name,
    template_language: r.template_language,
    position: r.position,
    variable_mappings: normalizeStoredMappings(r.variable_mappings),
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
    .select(
      "id, account_id, meta_lead_id, flow_run_id, form_id, form_name, campaign_name, ad_name, source, meta_created_time, created_at, contact_id",
    )
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
 *
 * Callers that assign the lead in the same flow (ingestion) must
 * skip this when the lead was assigned: the assignee's own sequence
 * (maybeEnqueueAssigneeSequence) is then the exclusive
 * customer-facing sequence — see process-lead.ts.
 */
export async function maybeEnqueueWhatsappAutoreplies(
  db: SupabaseClient,
  args: { accountId: string; submissionId: string },
): Promise<EnqueueResult> {
  const empty: EnqueueResult = { enqueued: 0, alreadyQueued: 0, skipped: true };
  try {
    const submission = await loadSubmission(db, args.accountId, args.submissionId);
    if (!submission) return empty;
    // Only leads that actually became Workspace runs; failed /
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
        scheduled_for: scheduledForForPosition(nowIso, item.position, table.config.delay_seconds),
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

/**
 * Enqueue one salesperson's customer-facing sequence for a single
 * lead — only callers that already proved a genuine initial
 * assignment may call this (reassignment must never reach here).
 * Rows carry the salesperson key so the drain resolves that
 * salesperson's items (never the table-wide sequence). Never
 * throws: failures return { skipped } and leave assignment +
 * notifications untouched.
 */
export async function maybeEnqueueAssigneeSequence(
  db: SupabaseClient,
  args: {
    accountId: string;
    formId: string | null;
    submissionId?: string | null;
    flowRunId?: string | null;
    assigneeKey: string;
  },
): Promise<EnqueueResult & { skipReason?: string }> {
  const empty: EnqueueResult & { skipReason?: string } = {
    enqueued: 0,
    alreadyQueued: 0,
    skipped: true,
  };
  try {
    if (!args.formId || !args.assigneeKey) return { ...empty, skipReason: "no-sequence" };
    let submissionId = args.submissionId ?? null;
    if (!submissionId && args.flowRunId) {
      const { data, error } = await db
        .from("meta_lead_submissions")
        .select("id")
        .eq("account_id", args.accountId)
        .eq("flow_run_id", args.flowRunId)
        .maybeSingle();
      if (error) throw error;
      submissionId = ((data as { id: string } | null)?.id ?? null) as string | null;
    }
    if (!submissionId) return { ...empty, skipReason: "no-submission" };
    const submission = await loadSubmission(db, args.accountId, submissionId);
    if (!submission || !submission.flow_run_id || !submission.form_id) {
      return { ...empty, skipReason: "no-submission" };
    }
    const sequence = await loadAssigneeSequence(
      db,
      args.accountId,
      submission.form_id,
      args.assigneeKey,
    );
    if (!sequence || sequence.items.length === 0) {
      return { ...empty, skipReason: "no-sequence" };
    }
    const nowIso = new Date().toISOString();
    let enqueued = 0;
    let alreadyQueued = 0;
    for (const item of sequence.items) {
      const { error } = await db.from("meta_lead_whatsapp_queue").insert({
        account_id: args.accountId,
        submission_id: submission.id,
        flow_run_id: submission.flow_run_id,
        form_id: submission.form_id,
        template_name: item.template_name,
        template_language: item.template_language,
        position: item.position,
        assignee_key: args.assigneeKey,
        scheduled_for: scheduledForForPosition(nowIso, item.position, sequence.delay_seconds),
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
      "[meta-whatsapp] assignee enqueue failed (assignment unaffected):",
      err instanceof Error ? err.message : err,
    );
    return { ...empty, skipReason: "error" };
  }
}

export type ManualHandoffReason =
  | "no-submission"
  | "no-global-rows"
  | "global-pending-cancelled"
  | "global-already-sent"
  | "global-in-flight"
  | "global-send-raced";

export interface ManualHandoffResult {
  submissionId: string | null;
  decision: "start-assignee" | "keep-global";
  reason: ManualHandoffReason;
  /** Pending/failed global rows deleted to clear the way. */
  cancelled: number;
  /** Global rows already sent (evidence for keep-global). */
  sent: number;
}

interface GlobalRowState {
  id: string;
  status: string;
}

/** This lead's table-wide (NULL-keyed) auto-send rows, any status. */
async function fetchGlobalRows(
  db: SupabaseClient,
  accountId: string,
  submissionId: string,
): Promise<GlobalRowState[]> {
  const { data, error } = await db
    .from("meta_lead_whatsapp_queue")
    .select("id, status")
    .eq("account_id", accountId)
    .eq("submission_id", submissionId)
    .is("assignee_key", null);
  if (error) throw error;
  return ((data ?? []) as GlobalRowState[]).slice();
}

/**
 * Delete this lead's unsent global rows. Conditional on
 * status IN (pending, failed) — mirroring the drain's atomic claim —
 * so a worker that claimed a row concurrently (pending → sending)
 * spares it from deletion. Sent rows are never matched. Returns the
 * deleted count.
 */
async function deletePendingGlobalRows(
  db: SupabaseClient,
  accountId: string,
  submissionId: string,
): Promise<number> {
  const { data, error } = await db
    .from("meta_lead_whatsapp_queue")
    .delete()
    .eq("account_id", accountId)
    .eq("submission_id", submissionId)
    .is("assignee_key", null)
    .in("status", ["pending", "failed"])
    .select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length;
}

export interface LateGlobalCancelResult {
  /** Pending/failed global rows deleted. */
  cancelled: number;
  /** Global rows already sent (left untouched). */
  sent: number;
  /** Global rows claimed/in-flight (left untouched). */
  sending: number;
}

/**
 * Reconcile late global arrivals for one lead: delete pending/failed
 * table-wide rows (e.g. committed by a concurrent ingestion worker
 * after a handoff scan), then report what remains. Sent and sending
 * rows are never touched — a started global send always wins over a
 * second sequence. Throws on database errors; callers decide whether
 * to fail open or closed.
 */
export async function cancelLateGlobalRows(
  db: SupabaseClient,
  args: { accountId: string; submissionId: string },
): Promise<LateGlobalCancelResult> {
  const cancelled = await deletePendingGlobalRows(db, args.accountId, args.submissionId);
  const after = await fetchGlobalRows(db, args.accountId, args.submissionId);
  return {
    cancelled,
    sent: after.filter((r) => r.status === "sent").length,
    sending: after.filter((r) => r.status === "sending").length,
  };
}

/**
 * Manual-assignment handoff for one Meta lead: decides whether the
 * new owner's salesperson sequence may start, given the global
 * auto-send rows that may already exist for the same lead.
 *
 * A lead can arrive unassigned (global rows queued or even sent)
 * and receive its first manual assignment later. Starting the
 * salesperson sequence on top would mix the two sequences — and the
 * UNIQUE(account, submission, template, language) ledger would
 * silently drop overlapping templates, leaving an incomplete mix.
 *
 *   * No submission, or no global rows: "start-assignee".
 *   * Only pending/failed global rows: they are DELETED (unsent —
 *     never message history) so the salesperson sequence enqueues
 *     completely, then "start-assignee".
 *   * Any sent global row, or a row claimed/in-flight (sending):
 *     "keep-global" — nothing is cancelled, nothing is enqueued.
 *
 * Race safety: the delete is conditional on
 * status IN (pending, failed), mirroring the drain's atomic claim —
 * a worker that claimed a row concurrently (pending → sending)
 * spares it from deletion. A re-select after the delete catches
 * that case (or a send that landed mid-handoff) and keeps the
 * global sequence instead of starting a second one. Sent rows are
 * never touched. Throws on database errors: callers must fail
 * closed (keep-global, no customer sequence) rather than risk a
 * mixed send.
 */
export async function prepareManualAssigneeHandoff(
  db: SupabaseClient,
  args: {
    accountId: string;
    submissionId?: string | null;
    flowRunId?: string | null;
  },
): Promise<ManualHandoffResult> {
  let submissionId = args.submissionId ?? null;
  if (!submissionId && args.flowRunId) {
    const { data, error } = await db
      .from("meta_lead_submissions")
      .select("id")
      .eq("account_id", args.accountId)
      .eq("flow_run_id", args.flowRunId)
      .maybeSingle();
    if (error) throw error;
    submissionId = ((data as { id: string } | null)?.id ?? null) as string | null;
  }
  if (!submissionId) {
    return { submissionId: null, decision: "start-assignee", reason: "no-submission", cancelled: 0, sent: 0 };
  }
  const scanGlobal = () => fetchGlobalRows(db, args.accountId, submissionId as string);
  const before = await scanGlobal();
  if (before.length === 0) {
    return { submissionId, decision: "start-assignee", reason: "no-global-rows", cancelled: 0, sent: 0 };
  }
  const sent = before.filter((r) => r.status === "sent").length;
  if (sent > 0) {
    return { submissionId, decision: "keep-global", reason: "global-already-sent", cancelled: 0, sent };
  }
  if (before.some((r) => r.status === "sending")) {
    return { submissionId, decision: "keep-global", reason: "global-in-flight", cancelled: 0, sent: 0 };
  }
  // Only pending/failed rows remain: delete them so the overlapping
  // unique keys are free for the salesperson sequence. Conditional
  // on status — a concurrent worker claim spares the claimed row.
  const cancelled = await deletePendingGlobalRows(db, args.accountId, submissionId as string);
  // A claim (or send) may have slipped between the scan and the
  // delete: the claimed row survived above and must win.
  const after = await scanGlobal();
  const afterSent = after.filter((r) => r.status === "sent").length;
  if (afterSent > 0 || after.some((r) => r.status === "sending")) {
    return { submissionId, decision: "keep-global", reason: "global-send-raced", cancelled, sent: afterSent };
  }
  return { submissionId, decision: "start-assignee", reason: "global-pending-cancelled", cancelled, sent: 0 };
}

export interface SendFnArgs {
  accountId: string;
  contactId: string;
  auditUserId: string;
  templateName: string;
  templateLanguage: string;
  /** Resolved Meta send-time params (body/header/button values). */
  params: SendTimeParams;
  /** Slot → resolved value (for rendering + audit). */
  variableValues: Record<string, string>;
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
  const mediaBlockers = templateMediaBlockers(template);
  if (mediaBlockers.length > 0) {
    throw new TerminalSendError(
      `Template "${args.templateName}" cannot be sent: ${mediaBlockers.join("; ")}.`,
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
      messageParams: args.params,
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

  // Rendered body for the Inbox: resolved values substituted,
  // so agents see exactly what the lead received.
  const renderedText =
    renderVariablePreview(template.body_text ?? "", args.variableValues) ||
    `[${args.templateName}]`;
  const { data: inserted, error: insertErr } = await db
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_type: "agent",
      content_type: "template",
      content_text: renderedText,
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
      last_message_text: renderedText,
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
 * True when an earlier item of the same lead *and the same
 * sequence* still owns the turn: pending, claimed, or retryably
 * failed. Terminal rows unblock later items so one dead template
 * never stalls the rest of the sequence. Rows are scoped by
 * `assignee_key` (NULL matches NULL) so a salesperson sequence
 * and the table-wide sequence never block each other.
 */
async function hasBlockingEarlierRow(
  db: SupabaseClient,
  row: QueueRow,
): Promise<boolean> {
  let query = db
    .from("meta_lead_whatsapp_queue")
    .select("id, status, attempts, max_attempts")
    .eq("account_id", row.account_id)
    .eq("submission_id", row.submission_id);
  // postgrest `.eq(col, null)` does not reliably match NULL, so
  // branch explicitly to keep global rows on the exact same rows
  // as before (only NULL-keyed rows) and assignee rows on theirs.
  query =
    row.assignee_key == null
      ? query.is("assignee_key", null)
      : query.eq("assignee_key", row.assignee_key);
  const { data, error } = await query
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

/**
 * Load one table's variable field catalog: standard fields plus
 * one `answer:<key>` per Instant Form question. Never throws —
 * falls back to the standard fields when the form row is
 * unreadable (validation then reports unknown dynamic fields).
 */
export async function loadTableVariableFields(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<{ fields: VariableFieldDef[]; keys: Set<string> }> {
  let questions: Array<{ key?: string | null; label?: string | null }> = [];
  try {
    const { data } = await db
      .from("meta_lead_forms")
      .select("questions")
      .eq("account_id", accountId)
      .eq("form_id", formId)
      .maybeSingle();
    const raw = (data as { questions?: unknown } | null)?.questions;
    if (Array.isArray(raw)) {
      questions = raw.map((entry) => {
        const e =
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>)
            : {};
        return {
          key: typeof e.key === "string" ? e.key : null,
          label: typeof e.label === "string" ? e.label : null,
        };
      });
    }
  } catch {
    // Fall through to standard fields only.
  }
  const fields = buildAvailableVariableFields(questions);
  return { fields, keys: new Set(fields.map((f) => f.key)) };
}

type PreparedVariables =
  | { ok: true; params: SendTimeParams; values: Record<string, string> }
  | { ok: false; terminal: boolean; message: string };

/**
 * Resolve one queue row's template variables: live template
 * structure → slot coverage by the table's stored mapping →
 * values from the lead's Workspace row → Meta send params.
 * Never throws; every outcome is an explicit verdict.
 */
async function prepareRowVariables(
  db: SupabaseClient,
  row: QueueRow,
  item: TableWhatsappItem,
  submission: SubmissionRow,
): Promise<PreparedVariables> {
  const label = `"${row.template_name}" (${row.template_language})`;

  const { data: templateRow } = await db
    .from("message_templates")
    .select("header_type, header_content, header_media_url, body_text, buttons, status")
    .eq("account_id", row.account_id)
    .eq("name", row.template_name)
    .eq("language", row.template_language)
    .maybeSingle();
  if (!templateRow) {
    return {
      ok: false,
      terminal: true,
      message: `Template ${label} no longer exists; remove it from this table's auto-send list.`,
    };
  }
  const template = templateRow as Pick<
    MessageTemplate,
    "header_type" | "header_content" | "body_text" | "buttons"
  > & { header_media_url?: string | null; status?: string };
  if (template.status !== "APPROVED") {
    return {
      ok: false,
      terminal: true,
      message: `Template ${label} is ${template.status ?? "not approved"}; only APPROVED templates can be auto-sent.`,
    };
  }
  const mediaBlockers = templateMediaBlockers(template);
  if (mediaBlockers.length > 0) {
    return {
      ok: false,
      terminal: true,
      message: `Template ${label} cannot be sent: ${mediaBlockers.join("; ")}.`,
    };
  }

  const slots = getTemplateVariableSlots(template);
  const { keys } = await loadTableVariableFields(
    db,
    row.account_id,
    row.form_id,
  );
  const mappingProblem = validateVariableMappings(
    slots,
    item.variable_mappings,
    keys,
  );
  if (mappingProblem) {
    return {
      ok: false,
      terminal: false,
      message: `Template ${label} is missing a variable mapping: ${mappingProblem} Update this table's auto-send settings, then retry.`,
    };
  }

  if (slots.length === 0) {
    return { ok: true, params: {}, values: {} };
  }

  const fieldMap = await resolveLeadVariableFieldMap(db, row.account_id, {
    id: submission.id,
    meta_lead_id: submission.meta_lead_id,
    flow_run_id: submission.flow_run_id,
    form_id: submission.form_id,
    form_name: submission.form_name,
    campaign_name: submission.campaign_name,
    ad_name: submission.ad_name,
    source: submission.source,
    meta_created_time: submission.meta_created_time,
    created_at: submission.created_at,
    contact_id: submission.contact_id,
  });
  if (!fieldMap) {
    return {
      ok: false,
      terminal: true,
      message: `Template ${label} needs Workspace values but the lead's Workspace row is gone; nothing to resolve variables from.`,
    };
  }

  const { values, missing } = resolveVariableValues(
    slots,
    item.variable_mappings,
    fieldMap,
  );
  if (missing.length > 0) {
    const first = missing[0];
    const slot = slots.find((s) => s.key === first.slotKey);
    const fieldLabel = first.fieldKey === "" ? "no field" : `"${first.fieldKey}"`;
    return {
      ok: false,
      terminal: false,
      message:
        `Template ${label} needs a value for {{${slot?.position ?? "?"}}} ` +
        `(field ${fieldLabel}) but this lead has none; fill the Workspace row or update the mapping, then retry. ` +
        `Nothing was sent and no placeholder was substituted.`,
    };
  }

  try {
    const params = buildVariableSendParams(template, slots, values);
    return { ok: true, params, values };
  } catch (err) {
    return {
      ok: false,
      terminal: false,
      message: `Template ${label} could not be prepared: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
      "id, account_id, submission_id, flow_run_id, form_id, template_name, template_language, position, status, attempts, max_attempts, scheduled_for, next_retry_at, provider_message_id, assignee_key",
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
      // Resolve the effective sequence: the salesperson's own items
      // when the row carries their key, else the table-wide items.
      // Salesperson rows must NOT require a global auto-send config:
      // customer sequences are configured inside Assignment, so a
      // table with only salesperson sequences has no
      // meta_lead_whatsapp_configs row. A missing global row means
      // "not paused", not "not configured". Global rows keep the
      // original strict requirement.
      // A removed or emptied salesperson sequence parks its rows
      // (same resume semantics as a removed global template).
      let items = table?.items ?? [];
      if (row.assignee_key != null) {
        const sequence = await loadAssigneeSequence(
          db,
          row.account_id,
          row.form_id,
          row.assignee_key,
        );
        if (!sequence || sequence.items.length === 0) {
          await db
            .from("meta_lead_whatsapp_queue")
            .update({ status: "pending", claimed_at: null, updated_at: nowIso })
            .eq("id", row.id);
          result.skippedNoConfig += 1;
          continue;
        }
        items = sequence.items.map((t) => ({
          ...t,
          id: `assignee:${row.assignee_key}:${t.position}`,
        }));
      } else {
        if (!table) {
          // No config row at all: park the row untouched so a later
          // configuration resumes it (mirrors the Sheets no-config
          // path). Global rows only — salesperson rows are handled
          // above without requiring this row.
          await db
            .from("meta_lead_whatsapp_queue")
            .update({ status: "pending", claimed_at: null, updated_at: nowIso })
            .eq("id", row.id);
          result.skippedNoConfig += 1;
          continue;
        }
        if (table.items.length === 0) {
          // No configured templates: park the row untouched so a
          // re-configuration resumes it (mirrors the Sheets
          // no-config path).
          await db
            .from("meta_lead_whatsapp_queue")
            .update({ status: "pending", claimed_at: null, updated_at: nowIso })
            .eq("id", row.id);
          result.skippedNoConfig += 1;
          continue;
        }
        items = table.items;
      }
      if (table?.config.paused) {
        // Paused: release the claim untouched. History, order, and
        // delay survive; unpausing resumes the same sequence. The
        // table-wide pause covers salesperson rows too.
        await db
          .from("meta_lead_whatsapp_queue")
          .update({ status: "pending", claimed_at: null, updated_at: nowIso })
          .eq("id", row.id);
        result.skippedPaused += 1;
        continue;
      }
      // The template may have been removed from the effective
      // sequence after enqueue — park rather than fail so
      // re-adding resumes it.
      const item = items.find(
        (t) =>
          t.template_name === row.template_name &&
          t.template_language === row.template_language,
      );
      if (!item) {
        await db
          .from("meta_lead_whatsapp_queue")
          .update({ status: "pending", claimed_at: null, updated_at: nowIso })
          .eq("id", row.id);
        result.skippedNoConfig += 1;
        continue;
      }

      // Resolve the template's live structure + this table's
      // available fields, then this lead's values. Every failure
      // below is retryable (data or mapping corrections heal it
      // via the normal backoff or the manual retry endpoint);
      // placeholders are never transmitted.
      const prepared = await prepareRowVariables(db, row, item, submission);
      if (!prepared.ok) {
        if (prepared.terminal) {
          await markRowTerminal(db, row, prepared.message);
        } else {
          await markRowFailed(db, row, prepared.message);
        }
        result.failed += 1;
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
        params: prepared.params,
        variableValues: prepared.values,
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
    variable_mappings: Record<string, string>;
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
      variable_mappings: { ...t.variable_mappings },
    })),
    counts: tally,
  };
}
