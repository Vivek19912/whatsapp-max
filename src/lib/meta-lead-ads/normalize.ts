// ============================================================
// Meta Lead Ads — lead normalization.
//
// Meta returns a lead as `field_data: [{ name, values: [] }]`.
// Form schemas differ wildly (standard contact fields, custom
// questions, single vs multi-value), so we NEVER hardcode a form's
// questions: keys are derived from the response itself and the
// standard name/phone/email are only read when a matching key is
// present. Values are flattened deterministically; arrays join with
// ", " so a multi-select answer survives as readable text.
//
// Pure and dependency-free — unit tested directly.
// ============================================================

import type { MetaLeadFieldDatum } from "./graph-client";

export interface NormalizedLead {
  /** question key → display value (missing fields simply absent). */
  answers: Record<string, string>;
  standard: {
    name: string | null;
    phone: string | null;
    email: string | null;
  };
}

/** Stable var_key from a Meta question/field key or label. */
export function sanitizeQuestionKey(raw: string | null | undefined, index: number): string {
  const clean = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean !== "" ? clean : `question_${index}`;
}

const PHONE_KEYS = ["phone_number", "phone", "mobile", "mobile_number", "whatsapp_number"];
const EMAIL_KEYS = ["email", "email_address"];
const FULL_NAME_KEYS = ["full_name", "name", "fullname"];
const FIRST_NAME_KEYS = ["first_name", "firstname"];
const LAST_NAME_KEYS = ["last_name", "lastname"];

/**
 * Sanitized answer keys that resolve into the system identity columns
 * (standardContactFromAnswers reads exactly these sets). Used to
 * recognize a dynamic Instant Form question column as a duplicate of
 * the system Name / Phone Number columns — identity, never the
 * displayed label.
 */
export const META_IDENTITY_ANSWER_KEYS: ReadonlySet<string> = new Set([
  ...FULL_NAME_KEYS,
  ...PHONE_KEYS,
]);

function coerceValue(values: string[] | undefined): string | null {
  if (!Array.isArray(values)) return null;
  const parts = values
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v !== "");
  if (parts.length === 0) return null;
  return parts.join(", ");
}

function pick(answers: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = answers[key];
    if (value && value.trim() !== "") return value;
  }
  return null;
}

export interface StandardContact {
  name: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Resolve the standard contact fields from an already-normalized
 * answer map (question key → value). Missing keys stay null — a
 * value is NEVER invented. Shared by ingestion (from `field_data`)
 * and the Workspace read path (from `flow_runs.vars`), so both
 * resolve the same standard fields from the same keys.
 */
export function standardContactFromAnswers(
  answers: Record<string, string | null | undefined> | null | undefined,
): StandardContact {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers ?? {})) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") values[key] = trimmed;
  }

  let name = pick(values, FULL_NAME_KEYS);
  if (!name) {
    const first = pick(values, FIRST_NAME_KEYS);
    const last = pick(values, LAST_NAME_KEYS);
    const combined = [first, last].filter(Boolean).join(" ").trim();
    name = combined !== "" ? combined : null;
  }

  return {
    name,
    phone: pick(values, PHONE_KEYS),
    email: pick(values, EMAIL_KEYS),
  };
}

/**
 * Normalize Meta `field_data` into a stable answers map plus the
 * best-effort standard contact fields. Keys that collide after
 * sanitization keep the FIRST value (Meta never emits colliding
 * keys, but this keeps the result deterministic if it ever does).
 */
export function normalizeLeadFieldData(
  fieldData: MetaLeadFieldDatum[] | null | undefined,
): NormalizedLead {
  const answers: Record<string, string> = {};
  const rows = Array.isArray(fieldData) ? fieldData : [];
  rows.forEach((row, index) => {
    const value = coerceValue(row?.values);
    if (value === null) return;
    const key = sanitizeQuestionKey(row?.name, index);
    if (!(key in answers)) answers[key] = value;
  });

  return {
    answers,
    standard: standardContactFromAnswers(answers),
  };
}

/** Meta's `platform` field → our source enum (unknown when absent). */
export function sourceFromPlatform(
  platform: string | null | undefined,
): "facebook" | "instagram" | "unknown" {
  const value = (platform ?? "").trim().toLowerCase();
  // Meta returns the short codes `fb` / `ig` on the Lead node; accept
  // the long names too (docs/exports and older payloads use them).
  if (value === "fb" || value === "facebook") return "facebook";
  if (value === "ig" || value === "instagram") return "instagram";
  return "unknown";
}

/** Display label for the Workspace Source column. Unknown stays
 *  explicitly unattributed — never guessed as Facebook/Instagram. */
export function sourceLabel(
  source: "facebook" | "instagram" | "unknown",
): string {
  if (source === "facebook") return "Facebook";
  if (source === "instagram") return "Instagram";
  return "Other";
}

/**
 * Fallback source inference from the form's questions when Meta
 * omits `platform`. Only reliable signals are used; anything else
 * stays "unknown" (never guessed).
 */
export function inferSourceFromQuestions(
  questionKeys: string[],
): "facebook" | "instagram" | "unknown" {
  const lowered = questionKeys.map((k) => k.trim().toLowerCase());
  if (lowered.some((k) => k.includes("instagram"))) return "instagram";
  return "unknown";
}
