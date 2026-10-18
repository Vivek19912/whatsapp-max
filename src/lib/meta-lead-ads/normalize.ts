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

  let name = pick(answers, FULL_NAME_KEYS);
  if (!name) {
    const first = pick(answers, FIRST_NAME_KEYS);
    const last = pick(answers, LAST_NAME_KEYS);
    const combined = [first, last].filter(Boolean).join(" ").trim();
    name = combined !== "" ? combined : null;
  }

  return {
    answers,
    standard: {
      name,
      phone: pick(answers, PHONE_KEYS),
      email: pick(answers, EMAIL_KEYS),
    },
  };
}

/** Meta's `platform` field → our source enum (unknown when absent). */
export function sourceFromPlatform(
  platform: string | null | undefined,
): "facebook" | "instagram" | "unknown" {
  const value = (platform ?? "").trim().toLowerCase();
  if (value === "facebook") return "facebook";
  if (value === "instagram") return "instagram";
  return "unknown";
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
