/**
 * Email delivery for flow email notifications.
 *
 * Supports two providers, chosen by environment config:
 *
 *   1. Resend (transactional HTTP API) — preferred. Set `RESEND_API_KEY`
 *      (+ optionally `RESEND_FROM` for a verified sender). No SMTP
 *      server needed, works on serverless.
 *   2. SMTP via nodemailer — set `SMTP_HOST/PORT/USER/PASSWORD/FROM`.
 *
 * `sendEmail` dispatches to whichever provider is configured: Resend if
 * an API key is present, else SMTP. If neither is configured it throws
 * ("Email provider not configured") — the caller (the cron) records the
 * job as failed/retryable and the WhatsApp flow is never affected.
 *
 * Credentials come ONLY from server-side environment variables, never
 * from flow JSON or node configs. Config is read lazily (per call) so a
 * process that boots before env is wired picks it up on the next drain,
 * and the module is trivially testable against any provider/endpoint.
 *
 * Every network call is bounded by `EMAIL_TIMEOUT_MS` (default 10s) so
 * a hanging provider can never stall the cron or, transitively, the
 * flow it belongs to.
 */

import nodemailer from "nodemailer";

import { sanitizeHeaderLine } from "./validate";

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS || "10000");

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/** Read the SMTP config fresh on every call (lazy — see file header). */
export function getSmtpConfig(): SmtpConfig {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || "587");
  const secure = process.env.SMTP_SECURE === "true";
  const user = process.env.SMTP_USER || "";
  // SMTP_PASS is accepted as an alias for SMTP_PASSWORD (Gmail App
  // Password setups commonly use SMTP_PASS). SMTP_PASSWORD wins.
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS || "";
  // MAIL_FROM_EMAIL / MAIL_FROM_NAME optionally brand the envelope
  // sender (e.g. a shared notification mailbox). When unset, the
  // previous behavior is byte-for-byte identical.
  const fromEmail =
    process.env.MAIL_FROM_EMAIL || process.env.SMTP_FROM || user || "no-reply@localhost";
  const fromName = (process.env.MAIL_FROM_NAME || "").trim();
  const from = fromName ? `"${fromName.replace(/"/g, "")}" <${fromEmail}>` : fromEmail;
  return { host, port, secure, user, pass, from };
}

/** True when at least one email provider is configured. */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || getSmtpConfig().host);
}

export interface EmailSendInput {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative. When omitted, text-only is sent. */
  html?: string;
}

/** Result of a successful send (whatever the provider returned). */
export interface EmailSendResult {
  messageId?: string;
  /** Provider response line — includes the Ethereal preview URL for SMTP test accounts. */
  response?: string;
}

/**
 * Build the nodemailer options for a notification. The subject is
 * scrubbed of CR/LF/NUL so user-authored text can't inject extra
 * headers; the body is passed as plain text so newlines are safe.
 */
export function buildMailOptions(cfg: SmtpConfig, input: EmailSendInput) {
  return {
    from: cfg.from,
    to: input.to,
    subject: sanitizeHeaderLine(input.subject),
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
  };
}

/** Fresh transporter per send — bounded, no shared-state surprises. */
export function createTransporter(cfg: SmtpConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: RESEND_TIMEOUT_MS,
    socketTimeout: RESEND_TIMEOUT_MS,
    greetingTimeout: RESEND_TIMEOUT_MS,
  });
}

/**
 * Send one notification email via SMTP. Throws on any failure (including
 * timeout and "SMTP not configured") so the caller can apply retry
 * policy.
 */
export async function sendEmailViaSmtp(
  input: EmailSendInput,
): Promise<EmailSendResult> {
  const cfg = getSmtpConfig();
  if (!cfg.host) {
    throw new Error("SMTP not configured");
  }
  const transporter = createTransporter(cfg);
  try {
    const info = await transporter.sendMail(buildMailOptions(cfg, input));
    return { messageId: info.messageId, response: info.response };
  } finally {
    transporter.close();
  }
}

/**
 * Send one notification email via the Resend HTTP API. Throws on any
 * failure (timeout, 4xx/5xx, "Resend API key not configured").
 *
 * `RESEND_FROM` must be a verified sender on the Resend account. When
 * unset it defaults to Resend's sandbox sender `onboarding@resend.dev`,
 * which Resend only delivers to the account-owner's email — set a
 * verified `RESEND_FROM` (e.g. `notifications@yourdomain.com`) for real
 * recipients.
 */
export async function sendEmailViaResend(
  input: EmailSendInput,
): Promise<EmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Resend API key not configured");
  }
  const from =
    process.env.RESEND_FROM || "WhatsApp Max <onboarding@resend.dev>";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: sanitizeHeaderLine(input.subject),
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      }),
      signal: controller.signal,
    });

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
    };

    if (!res.ok) {
      throw new Error(
        `Resend ${res.status}: ${data.message || "request failed"}`,
      );
    }
    return { messageId: data.id };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one notification email through whichever provider is configured
 * (Resend if an API key is set, else SMTP). Never called from the flow
 * engine's synchronous path.
 */
export async function sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
  if (process.env.RESEND_API_KEY) {
    return sendEmailViaResend(input);
  }
  if (getSmtpConfig().host) {
    return sendEmailViaSmtp(input);
  }
  throw new Error("Email provider not configured (set RESEND_API_KEY or SMTP_HOST)");
}