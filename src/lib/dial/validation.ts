// ============================================================
// Click-to-Dial phone validation — shared by the Workspace Dial
// action column and the dial-request API routes.
//
// Rules (per feature spec):
// - Preserve a valid international `+` prefix; never invent a
//   country code for ambiguous numbers.
// - Empty, placeholder, or malformed values are not dialable.
// - Display values keep their canonical form; only the tel: URI
//   and the stored request use the normalized form.
// ============================================================

const PLACEHOLDER_VALUES = new Set([
  'n/a',
  'na',
  'nil',
  'null',
  'undefined',
  'none',
  '-',
  '--',
  '---',
  'test',
  'unknown',
  'tbd',
]);

/**
 * Normalized dial candidate: trims whitespace, removes common
 * visual separators (spaces, dashes, dots, parens, slashes),
 * preserves a single leading `+`, drops extensions (`x123`, `ext`).
 */
export function normalizeDialNumber(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  let value = String(raw).trim();
  if (!value) return '';
  // Strip common extension suffixes: "x123", "ext 123", ";123".
  value = value.replace(/\s*(ext\.?|x)\s*\d+\s*$/i, '').trim();
  value = value.split(';')[0]?.trim() ?? '';
  const hasPlus = value.startsWith('+');
  const digits = value.replace(/\D/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

/** True when the value is an obvious non-number placeholder. */
export function isPlaceholderPhone(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const trimmed = String(raw).trim();
  if (!trimmed) return true;
  const lowered = trimmed.toLowerCase();
  if (PLACEHOLDER_VALUES.has(lowered)) return true;
  // All-same-digit (0000000, 1111111111) and 12345… sequences.
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  if (/^(12345|123456|01234)/.test(digits) && digits.length <= 10) return true;
  return false;
}

/**
 * Whether the raw row value may be dialed. Requires 7–15 digits
 * (E.164 range) after normalization; preserves `+` when present
 * but never adds one.
 */
export function isDialablePhoneNumber(raw: string | null | undefined): boolean {
  if (isPlaceholderPhone(raw)) return false;
  const normalized = normalizeDialNumber(raw);
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (!/^[1-9]/.test(digits)) return false;
  return true;
}

/** `tel:` URI for same-device dialing (ACTION_DIAL equivalent). */
export function toTelUri(raw: string | null | undefined): string | null {
  if (!isDialablePhoneNumber(raw)) return null;
  const normalized = normalizeDialNumber(raw);
  return `tel:${normalized}`;
}
