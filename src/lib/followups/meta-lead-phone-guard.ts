// Meta-lead customer-number guard for follow-up reminders.
//
// Follow-up reminders must go to a team member's WhatsApp number —
// never to a lead. The database function
// public.is_meta_lead_phone (migration 173) is the source of truth:
// given digits-only normalized input it reports whether the number
// belongs to ANY Meta Lead Ads lead of the caller's account (all
// tables, hidden/disabled/history included; contacts only with Meta
// provenance). Matching is exact (digits equality, plus the India
// 10-digit national ≡ 91-prefixed equivalence) — never fuzzy, so
// unrelated numbers are never blocked.
//
// This module holds the shared rejection message + code (so the
// API and the Schedule Follow-up dialog agree exactly) and the
// thin rpc wrapper the creation routes call BEFORE any write.
// Pure digit helpers mirror the SQL rule for unit tests.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Rejection shown beside the Send reminder to field. */
export const META_LEAD_PHONE_ERROR =
  "This number belongs to a lead in your Meta Lead Ads Workspace. Please enter a team member's WhatsApp number.";

/** Machine-readable code carried alongside the rejection. */
export const META_LEAD_PHONE_CODE = "meta_lead_phone";

/**
 * Digits-only form for comparison (mirrors the SQL
 * regexp_replace(v, '\D', '', 'g')). Null for empty/non-strings.
 */
export function toComparablePhoneDigits(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits === "" ? null : digits;
}

/**
 * SQL-rule equivalence in TypeScript (unit-test reference only —
 * production enforcement runs in the database via
 * isMetaLeadPhoneNumber → is_meta_lead_phone):
 * exact digits equality, or India 10-digit national form equal to
 * the 91-prefixed 12-digit form. Never substring/fuzzy.
 */
export function isSameLeadNumber(a: unknown, b: unknown): boolean {
  const da = toComparablePhoneDigits(a);
  const db = toComparablePhoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length === 10 && db === `91${da}`) return true;
  if (db.length === 10 && da === `91${db}`) return true;
  return false;
}

/**
 * True when the normalized digits belong to a Meta lead of the
 * caller's account. Throws on RPC failure (fail closed — never
 * guess, never silently allow).
 */
export async function isMetaLeadPhoneNumber(
  db: SupabaseClient,
  digits: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("is_meta_lead_phone", {
    p_digits: digits,
  });
  if (error) throw error;
  return data === true;
}
