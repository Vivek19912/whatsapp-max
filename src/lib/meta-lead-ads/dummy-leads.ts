// Meta dummy-phone test-lead detection — client-side reference for
// the database rule in supabase/migrations/172 (helper
// public.is_meta_dummy_phone_lead), used by all three Meta Lead Ads
// dashboard RPCs.
//
// Meta sends test leads whose phone-number answer is the literal
// placeholder `<test lead: dummy data for phone_number>`. Such
// leads stay visible in Workspace but are excluded from dashboard
// analytics (server-side, before aggregation — never filtered
// here). This module mirrors the SQL normalization exactly
// (trim → collapse internal whitespace → lowercase) over the same
// standard phone keys (PHONE_KEYS from ./normalize) so unit tests
// pin the rule without a live database.
//
// Specific on purpose: only the exact placeholder (modulo case /
// harmless whitespace) counts. Dummy *names*, missing phones, or
// genuine numbers never match.

import { PHONE_KEYS } from "./normalize";

/** Canonical Meta dummy-phone placeholder (already normalized). */
export const META_DUMMY_PHONE_CANONICAL = "<test lead: dummy data for phone_number>";

/**
 * Normalize one raw phone value exactly like the SQL helper:
 * trim → collapse every internal whitespace run to one space →
 * lowercase. Null for non-strings and empties.
 */
export function normalizePhoneMarker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ").toLowerCase();
  return collapsed === "" ? null : collapsed;
}

/** True only for the exact Meta dummy-phone placeholder (safe variants included). */
export function isDummyPhoneValue(value: unknown): boolean {
  const normalized = normalizePhoneMarker(value);
  return normalized !== null && normalized === META_DUMMY_PHONE_CANONICAL;
}

/**
 * True when any standard phone answer (PHONE_KEYS, same mapping as
 * ingestion's standardContactFromAnswers and the Workspace Phone
 * Number fallback) carries the dummy placeholder.
 */
export function isDummyPhoneLead(
  answers: Record<string, unknown> | null | undefined,
): boolean {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;
  return PHONE_KEYS.some((key) => isDummyPhoneValue((answers as Record<string, unknown>)[key]));
}
