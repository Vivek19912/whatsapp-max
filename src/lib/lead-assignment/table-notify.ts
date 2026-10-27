// ============================================================
// Per-table assignment notifications — durable outbox for assignee
// alerts the legacy Meta-only queue cannot carry:
//
//   * external recipients (custom email/phone — no login, no
//     profiles row, never an owner);
//   * Flow-table leads (no meta_lead_submissions row, so the legacy
//     UNIQUE(account_id, submission_id) queue cannot hold them);
//   * WhatsApp alerts to assignee phones.
//
// Internal members on Meta tables keep the existing
// maybeEnqueueLeadNotification path untouched. Everything else
// lands here: one row per (lead, assignee, channel), so retries
// and duplicate deliveries collapse to a single alert.
//
// Email reuses the account's Meta notification templates + SMTP
// (same look as the legacy alerts). WhatsApp reuses the account's
// whatsapp_config sender + an admin-chosen APPROVED template.
// Assignment never throws because of notifications.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getMetaSmtpStatus } from "@/lib/meta-lead-ads/notify";
import { sendEmailViaSmtp } from "@/lib/email/send";
import {
  isValidE164,
  sanitizePhoneForMeta,
} from "@/lib/whatsapp/phone-utils";
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import { extractVariableIndices } from "@/lib/whatsapp/template-validators";
import type { MessageTemplate, TemplateButton } from "@/types";
import type { TableAssigneeRow, TableConfigDetail } from "./table-config";
import { isValidAssigneeEmail } from "./table-validation";

export const TABLE_NOTIFY_MAX_ATTEMPTS = 5;
export const TABLE_NOTIFY_SWEEP_LIMIT = 20;

function notifyRetryDelayMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
}

export interface EnqueueTableNotificationsResult {
  email: { enqueued: boolean; reason: string };
  whatsapp: { enqueued: boolean; reason: string };
}

/**
 * Enqueue assignee alerts for one assignment. Idempotent per
 * (lead, assignee, channel). Never throws.
 */
export async function enqueueTableAssignmentNotifications(
  db: SupabaseClient,
  args: {
    accountId: string;
    detail: TableConfigDetail;
    assignee: TableAssigneeRow;
    runId: string;
    formId: string | null;
    /**
     * Skip the email channel here because the caller already used
     * the legacy Meta queue for it (internal members on Meta
     * tables). Prevents double emails from two outboxes.
     */
    skipEmail?: boolean;
  },
): Promise<EnqueueTableNotificationsResult> {
  const out: EnqueueTableNotificationsResult = {
    email: { enqueued: false, reason: "skipped" },
    whatsapp: { enqueued: false, reason: "skipped" },
  };
  try {
    const { accountId, detail, assignee, runId, formId } = args;
    const channels: Array<"email" | "whatsapp"> = [];
    if (assignee.notify_email && !args.skipEmail) channels.push("email");
    if (assignee.notify_whatsapp) channels.push("whatsapp");
    if (channels.length === 0) return out;

    const ctx = await loadLeadContext(db, accountId, runId, formId);
    for (const channel of channels) {
      try {
        const row = buildNotificationRow(detail, assignee, runId, ctx, channel);
        if (!row) {
          out[channel] = { enqueued: false, reason: "no-recipient" };
          continue;
        }
        const { error } = await db
          .from("lead_assignment_notifications")
          .insert(row);
        if (error) {
          if (isUniqueViolation(error)) {
            out[channel] = { enqueued: false, reason: "duplicate" };
            continue;
          }
          throw error;
        }
        out[channel] = { enqueued: true, reason: "enqueued" };
      } catch (err) {
        console.error(
          "[table-assign-notify] enqueue failed (assignment unaffected):",
          err instanceof Error ? err.message : err,
        );
        out[channel] = { enqueued: false, reason: "error" };
      }
    }
    return out;
  } catch (err) {
    console.error(
      "[table-assign-notify] enqueue failed (assignment unaffected):",
      err instanceof Error ? err.message : err,
    );
    return out;
  }
}

interface LeadContext {
  leadName: string | null;
  leadPhone: string | null;
  leadEmail: string | null;
  formName: string | null;
  tableName: string | null;
  receivedAt: string | null;
}

/** Best-effort lead snapshot for the alert body (Meta + Flow). */
async function loadLeadContext(
  db: SupabaseClient,
  accountId: string,
  runId: string,
  formId: string | null,
): Promise<LeadContext> {
  const ctx: LeadContext = {
    leadName: null,
    leadPhone: null,
    leadEmail: null,
    formName: null,
    tableName: null,
    receivedAt: null,
  };
  try {
    const { data: run } = await db
      .from("flow_runs")
      .select("started_at, contact_id")
      .eq("id", runId)
      .eq("account_id", accountId)
      .maybeSingle();
    const runRow = run as {
      started_at?: string | null;
      contact_id?: string | null;
    } | null;
    ctx.receivedAt = runRow?.started_at ?? null;
    if (runRow?.contact_id) {
      const { data: contact } = await db
        .from("contacts")
        .select("name, phone, email")
        .eq("id", runRow.contact_id)
        .eq("account_id", accountId)
        .maybeSingle();
      const c = contact as {
        name?: string | null;
        phone?: string | null;
        email?: string | null;
      } | null;
      ctx.leadName = c?.name ?? null;
      ctx.leadPhone = c?.phone ?? null;
      ctx.leadEmail = c?.email ?? null;
    }
    if (formId) {
      const { data: form } = await db
        .from("meta_lead_forms")
        .select("form_name")
        .eq("id", formId)
        .eq("account_id", accountId)
        .maybeSingle();
      ctx.formName = (form as { form_name?: string | null } | null)?.form_name ?? null;
    }
    const { data: flow } = await db
      .from("flows")
      .select("name")
      .eq("account_id", accountId)
      .limit(1);
    void flow;
  } catch {
    // Snapshot is best-effort; the alert still sends with ids.
  }
  return ctx;
}

function buildNotificationRow(
  detail: TableConfigDetail,
  assignee: TableAssigneeRow,
  runId: string,
  ctx: LeadContext,
  channel: "email" | "whatsapp",
): Record<string, unknown> | null {
  const nowIso = new Date().toISOString();
  const base = {
    account_id: detail.account_id,
    config_id: detail.id,
    assignee_id: assignee.id,
    flow_id: detail.flow_id,
    flow_run_id: runId,
    form_id: detail.form_db_id,
    channel,
    lead_name: ctx.leadName,
    lead_phone: ctx.leadPhone,
    max_attempts: TABLE_NOTIFY_MAX_ATTEMPTS,
    queued_at: nowIso,
    next_attempt_at: nowIso,
  };
  if (channel === "email") {
    // Internal members: resolve from the roster at send time; the
    // enqueue-time snapshot is the fallback. External recipients
    // use their configured address directly.
    const toEmail = assignee.email?.trim() || null;
    if (!assignee.user_id && !toEmail) return null;
    return {
      ...base,
      to_email: toEmail,
      subject: `New lead assigned: ${ctx.leadName ?? ctx.leadPhone ?? "a new lead"}`,
      body:
        `Hi ${assignee.display_name},\n\n` +
        `A new lead was assigned to you.\n` +
        `Name: ${ctx.leadName ?? "—"}\n` +
        `Phone: ${ctx.leadPhone ?? "—"}\n` +
        (ctx.formName ? `Table: ${ctx.formName}\n` : "") +
        `Received: ${ctx.receivedAt ?? "—"}\n`,
    };
  }
  // WhatsApp rows enqueue on the phone number alone: a missing
  // template, sender, or approval fails LOUDLY at send time (visible
  // in the deliveries panel) instead of silently never existing.
  if (!assignee.phone) return null;
  return {
    ...base,
    to_phone: assignee.phone,
    template_name: detail.whatsapp_template_name,
    template_language: detail.whatsapp_template_language,
  };
}

export interface TableNotifyDrainResult {
  sent: number;
  failed: number;
  skippedNoConfig: number;
}

/**
 * Send due assignee alerts (email via SMTP, WhatsApp via the
 * account sender + approved template). Never throws for per-row
 * failures. Called by the existing meta-lead-ads cron sweep —
 * same cadence, no new scheduler.
 */
export async function drainTableAssignmentNotifications(
  db: SupabaseClient,
  limit = TABLE_NOTIFY_SWEEP_LIMIT,
): Promise<TableNotifyDrainResult> {
  const result: TableNotifyDrainResult = { sent: 0, failed: 0, skippedNoConfig: 0 };
  const nowIso = new Date().toISOString();

  await db
    .from("lead_assignment_notifications")
    .update({ status: "queued", next_attempt_at: nowIso, updated_at: nowIso })
    .eq("status", "sending")
    .lte("updated_at", new Date(Date.now() - 10 * 60_000).toISOString());

  const { data: due, error } = await db
    .from("lead_assignment_notifications")
    .select("*")
    .in("status", ["queued", "failed"])
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[table-assign-notify] due-jobs scan failed:", error.message);
    return result;
  }

  for (const row of ((due ?? []) as Array<Record<string, unknown>>)) {
    const attempt = (typeof row.attempt === "number" ? row.attempt : 0) + 1;
    const { data: claimed } = await db
      .from("lead_assignment_notifications")
      .update({ status: "sending", attempt, updated_at: nowIso })
      .eq("id", row.id as string)
      .in("status", ["queued", "failed"])
      .lte("next_attempt_at", nowIso)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      if (row.channel === "email") {
        await sendAssignmentEmail(db, row, nowIso);
      } else {
        await sendAssignmentWhatsapp(db, row);
      }
      await db
        .from("lead_assignment_notifications")
        .update({
          status: "sent",
          sent_at: nowIso,
          last_error: null,
          next_attempt_at: null,
          updated_at: nowIso,
        })
        .eq("id", row.id as string);
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const terminal =
        /no valid|not configured|no longer|not approved|can(?:not)? be sent|terminal/i.test(message) ||
        attempt >= (typeof row.max_attempts === "number" ? row.max_attempts : TABLE_NOTIFY_MAX_ATTEMPTS);
      await db
        .from("lead_assignment_notifications")
        .update({
          status: "failed",
          last_error: message.slice(0, 500),
          failed_at: terminal ? nowIso : null,
          next_attempt_at: terminal
            ? null
            : new Date(Date.now() + notifyRetryDelayMs(attempt)).toISOString(),
          updated_at: nowIso,
        })
        .eq("id", row.id as string);
      result.failed += 1;
      console.error(
        `[table-assign-notify] job ${row.id} failed (attempt ${attempt}): ${message.slice(0, 200)}`,
      );
    }
  }
  return result;
}

async function resolveInternalEmail(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<string | null> {
  const { data } = await db
    .from("profiles")
    .select("email")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  const email = (data as { email?: unknown } | null)?.email;
  return typeof email === "string" && email.trim() !== "" ? email.trim() : null;
}

async function sendAssignmentEmail(
  db: SupabaseClient,
  row: Record<string, unknown>,
  nowIso: string,
): Promise<void> {
  const accountId = row.account_id as string;
  let to = typeof row.to_email === "string" ? row.to_email.trim() : "";
  const userId = row.assignee_id as string | null;
  // Internal members: re-resolve from the roster at send time so a
  // fixed email still delivers; the snapshot covers removed rows.
  if (userId) {
    const { data: assignee } = await db
      .from("lead_assignment_table_assignees")
      .select("user_id")
      .eq("id", userId)
      .maybeSingle();
    const linkedUserId = (assignee as { user_id?: string | null } | null)?.user_id;
    if (linkedUserId) {
      const live = await resolveInternalEmail(db, accountId, linkedUserId);
      if (live) to = live;
    }
  }
  if (!to || !isValidAssigneeEmail(to)) {
    throw new Error("no valid salesperson email address for this lead");
  }
  const smtp = getMetaSmtpStatus();
  if (!smtp.configured) throw new Error(smtp.error ?? "SMTP is not configured.");
  const subject =
    typeof row.subject === "string" && row.subject.trim() !== ""
      ? row.subject
      : "New lead assigned to you";
  const body =
    typeof row.body === "string" && row.body !== ""
      ? row.body
      : "A new lead was assigned to you in WhatsApp Max.";
  await sendEmailViaSmtp({ to, subject, text: body, html: `<pre>${escapeHtml(body)}</pre>` });
  void nowIso;
}

async function sendAssignmentWhatsapp(
  db: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  const accountId = row.account_id as string;
  const phone =
    typeof row.to_phone === "string" ? sanitizePhoneForMeta(row.to_phone) : "";
  if (!phone || !isValidE164(phone)) {
    throw new Error("Assignee has no valid international phone number; cannot send WhatsApp.");
  }
  const templateName =
    typeof row.template_name === "string" ? row.template_name : "";
  const templateLanguage =
    typeof row.template_language === "string" ? row.template_language : "en_US";
  if (!templateName) {
    throw new Error("No WhatsApp template is configured for this table; cannot send WhatsApp.");
  }
  const { data: config, error: configErr } = await db
    .from("whatsapp_config")
    .select("access_token, phone_number_id")
    .eq("account_id", accountId)
    .maybeSingle();
  if (configErr) throw configErr;
  if (!config) {
    throw new Error("WhatsApp is not configured for this account yet; will retry.");
  }
  const cfg = config as { access_token: string; phone_number_id: string };
  let accessToken: string;
  try {
    accessToken = decrypt(cfg.access_token);
  } catch {
    throw new Error("WhatsApp credentials cannot be decrypted; reconnect WhatsApp.");
  }
  // The template's ACTUAL structure drives the send: body
  // parameters are built from its real variable slots (never a
  // hardcoded count), so a 2-variable template like
  // `new_lead_notification` gets exactly two BODY values instead of
  // tripping Meta #132000 (parameter count mismatch).
  const { data: templateRow } = await db
    .from("message_templates")
    .select(
      "name, status, language, body_text, header_type, header_content, header_media_url, buttons",
    )
    .eq("account_id", accountId)
    .eq("name", templateName)
    .eq("language", templateLanguage)
    .maybeSingle();
  const template = templateRow as (MessageTemplate & {
    status?: string;
  }) | null;
  if (!template || !template.name) {
    throw new Error(
      `Template "${templateName}" (${templateLanguage}) no longer exists; update this table's assignment settings.`,
    );
  }
  if (template.status !== "APPROVED") {
    throw new Error(
      `Template "${templateName}" (${templateLanguage}) is ${template.status ?? "not approved"}; only APPROVED templates can be sent.`,
    );
  }
  const leadName =
    typeof row.lead_name === "string" && row.lead_name.trim() !== ""
      ? row.lead_name.trim()
      : "a new lead";
  const leadPhone =
    typeof row.lead_phone === "string" && row.lead_phone.trim() !== ""
      ? row.lead_phone.trim()
      : "";
  // Validates before any Meta call: unsatisfiable templates fail
  // here with an actionable message (terminal — retrying the same
  // snapshot can never heal it) instead of a #132000 from Meta.
  const body = buildAssignmentBodyParams(
    template,
    templateName,
    templateLanguage,
    leadName,
    leadPhone,
  );
  await sendTemplateMessage({
    phoneNumberId: cfg.phone_number_id,
    accessToken,
    to: phone,
    templateName,
    language: templateLanguage,
    template,
    messageParams: { body },
  });
}

/**
 * BODY values for one assignment notification, derived from the
 * template's ACTUAL variable slots. Assignment notifications carry
 * exactly two facts about the lead: body {{1}} is the lead's name,
 * body {{2}} is the lead's phone number. Anything beyond that —
 * further body variables, text-header variables, URL-button
 * variables — has no assignment-time value, so such templates are
 * rejected here (before Meta is called) with an actionable,
 * terminal error instead of Meta #132000. Pure (unit-testable).
 */
export function buildAssignmentBodyParams(
  template: Pick<
    MessageTemplate,
    "body_text" | "header_type" | "header_content" | "buttons"
  >,
  templateName: string,
  templateLanguage: string,
  leadName: string,
  leadPhone: string,
): string[] {
  const label = `"${templateName}" (${templateLanguage})`;
  const name = typeof leadName === "string" ? leadName : "";
  const phone = typeof leadPhone === "string" ? leadPhone.trim() : "";
  const bodyText =
    typeof template.body_text === "string" ? template.body_text : "";
  const bodyIndices = extractVariableIndices(bodyText);
  // Meta numbers body variables sequentially from {{1}} — a gap
  // would silently shift values into the wrong slots, so reject it
  // here instead of guessing.
  if (bodyIndices.length > 0 && !bodyIndices.every((n, i) => n === i + 1)) {
    throw new Error(
      `Template ${label} cannot be sent: body variables must run {{1}}..{{${bodyIndices.length}}} without gaps. Re-sync the template from Meta, then retry.`,
    );
  }
  const body: string[] = [];
  for (const n of bodyIndices) {
    if (n === 1) {
      body.push(name);
    } else if (n === 2) {
      if (!phone) {
        throw new Error(
          `Template ${label} cannot be sent: it needs the lead's phone number for {{2}} but this lead has none. Update the lead's contact details, then retry.`,
        );
      }
      body.push(phone);
    } else {
      throw new Error(
        `Template ${label} cannot be sent: variable {{${n}}} has no assignment-notification value (only lead name {{1}} and lead phone {{2}} are available). Choose a template that needs at most those two.`,
      );
    }
  }
  if (
    template.header_type === "text" &&
    extractVariableIndices(
      typeof template.header_content === "string"
        ? template.header_content
        : "",
    ).length > 0
  ) {
    throw new Error(
      `Template ${label} cannot be sent: its text header needs a variable value that assignment notifications do not provide. Choose a template without header variables.`,
    );
  }
  const buttons: TemplateButton[] = Array.isArray(template.buttons)
    ? template.buttons
    : [];
  for (const btn of buttons) {
    if (
      btn &&
      btn.type === "URL" &&
      typeof btn.url === "string" &&
      extractVariableIndices(btn.url).length > 0
    ) {
      throw new Error(
        `Template ${label} cannot be sent: a URL button needs a variable value that assignment notifications do not provide. Choose a template without URL-button variables.`,
      );
    }
  }
  return body;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
