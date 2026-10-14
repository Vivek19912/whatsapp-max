/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * True only for a clearly Indian number: digits are exactly `91`
 * followed by a 10-digit national number. Anything else (short,
 * long, non-numeric, IDs) is never treated as Indian.
 */
export function isIndianCountryCodeNumber(value: string | null | undefined): boolean {
  if (!value) return false
  return /^91\d{10}$/.test(normalizePhone(value))
}

/**
 * DISPLAY ONLY — hide the +91/91 country code for clearly Indian
 * numbers (12 digits starting with 91), showing the 10-digit
 * mobile number. Every other value renders unchanged (non-Indian
 * numbers keep their country code; invalid/ambiguous values are
 * never stripped). Never use the result for storage, messaging,
 * matching, or API payloads — see resolveDialogPhoneForSubmit to map
 * an edited display value back.
 */
export function formatPhoneForDisplay(value: string | null | undefined): string {
  if (!value) return ''
  const digits = normalizePhone(value)
  if (/^91\d{10}$/.test(digits)) return digits.slice(2)
  return value
}

/**
 * Map a dialog phone edit back for submission. The phone input shows
 * the display form (Indian +91 stripped); this resolves what to
 * actually send:
 *   - blank → "" (caller omits the override);
 *   - untouched display value → the EXACT stored prefill (restores
 *     a stripped country code without guessing);
 *   - any user edit → verbatim (trimmed). A country code is never
 *     inferred, added, stripped, or duplicated: `8885638563` stays
 *     `8885638563`, `+91 8885638563` stays as typed.
 */
export function resolveDialogPhoneForSubmit(
  rawPhone: string | null | undefined,
  prefillPhone: unknown,
): string {
  const raw = typeof rawPhone === "string" ? rawPhone.trim() : "";
  if (!raw) return "";
  const canonical =
    typeof prefillPhone === "string" ? prefillPhone.trim() : "";
  if (!canonical) return raw;
  if (raw === formatPhoneForDisplay(canonical)) return canonical;
  return raw;
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}
