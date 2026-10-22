/**
 * Meta Lead Ads — new-lead email notifications.
 *
 * When a genuinely new Meta lead is processed AND assigned to a
 * salesperson, one email is enqueued for that salesperson's
 * registered address. Design notes:
 *
 * - Enqueue is a single fast INSERT keyed UNIQUE(account_id,
 *   submission_id): polling, imports, retries and concurrent
 *   workers collapse to one row. Enqueue never throws into lead
 *   processing — failures are logged and swallowed by the caller.
 * - Sending is drained by the existing meta-lead-ads cron sweep
 *   (no new scheduler): claim → render → SMTP → sent / backoff.
 * - Transport is Gmail SMTP ONLY (sendEmailViaSmtp). The Resend
 *   sandbox sender is never used as a fallback — without SMTP
 *   configuration the job fails with an actionable error.
 * - The per-account `enabled` flag is checked at enqueue AND at
 *   send time. Disabled at send time → the row stays queued for a
 *   later sweep (never sent silently, never failed spuriously).
 * - Reassignment after a sent notification does NOT enqueue again:
 *   the unique key already holds a sent row for the submission.
 * - Ad-set name is intentionally absent: Meta's Lead node exposes
 *   campaign_name/ad_name but no ad-set name, so there is nothing
 *   truthful to render.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAppBaseUrl } from "@/lib/auth/recovery";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { sendEmailViaSmtp } from "@/lib/email/send";
import { isValidEmail, sanitizeHeaderLine } from "@/lib/email/validate";

import { normalizeLeadFieldData } from "./normalize";

// ------------------------------------------------------------
// Policy
// ------------------------------------------------------------

/** Max send attempts per notification (first try + retries). */
export const META_NOTIFY_MAX_ATTEMPTS = 3;

/** Bounded backoff between attempts: 1m, 2m, 4m … capped at 15m. */
export function notifyRetryDelayMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 900_000);
}

/** Rows claimed per drain sweep (cron budget, mirrors flow email drain). */
export const META_NOTIFY_SWEEP_LIMIT = 20;

const STALE_SENDING_CUTOFF_MS = 10 * 60_000;

export const DEFAULT_NOTIFY_SUBJECT = "New Lead Assigned to You — {{lead_name}}";

export const DEFAULT_NOTIFY_BODY = [
  "Hi {{assignee_name}},",
  "",
  "A new lead was assigned to you in WhatsApp Max.",
  "",
  "Name: {{lead_name}}",
  "Phone: {{lead_phone}}",
  "Email: {{lead_email}}",
  "Form: {{form_name}}",
  "Campaign: {{campaign_name}}",
  "Ad: {{ad_name}}",
  "Received: {{received_at}}",
  "",
  "Open the lead: {{lead_link}}",
].join("\n");

const MAX_TEMPLATE_LEN = 4000;

/** Placeholders supported in subject/body templates. */
export type NotifyTemplateKey =
  | "lead_name"
  | "lead_phone"
  | "lead_email"
  | "form_name"
  | "campaign_name"
  | "ad_name"
  | "received_at"
  | "lead_link"
  | "assignee_name";

export interface NotifySettings {
  enabled: boolean;
  subjectTemplate: string;
  bodyTemplate: string;
}

export interface NotifySnapshot {
  leadName: string | null;
  leadPhone: string | null;
  leadEmail: string | null;
  formName: string | null;
  campaignName: string | null;
  adName: string | null;
  receivedAt: string | null;
  contactId: string | null;
  assigneeName: string | null;
}

export interface EnqueueResult {
  enqueued: boolean;
  /** Machine-readable reason when nothing was enqueued. */
  reason:
    | "enqueued"
    | "duplicate"
    | "disabled"
    | "unassigned"
    | "submission-not-found"
    | "error";
  notificationId?: string;
}

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------

export function defaultNotifySettings(): NotifySettings {
  return {
    enabled: false,
    subjectTemplate: DEFAULT_NOTIFY_SUBJECT,
    bodyTemplate: DEFAULT_NOTIFY_BODY,
  };
}

/** Account's notification settings; absent row == defaults (OFF). */
export async function getNotificationSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<NotifySettings> {
  const { data, error } = await db
    .from("meta_lead_notification_settings")
    .select("enabled, subject_template, body_template")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    enabled?: boolean;
    subject_template?: string | null;
    body_template?: string | null;
  } | null;
  if (!row) return defaultNotifySettings();
  return {
    enabled: row.enabled === true,
    subjectTemplate: row.subject_template || DEFAULT_NOTIFY_SUBJECT,
    bodyTemplate: row.body_template || DEFAULT_NOTIFY_BODY,
  };
}

export function validateNotifyTemplates(input: {
  subjectTemplate?: unknown;
  bodyTemplate?: unknown;
}): { subjectTemplate: string; bodyTemplate: string } | { error: string } {
  const subject =
    typeof input.subjectTemplate === "string" ? input.subjectTemplate : DEFAULT_NOTIFY_SUBJECT;
  const body =
    typeof input.bodyTemplate === "string" ? input.bodyTemplate : DEFAULT_NOTIFY_BODY;
  if (!subject.trim()) return { error: "Subject template must not be empty." };
  if (!body.trim()) return { error: "Body template must not be empty." };
  if (subject.length > MAX_TEMPLATE_LEN || body.length > MAX_TEMPLATE_LEN) {
    return { error: `Templates must be under ${MAX_TEMPLATE_LEN} characters.` };
  }
  return { subjectTemplate: subject, bodyTemplate: body };
}

// ------------------------------------------------------------
// Rendering (injection-safe)
// ------------------------------------------------------------

/** Escape text for the HTML email body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type NotifyTemplateValues = Record<NotifyTemplateKey, string>;

/** Replace {{placeholders}}; unknown keys render as empty strings. */
export function renderNotifyTemplate(
  template: string,
  values: NotifyTemplateValues,
): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key: string) => {
    if (key in values) return values[key as NotifyTemplateKey];
    return "";
  });
}

function snapshotToValues(
  snapshot: NotifySnapshot,
  leadLink: string,
): NotifyTemplateValues {
  const text = (v: string | null) => (v ?? "").trim();
  return {
    lead_name: text(snapshot.leadName) || "—",
    lead_phone: text(snapshot.leadPhone) || "—",
    lead_email: text(snapshot.leadEmail) || "—",
    form_name: text(snapshot.formName) || "—",
    campaign_name: text(snapshot.campaignName) || "—",
    ad_name: text(snapshot.adName) || "—",
    received_at: text(snapshot.receivedAt) || "—",
    lead_link: leadLink,
    assignee_name: text(snapshot.assigneeName) || "there",
  };
}

/** Branded HTML shell around the rendered plain-text body. */
export function buildNotifyHtml(renderedBody: string, leadLink: string): string {
  const lines = renderedBody.split("\n");
  const paras: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      paras.push(`<p style="margin:0 0 12px;">${current.join("<br>")}</p>`);
      current = [];
    }
  };
  for (const line of lines) {
    if (line.trim() === "") flush();
    else current.push(escapeHtml(line));
  }
  flush();
  const safeLink = escapeHtml(leadLink);
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">',
    '<div style="background:#075E54;padding:16px 20px;color:#ffffff;font-size:18px;font-weight:bold;">WhatsApp Max — New Lead</div>',
    `<div style="padding:20px;border:1px solid #e5e5e5;border-top:none;">${paras.join("")}`,
    `<p style="margin:16px 0 0;"><a href="${safeLink}" style="display:inline-block;background:#25D366;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;">Open the lead</a></p>`,
    "</div>",
    '<div style="padding:12px 20px;font-size:12px;color:#777;">This is an automated notification from WhatsApp Max.</div>',
    "</div>",
  ].join("");
}

// ------------------------------------------------------------
// SMTP configuration status (presence only — never secrets)
// ------------------------------------------------------------

export interface SmtpStatus {
  configured: boolean;
  /** Safe, actionable reason when not configured. */
  error: string | null;
}

/**
 * Whether Gmail SMTP can send right now. Requires SMTP_HOST and an
 * authenticated sender identity; never claims readiness otherwise.
 */
export function getMetaSmtpStatus(env: NodeJS.ProcessEnv = process.env): SmtpStatus {
  const host = (env.SMTP_HOST ?? "").trim();
  const user = (env.SMTP_USER ?? "").trim();
  const pass = (env.SMTP_PASSWORD ?? env.SMTP_PASS ?? "").trim();
  if (!host) {
    return {
      configured: false,
      error:
        "SMTP is not configured (set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS on the server). No email was sent.",
    };
  }
  if (!user || !pass) {
    return {
      configured: false,
      error:
        "SMTP sender credentials are incomplete (SMTP_USER and SMTP_PASS are both required). No email was sent.",
    };
  }
  return { configured: true, error: null };
}

// ------------------------------------------------------------
// Enqueue (idempotent, never throws)
// ------------------------------------------------------------

interface SubmissionRow {
  id: string;
  account_id: string;
  flow_run_id: string | null;
  contact_id: string | null;
  form_name: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  answers: Record<string, string> | null;
  field_data: Array<{ name?: string; values?: string[] }> | null;
  meta_created_time: string | null;
  created_at: string;
}

async function loadSubmission(
  db: SupabaseClient,
  accountId: string,
  submissionId: string,
): Promise<SubmissionRow | null> {
  const { data, error } = await db
    .from("meta_lead_submissions")
    .select(
      "id, account_id, flow_run_id, contact_id, form_name, campaign_name, ad_name, answers, field_data, meta_created_time, created_at",
    )
    .eq("id", submissionId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as SubmissionRow | null) ?? null;
}

async function resolveAssigneeEmail(
  db: SupabaseClient,
  accountId: string,
  assigneeUserId: string,
): Promise<{ email: string | null; name: string | null }> {
  const { data, error } = await db
    .from("profiles")
    .select("email, full_name")
    .eq("account_id", accountId)
    .eq("user_id", assigneeUserId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { email?: string | null; full_name?: string | null } | null;
  const email = (row?.email ?? "").trim();
  return {
    email: isValidEmail(email) ? email : null,
    name: (row?.full_name ?? "").trim() || null,
  };
}

function snapshotFromSubmission(
  submission: SubmissionRow,
  assigneeName: string | null,
): NotifySnapshot {
  const normalized = normalizeLeadFieldData(submission.field_data ?? []);
  const answers = (submission.answers ?? {}) as Record<string, string>;
  return {
    leadName: normalized.standard.name ?? answers["full_name"] ?? null,
    leadPhone:
      normalized.standard.phone ?? answers["phone_number"] ?? answers["phone"] ?? null,
    leadEmail: normalized.standard.email ?? answers["email"] ?? null,
    formName: submission.form_name,
    campaignName: submission.campaign_name,
    adName: submission.ad_name,
    receivedAt: submission.meta_created_time ?? submission.created_at,
    contactId: submission.contact_id,
    assigneeName,
  };
}

/**
 * Enqueue a notification for an assigned lead. Idempotent via
 * UNIQUE(account_id, submission_id). Never throws — callers in the
 * ingestion path must not fail because of notifications.
 */
export async function maybeEnqueueLeadNotification(
  db: SupabaseClient,
  args: { accountId: string; submissionId: string; assigneeUserId: string | null },
): Promise<EnqueueResult> {
  try {
    if (!args.assigneeUserId) return { enqueued: false, reason: "unassigned" };

    const settings = await getNotificationSettings(db, args.accountId);
    if (!settings.enabled) return { enqueued: false, reason: "disabled" };

    const submission = await loadSubmission(db, args.accountId, args.submissionId);
    if (!submission) return { enqueued: false, reason: "submission-not-found" };

    const assignee = await resolveAssigneeEmail(db, args.accountId, args.assigneeUserId);
    const snapshot = snapshotFromSubmission(submission, assignee.name);

    const { data, error } = await db
      .from("meta_lead_notifications")
      .insert({
        account_id: args.accountId,
        submission_id: submission.id,
        flow_run_id: submission.flow_run_id,
        recipient_user_id: args.assigneeUserId,
        recipient_email: assignee.email,
        assignee_name: snapshot.assigneeName,
        lead_name: snapshot.leadName,
        lead_phone: snapshot.leadPhone,
        lead_email: snapshot.leadEmail,
        form_name: snapshot.formName,
        campaign_name: snapshot.campaignName,
        ad_name: snapshot.adName,
        received_at: snapshot.receivedAt,
        max_attempts: META_NOTIFY_MAX_ATTEMPTS,
      })
      .select("id")
      .single();
    if (error) {
      if (isUniqueViolation(error)) return { enqueued: false, reason: "duplicate" };
      throw error;
    }
    return { enqueued: true, reason: "enqueued", notificationId: (data as { id: string }).id };
  } catch (err) {
    console.error(
      "[meta-lead-notify] enqueue failed (lead processing unaffected):",
      err instanceof Error ? err.message : err,
    );
    return { enqueued: false, reason: "error" };
  }
}

/**
 * Enqueue by Workspace run id (manual assignment + assignment retry
 * paths). Resolves the Meta submission server-side; unknown runs
 * are a safe no-op.
 */
export async function maybeEnqueueForRun(
  db: SupabaseClient,
  args: { accountId: string; runId: string; assigneeUserId: string | null },
): Promise<EnqueueResult> {
  try {
    const { data, error } = await db
      .from("meta_lead_submissions")
      .select("id")
      .eq("account_id", args.accountId)
      .eq("flow_run_id", args.runId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { id: string } | null;
    if (!row) return { enqueued: false, reason: "submission-not-found" };
    return maybeEnqueueLeadNotification(db, {
      accountId: args.accountId,
      submissionId: row.id,
      assigneeUserId: args.assigneeUserId,
    });
  } catch (err) {
    console.error(
      "[meta-lead-notify] enqueue-for-run failed (assignment unaffected):",
      err instanceof Error ? err.message : err,
    );
    return { enqueued: false, reason: "error" };
  }
}

// ------------------------------------------------------------
// Drain — called by the existing meta-lead-ads cron sweep
// ------------------------------------------------------------

export interface DrainResult {
  sent: number;
  failed: number;
  skippedDisabled: number;
  finalFailures: number;
}

interface NotificationRow {
  id: string;
  account_id: string;
  recipient_user_id: string | null;
  recipient_email: string | null;
  assignee_name: string | null;
  lead_name: string | null;
  lead_phone: string | null;
  lead_email: string | null;
  form_name: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  received_at: string | null;
  contact_id?: string | null;
  flow_run_id: string | null;
  status: string;
  attempt: number;
  max_attempts: number;
}

function leadLinkFor(base: string, contactId: string | null | undefined): string {
  return contactId ? `${base}/workspace?contact=${encodeURIComponent(contactId)}` : `${base}/workspace`;
}

async function markRowFailed(
  db: SupabaseClient,
  row: NotificationRow,
  attempt: number,
  message: string,
): Promise<"retry" | "terminal"> {
  const nowIso = new Date().toISOString();
  const willRetry = attempt < row.max_attempts;
  if (willRetry) {
    await db
      .from("meta_lead_notifications")
      .update({
        status: "failed",
        attempt,
        last_error: message.slice(0, 500),
        next_attempt_at: new Date(Date.now() + notifyRetryDelayMs(attempt)).toISOString(),
        updated_at: nowIso,
      })
      .eq("id", row.id);
    return "retry";
  }
  await db
    .from("meta_lead_notifications")
    .update({
      status: "failed",
      attempt,
      last_error: message.slice(0, 500),
      failed_at: nowIso,
      next_attempt_at: null,
      updated_at: nowIso,
    })
    .eq("id", row.id);
  return "terminal";
}

/**
 * Send due notification emails. Never throws for per-job failures;
 * each outcome is recorded on its row. Safe to call from the cron.
 */
export async function drainMetaLeadNotifications(
  db: SupabaseClient,
  limit = META_NOTIFY_SWEEP_LIMIT,
): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, failed: 0, skippedDisabled: 0, finalFailures: 0 };
  const now = new Date();
  const nowIso = now.toISOString();

  const staleCutoff = new Date(now.getTime() - STALE_SENDING_CUTOFF_MS).toISOString();
  await db
    .from("meta_lead_notifications")
    .update({ status: "queued", next_attempt_at: nowIso, updated_at: nowIso })
    .eq("status", "sending")
    .lte("updated_at", staleCutoff);

  const { data: due, error } = await db
    .from("meta_lead_notifications")
    .select(
      "id, account_id, recipient_user_id, recipient_email, assignee_name, lead_name, lead_phone, lead_email, form_name, campaign_name, ad_name, received_at, flow_run_id, status, attempt, max_attempts",
    )
    .in("status", ["queued", "failed"])
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[meta-lead-notify] due-jobs scan failed:", error.message);
    return result;
  }

  for (const row of ((due ?? []) as NotificationRow[])) {
    const attempt = row.attempt + 1;

    const { data: claimed } = await db
      .from("meta_lead_notifications")
      .update({ status: "sending", attempt, updated_at: nowIso })
      .eq("id", row.id)
      .in("status", ["queued", "failed"])
      .lte("next_attempt_at", nowIso)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      // Settings are honored at send time too: a row enqueued while
      // enabled stays queued (unsent) if the account disabled the
      // feature before the sweep. It is picked up again once
      // re-enabled — never sent silently, never failed spuriously.
      const settings = await getNotificationSettings(db, row.account_id);
      if (!settings.enabled) {
        await db
          .from("meta_lead_notifications")
          .update({ status: "queued", attempt: row.attempt, updated_at: nowIso })
          .eq("id", row.id);
        result.skippedDisabled += 1;
        continue;
      }

      // Re-resolve the address at send time: a profile email fixed
      // after enqueue still delivers.
      let email = (row.recipient_email ?? "").trim() || null;
      let assigneeName = row.assignee_name;
      if (row.recipient_user_id) {
        const resolved = await resolveAssigneeEmail(db, row.account_id, row.recipient_user_id);
        if (resolved.email) email = resolved.email;
        if (resolved.name) assigneeName = resolved.name;
      }
      if (!email || !isValidEmail(email)) {
        throw new Error("no valid salesperson email address for this lead");
      }

      const smtp = getMetaSmtpStatus();
      if (!smtp.configured) throw new Error(smtp.error ?? "SMTP is not configured.");

      let base: string;
      try {
        base = getAppBaseUrl();
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : "Site URL is not configured for email links.",
        );
      }

      // Contact id for a deep link is resolved best-effort at send
      // time (it may have been attached after enqueue).
      let contactId: string | null = null;
      if (row.flow_run_id) {
        const { data: run } = await db
          .from("flow_runs")
          .select("contact_id")
          .eq("id", row.flow_run_id)
          .eq("account_id", row.account_id)
          .maybeSingle();
        contactId = (run as { contact_id?: string | null } | null)?.contact_id ?? null;
      }

      const snapshot: NotifySnapshot = {
        leadName: row.lead_name,
        leadPhone: row.lead_phone,
        leadEmail: row.lead_email,
        formName: row.form_name,
        campaignName: row.campaign_name,
        adName: row.ad_name,
        receivedAt: row.received_at,
        contactId,
        assigneeName,
      };
      const link = leadLinkFor(base, contactId);
      const values = snapshotToValues(snapshot, link);
      const subject = sanitizeHeaderLine(renderNotifyTemplate(settings.subjectTemplate, values));
      const text = renderNotifyTemplate(settings.bodyTemplate, values);
      const html = buildNotifyHtml(text, link);

      const sent = await sendEmailViaSmtp({ to: email, subject, text, html });
      await db
        .from("meta_lead_notifications")
        .update({
          status: "sent",
          sent_at: nowIso,
          sent_message_id: sent.messageId ?? null,
          last_error: null,
          next_attempt_at: null,
          updated_at: nowIso,
        })
        .eq("id", row.id);
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome = await markRowFailed(db, row, attempt, message).catch((dbErr) => {
        console.error(
          "[meta-lead-notify] failed to record job outcome:",
          dbErr instanceof Error ? dbErr.message : dbErr,
        );
        return "retry" as const;
      });
      result.failed += 1;
      if (outcome === "terminal") result.finalFailures += 1;
      console.error(
        `[meta-lead-notify] job ${row.id} failed (attempt ${attempt}/${row.max_attempts}): ${message}`,
      );
    }
  }

  return result;
}

// ------------------------------------------------------------
// Test email (admin-initiated, own address only)
// ------------------------------------------------------------

/**
 * Send a sample notification to the caller's OWN registered email.
 * Used to prove SMTP is operational before relying on it. The
 * recipient is always resolved server-side — never caller-supplied.
 */
export async function sendTestNotificationEmail(
  db: SupabaseClient,
  args: { accountId: string; userId: string },
): Promise<{ to: string; messageId?: string }> {
  const { data, error } = await db
    .from("profiles")
    .select("email, full_name")
    .eq("account_id", args.accountId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { email?: string | null; full_name?: string | null } | null;
  const to = (row?.email ?? "").trim();
  if (!isValidEmail(to)) {
    throw new Error("Your profile has no valid email address. Add one in Team Members first.");
  }

  const smtp = getMetaSmtpStatus();
  if (!smtp.configured) throw new Error(smtp.error ?? "SMTP is not configured.");

  const base = getAppBaseUrl();
  const values: NotifyTemplateValues = {
    lead_name: "Sample Lead",
    lead_phone: "+1 555-0100",
    lead_email: "sample@example.com",
    form_name: "Sample Instant Form",
    campaign_name: "Sample Campaign",
    ad_name: "Sample Ad",
    received_at: new Date().toISOString(),
    lead_link: leadLinkFor(base, null),
    assignee_name: (row?.full_name ?? "").trim() || "there",
  };
  const settings = await getNotificationSettings(db, args.accountId);
  const subject = `[Test] ${sanitizeHeaderLine(renderNotifyTemplate(settings.subjectTemplate, values))}`;
  const text = `This is a test of WhatsApp Max new-lead email notifications. No real lead was involved.\n\n${renderNotifyTemplate(settings.bodyTemplate, values)}`;
  const html = buildNotifyHtml(text, values.lead_link);
  const sent = await sendEmailViaSmtp({ to, subject, text, html });
  return { to, messageId: sent.messageId };
}
