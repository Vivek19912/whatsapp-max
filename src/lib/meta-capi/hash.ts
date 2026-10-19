// ============================================================
// Meta Conversions API — customer-information normalization + hashing.
//
// Meta requires SHA-256 hashing (lowercase hex) of personally
// identifiable fields before they are sent, and requires certain
// click identifiers to be sent UN-hashed. These helpers implement the
// current documented rules and are pure (unit-testable, no IO).
//
// Data minimization: we only ever emit fields we actually hold, and
// callers pass a small, explicit set — never the raw lead payload.
// ============================================================

import crypto from "node:crypto";

/** Lowercase hex SHA-256 of the given string. */
export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Meta email normalization: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Meta name normalization: lowercase, strip spaces/punctuation. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}

/** Phone normalization for hashing: digits only (E.164 without '+'). */
export function normalizePhoneForHash(phone: string): string {
  return phone.replace(/\D/g, "");
}

export interface UserDataInput {
  email?: string | null;
  phone?: string | null;
  fullName?: string | null;
  externalId?: string | null;
  ctwaClid?: string | null;
  fbc?: string | null;
  fbp?: string | null;
}

/** Split a display name into first/last for `fn`/`ln`. */
export function splitName(full: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const trimmed = (full ?? "").trim();
  if (!trimmed) return { firstName: null, lastName: null };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Build a Meta `user_data` object. PII (em, ph, fn, ln, external_id) is
 * SHA-256 hashed; click identifiers (ctwa_clid, fbc, fbp) are passed
 * through un-hashed exactly as Meta specifies. Absent fields are
 * omitted entirely.
 */
export function buildUserData(input: UserDataInput): Record<string, string> {
  const out: Record<string, string> = {};

  const email = input.email?.trim();
  if (email) out.em = sha256Hex(normalizeEmail(email));

  const phone = input.phone ? normalizePhoneForHash(input.phone) : "";
  if (phone) out.ph = sha256Hex(phone);

  const { firstName, lastName } = splitName(input.fullName);
  if (firstName) out.fn = sha256Hex(normalizeName(firstName));
  if (lastName) out.ln = sha256Hex(normalizeName(lastName));

  const externalId = input.externalId?.trim();
  if (externalId) out.external_id = sha256Hex(externalId);

  // Click identifiers are NOT hashed.
  if (input.ctwaClid) out.ctwa_clid = input.ctwaClid;
  if (input.fbc) out.fbc = input.fbc;
  if (input.fbp) out.fbp = input.fbp;

  return out;
}
