// ============================================================
// Meta CRM feedback — matching-identifier resolution (server-only).
//
// Resolves the lead's email/phone, Meta-normalizes them per the
// official customer-information parameter rules, and returns
// SHA-256 hashes ONLY. Raw contact values never leave this module:
// no logs, no errors, no previews, no payloads carry them.
//
// Rules (Conversions API customer information parameters):
//   * em: trim + lowercase, then SHA-256 hex. Basic shape-checked;
//     malformed values are omitted, never "fixed".
//   * ph: strip symbols/letters/leading zeros, then SHA-256 hex.
//     No country code is ever invented — a number that cannot be
//     normalized to enough digits is omitted.
//   * lead_id is NEVER hashed here (exact digits, matched verbatim).
//
// Sources (first hit wins per field): the lead's materialized
// contact (flow_runs.contact_id → contacts), then the stored
// Instant Form answers on the submission. Missing identifiers are
// reported as absent — never invented, never blocking when the
// documented minimum (a valid lead_id) is satisfied.
// ============================================================

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Lowercase hex SHA-256 of one normalized value. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Meta email normalization: trim + lowercase. Returns null when
 * the value is absent or not plausibly an email (omitted, never
 * "fixed" — a mangled hash would poison matching silently).
 */
export function normalizeEmailForMeta(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "" || normalized.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

/**
 * Meta phone normalization: digits only, leading zeros stripped
 * (documented rule). Returns null when fewer than 7 digits remain
 * — without a country code such fragments cannot match and are
 * omitted rather than sent as noise. No country code is invented.
 */
export function normalizePhoneForMeta(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < 7 || digits.length > 16) return null;
  return digits;
}

export interface LeadMatchHashes {
  /** SHA-256 hashes of the normalized email (0–1 entries). */
  em: string[];
  /** SHA-256 hashes of the normalized phone (0–1 entries). */
  ph: string[];
  /** A raw email was present but failed validation (omitted). */
  emailInvalid: boolean;
  /** A raw phone was present but failed normalization (omitted). */
  phoneInvalid: boolean;
}

const EMPTY_MATCH: LeadMatchHashes = { em: [], ph: [], emailInvalid: false, phoneInvalid: false };

function hashFound(rawEmail: unknown, rawPhone: unknown): LeadMatchHashes {
  const email = normalizeEmailForMeta(rawEmail);
  const phone = normalizePhoneForMeta(rawPhone);
  return {
    em: email ? [sha256Hex(email)] : [],
    ph: phone ? [sha256Hex(phone)] : [],
    emailInvalid: rawEmail != null && String(rawEmail).trim() !== "" && email === null,
    phoneInvalid: rawPhone != null && String(rawPhone).trim() !== "" && phone === null,
  };
}

/**
 * Resolve this lead's matching hashes. Reads only; account-scoped
 * on every query. Returns hashes (never raw contact data).
 */
export async function resolveLeadMatchHashes(
  db: SupabaseClient,
  args: { accountId: string; runId: string },
): Promise<LeadMatchHashes> {
  // Primary: the materialized contact linked at capture time.
  const { data: run, error: runErr } = await db
    .from("flow_runs")
    .select("contact_id")
    .eq("id", args.runId)
    .eq("account_id", args.accountId)
    .maybeSingle();
  if (runErr) throw runErr;
  const contactId = (run as { contact_id: string | null } | null)?.contact_id ?? null;
  if (contactId) {
    const { data: contact, error: contactErr } = await db
      .from("contacts")
      .select("email, phone")
      .eq("id", contactId)
      .eq("account_id", args.accountId)
      .maybeSingle();
    if (contactErr) throw contactErr;
    if (contact) {
      const c = contact as { email: string | null; phone: string | null };
      if (c.email || c.phone) return hashFound(c.email, c.phone);
    }
  }

  // Fallback: the stored Instant Form answers on the submission.
  const { data: sub, error: subErr } = await db
    .from("meta_lead_submissions")
    .select("answers, field_data")
    .eq("account_id", args.accountId)
    .eq("flow_run_id", args.runId)
    .maybeSingle();
  if (subErr) throw subErr;
  if (!sub) return { ...EMPTY_MATCH };
  const s = sub as { answers: unknown; field_data: unknown };
  const answers =
    s.answers && typeof s.answers === "object" && !Array.isArray(s.answers)
      ? (s.answers as Record<string, unknown>)
      : null;
  // Answers keys are sanitized question keys; cover the standard
  // contact keys plus common variants without hardcoding a form.
  const pick = (keys: string[]): unknown => {
    if (answers) {
      for (const k of keys) {
        const v = answers[k];
        if (typeof v === "string" && v.trim() !== "") return v;
      }
    }
    if (Array.isArray(s.field_data)) {
      for (const row of s.field_data as Array<{ name?: unknown; values?: unknown }>) {
        const name = typeof row?.name === "string" ? row.name.trim().toLowerCase() : "";
        if (!keys.includes(name)) continue;
        const values = Array.isArray(row?.values) ? row.values : [row?.values];
        for (const v of values) {
          if (typeof v === "string" && v.trim() !== "") return v;
        }
      }
    }
    return null;
  };
  const rawEmail = pick(["email", "email_address", "e_mail"]);
  const rawPhone = pick(["phone", "phone_number", "phonenumber", "mobile", "mobile_number", "contact_number"]);
  if (rawEmail == null && rawPhone == null) return { ...EMPTY_MATCH };
  return hashFound(rawEmail, rawPhone);
}
