import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt } from "@/lib/whatsapp/encryption";
import { sendTemplateMessage, sendTextMessage } from "@/lib/whatsapp/meta-api";
import { buildSendComponents } from "@/lib/whatsapp/template-send-builder";
import type { MessageTemplate } from "@/types";
import { SendMessageError } from "@/lib/whatsapp/send-message";

// Re-exported so scheduler callers import the sender and its error
// type from one module.
export { SendMessageError };

/**
 * Fail-closed reason stored when the 24-hour window is closed and
 * the account has no usable fallback template. Worded for the
 * Reminders UI/API surface (no silent text downgrade — Meta would
 * reject free-form text outside the window).
 */
export const NO_FALLBACK_TEMPLATE_MESSAGE =
  "24-hour window is closed and no approved fallback template is configured.";

// ============================================================
// Self-reminder send: deliver a reminder TO ITS CREATOR's stored
// WhatsApp number (`recipient_phone` snapshot on the reminder row)
// FROM the account's connected WhatsApp Business number.
//
// This is deliberately NOT `sendMessageToConversation`: a personal
// reminder must never open/touch a customer conversation, pause
// flow runs, mutate conversation previews, auto-correct contact
// phones, or consult the 24-hour customer-service window. The ONLY
// database reads here are the account-scoped `whatsapp_config`
// (sender credentials) plus the fallback-template lookup; the ONLY
// write the caller performs is the reminder row's own status. (The
// scheduler separately persists the sent reminder onto the
// RECIPIENT's own Inbox thread via persistReminderOutboundMessage —
// never a customer thread.)
//
// `db` may be the service-role client (cron worker). Every query
// is filtered by `accountId`, so tenancy holds regardless.
// ============================================================

export interface ReminderSendParams {
  /**
   * Immutable snapshot from the reminder row — the creating
   * agent's own WhatsApp number (digits-only E.164). Never derived
   * here; the caller passes exactly what the row stores.
   */
  to: string;
  /** Reminder body (already trimmed, within Meta's text cap). */
  text: string;
}

export interface ReminderSendResult {
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
  /** Sender phone_number_id used (the account's connected number). */
  phoneNumberId: string;
  /**
   * Meta's `contacts[].wa_id` normalization echo when the API
   * returns it — the WhatsApp id Meta actually addressed. Absent
   * on older responses; diagnostics compare it against `to`.
   */
  recipientWaId?: string;
  /** Which path delivered this reminder (for logging). */
  via?: "text" | "template";
  /** Fallback template name when via is `template`. */
  templateName?: string;
  /** Fallback template language when via is `template`. */
  templateLanguage?: string;
}

interface SenderCredentials {
  phoneNumberId: string;
  accessToken: string;
}

/** Resolve + decrypt the account's connected sender credentials. */
async function loadSenderCredentials(
  db: SupabaseClient,
  accountId: string,
): Promise<SenderCredentials> {
  const { data: config, error: configError } = await db
    .from("whatsapp_config")
    .select("phone_number_id, access_token")
    .eq("account_id", accountId)
    .maybeSingle();

  if (configError || !config) {
    throw new SendMessageError(
      "whatsapp_not_configured",
      "WhatsApp not configured. Please set up your WhatsApp integration first.",
      400,
    );
  }

  const row = config as {
    phone_number_id: string;
    access_token: string;
  };
  if (!row.phone_number_id || !row.access_token) {
    throw new SendMessageError(
      "whatsapp_not_configured",
      "WhatsApp not configured. Please set up your WhatsApp integration first.",
      400,
    );
  }

  let accessToken: string;
  try {
    accessToken = decrypt(row.access_token);
  } catch {
    throw new SendMessageError(
      "whatsapp_not_configured",
      "WhatsApp credentials could not be read. Please reconnect WhatsApp in Settings.",
      400,
    );
  }
  return { phoneNumberId: row.phone_number_id, accessToken };
}

export async function sendReminderToAgent(
  db: SupabaseClient,
  accountId: string,
  params: ReminderSendParams,
): Promise<ReminderSendResult> {
  const { to, text } = params;

  if (!to) {
    throw new SendMessageError(
      "bad_request",
      "Reminder has no recipient phone number.",
      400,
    );
  }
  if (!text) {
    throw new SendMessageError("bad_request", "Reminder text is required.", 400);
  }

  // Sender: the account's connected WhatsApp Business number.
  const { phoneNumberId, accessToken } = await loadSenderCredentials(
    db,
    accountId,
  );

  try {
    const result = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to,
      text,
    });
    return {
      whatsappMessageId: result.messageId,
      phoneNumberId,
      via: "text",
      ...(result.contacts?.[0]?.waId
        ? { recipientWaId: result.contacts[0].waId }
        : {}),
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown Meta API error";
    throw new SendMessageError("meta_error", `Meta API error: ${message}`, 502);
  }
}

/**
 * Normalize free-form reminder text into a single Meta template
 * body parameter. Meta rejects (#132018) parameters containing
 * newline/tab characters or 4+ consecutive spaces, and
 * Workspace-generated defaults are multiline — so every line or
 * paragraph break (CR, LF, CRLF, vertical tab, form feed, tab,
 * U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR) becomes an
 * ordinary space, every run of spaces (including non-breaking and
 * other Unicode spaces) collapses to exactly one ordinary space,
 * and the result is trimmed. Wording, names, numbers, punctuation,
 * and emojis are otherwise preserved byte-for-byte — nothing is
 * truncated or dropped.
 *
 * Template path only: the free-text path sends the original text
 * (with line breaks) untouched. The stored database message is
 * never modified; normalization happens in memory right here.
 */
export function normalizeTemplateTextParam(text: string): string {
  return text
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, " ")
    .replace(/[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]{2,}/g, " ")
    .trim();
}

/** Meta #132018 guard: no line breaks/tabs of any kind, no 4+ consecutive spaces. */
function assertTemplateParamSendable(param: string, templateName: string, language: string): void {
  if (/[\r\n\t\v\f\u2028\u2029]/.test(param) || / {4,}/.test(param)) {
    throw new SendMessageError(
      "template_invalid",
      `The reminder text cannot be sent through template "${templateName}" (${language}): parameters must not contain line breaks, tabs, or long runs of spaces.`,
      400,
    );
  }
}
/**
 * Template fallback for closed-window sends: delivers the reminder
 * through the account's configured APPROVED template with the
 * reminder text as `{{1}}`. Same recipient, same sender, same
 * bookkeeping contract as the text path — no customer
 * conversation, no contact lookup. (Inbox persistence happens in
 * the scheduler with `templateName` set, so the thread shows the
 * reminder content with template metadata.)
 *
 * Fail-closed contract (never silently downgraded to text, which
 * Meta would reject outside the window; never silently swapped to
 * another template — only the exact configured name/language):
 *   - no configured template → `no_fallback_template`
 *   - template row missing → `template_missing`
 *   - not APPROVED → `template_unapproved`
 *   - body without exactly one `{{1}}`, or extra send-time
 *     requirements the reminder cannot satisfy (media/text header
 *     variables, URL-button variables) → `template_invalid`
 */
export async function sendReminderViaTemplate(
  db: SupabaseClient,
  accountId: string,
  params: ReminderSendParams,
): Promise<ReminderSendResult> {
  const { to, text } = params;

  if (!to) {
    throw new SendMessageError(
      "bad_request",
      "Reminder has no recipient phone number.",
      400,
    );
  }
  if (!text) {
    throw new SendMessageError("bad_request", "Reminder text is required.", 400);
  }

  const { data: account, error: accountErr } = await db
    .from("accounts")
    .select("reminder_template_name, reminder_template_language")
    .eq("id", accountId)
    .maybeSingle();
  if (accountErr || !account) {
    throw new SendMessageError(
      "no_fallback_template",
      NO_FALLBACK_TEMPLATE_MESSAGE,
      400,
    );
  }
  const setting = account as {
    reminder_template_name?: string | null;
    reminder_template_language?: string | null;
  };
  // Exact configured values — no guessing, no second source, no
  // silent substitution. Language defaults to en_US only when the
  // setting itself carries none.
  const templateName = setting.reminder_template_name?.trim() || null;
  const language = setting.reminder_template_language?.trim() || "en_US";
  if (!templateName) {
    throw new SendMessageError(
      "no_fallback_template",
      NO_FALLBACK_TEMPLATE_MESSAGE,
      400,
    );
  }

  const { data: template, error: templateErr } = await db
    .from("message_templates")
    .select("*")
    .eq("account_id", accountId)
    .eq("name", templateName)
    .eq("language", language)
    .maybeSingle();
  const row = (template ?? null) as MessageTemplate | null;
  if (templateErr || !row) {
    throw new SendMessageError(
      "template_missing",
      `The configured reminder template "${templateName}" (${language}) was not found in this account.`,
      400,
    );
  }
  if (row.status !== "APPROVED") {
    throw new SendMessageError(
      "template_unapproved",
      `The configured reminder template "${templateName}" (${language}) is not APPROVED by Meta (status: ${row.status ?? "unknown"}).`,
      400,
    );
  }
  const bodyVars = (row.body_text ?? "").match(/\{\{(\d+)\}\}/g) ?? [];
  if (bodyVars.length !== 1 || !bodyVars[0]?.includes("{{1}}")) {
    throw new SendMessageError(
      "template_invalid",
      `The configured reminder template "${templateName}" (${language}) must contain exactly one {{1}} body variable.`,
      400,
    );
  }

  const { phoneNumberId, accessToken } = await loadSenderCredentials(
    db,
    accountId,
  );

  // Meta #132018: template body parameters reject newlines, tabs,
  // and 4+ consecutive spaces. Normalize ONLY the outgoing template
  // parameter — the stored row, the free-text path, and the Inbox
  // preview are untouched.
  const param = normalizeTemplateTextParam(text);
  if (!param) {
    throw new SendMessageError("bad_request", "Reminder text is required.", 400);
  }
  assertTemplateParamSendable(param, templateName, language);

  // Pre-flight the exact Meta components BEFORE touching the
  // network: a template needing more than the single body value
  // (media/text header variable, URL-button variable) can never be
  // satisfied by a reminder send. Surfacing it here keeps the
  // failure classified as `template_invalid` with the precise
  // reason instead of a misleading Meta error after the fact.
  try {
    buildSendComponents(row, { body: [param] });
  } catch (err) {
    throw new SendMessageError(
      "template_invalid",
      `The configured reminder template "${templateName}" (${language}) cannot be sent as a reminder: ${err instanceof Error ? err.message : "unsupported template shape"}`,
      400,
    );
  }

  try {
    const result = await sendTemplateMessage({
      phoneNumberId,
      accessToken,
      to,
      templateName,
      language,
      template: row,
      messageParams: { body: [param] },
    });
    return {
      whatsappMessageId: result.messageId,
      phoneNumberId,
      via: "template",
      templateName,
      templateLanguage: language,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown Meta API error";
    throw new SendMessageError("meta_error", `Meta API error: ${message}`, 502);
  }
}
