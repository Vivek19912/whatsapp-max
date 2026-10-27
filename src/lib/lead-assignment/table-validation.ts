// ============================================================
// Per-table Lead Assignment — input validation, contact checks,
// pause math, and availability helpers.
//
// Pure and client-safe: shared by the API routes (which reject
// invalid input identically) and the settings dialog (which
// validates before sending). No I/O, no database.
//
// Timezone model: assignment is India-only. Every table uses the
// single IANA zone "Asia/Kolkata" (IST) for pause math and
// availability display — "Pause for today" ends at IST midnight,
// and "Paused until <date>" is rendered in IST. Stored pause
// windows are absolute UTC instants, so normalizing a legacy
// per-table zone to IST never shifts an active pause; only future
// calculations and labels use IST. The stored `timezone` column
// (when present from older saves) is normalized to IST on read
// and on save — no migration, no data loss.
// ============================================================

export type TableAssignmentMode = "round_robin" | "percentage";

/**
 * The only timezone assignment uses, everywhere: UI, validation,
 * pause math, and display. A fixed IANA name (never a hardcoded
 * UTC+5:30 offset) so date boundaries resolve through the zone
 * database.
 */
export const ASSIGNMENT_TIMEZONE = "Asia/Kolkata";

export interface TableAssigneeInput {
  /** Internal team member. Null/undefined = external-only recipient. */
  user_id?: unknown;
  display_name?: unknown;
  email?: unknown;
  phone?: unknown;
  weight?: unknown;
  is_active?: unknown;
  notify_email?: unknown;
  notify_whatsapp?: unknown;
}

export interface ValidTableAssignee {
  user_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  weight: number;
  is_active: boolean;
  notify_email: boolean;
  notify_whatsapp: boolean;
}

export interface TableConfigInput {
  enabled?: unknown;
  mode?: unknown;
  /**
   * Legacy per-table zone. Ignored: every table normalizes to
   * {@link ASSIGNMENT_TIMEZONE} on read and on save, so older
   * saved values keep working without a migration.
   */
  timezone?: unknown;
  whatsapp_template_name?: unknown;
  whatsapp_template_language?: unknown;
  assignees?: unknown;
}

export interface ValidTableConfig {
  enabled: boolean;
  mode: TableAssignmentMode;
  timezone: string;
  whatsapp_template_name: string | null;
  whatsapp_template_language: string;
  assignees: ValidTableAssignee[];
}

export type PauseMode = "today" | "days" | "until" | "resume";

export interface PauseInput {
  mode?: unknown;
  days?: unknown;
  until?: unknown;
  reason?: unknown;
  scope?: unknown;
  /**
   * Legacy zone override. Ignored: pauses always compute in
   * {@link ASSIGNMENT_TIMEZONE}, so older callers keep working.
   */
  timezone?: unknown;
}

export interface ValidPause {
  /** Null = resume immediately (clears the window). */
  paused_until: string | null;
  reason: string | null;
  scope: "table" | "account";
  timezone: string;
}

/** Minimal email check: one @, non-empty local + dotted domain. */
export function isValidAssigneeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * E.164 check: leading + then 7–15 digits (ITU-T E.164 allows up
 * to 15 digits; WhatsApp requires the same shape). Spaces, dashes
 * and parentheses are stripped before testing; anything else is
 * rejected. Pure.
 */
export function normalizeAssigneePhone(phone: string): string | null {
  const stripped = phone.replace(/[\s\-().]/g, "");
  if (/^\+\d{7,15}$/.test(stripped)) return stripped;
  return null;
}

/**
 * True for a real IANA timezone (rejects typos like "IST5"). The
 * constructor probe is used instead of
 * `Intl.supportedValuesOf("timeZone")`, whose list is incomplete on
 * small-ICU runtimes (it omits "UTC" there) while formatting
 * itself still honors the full zone database.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * End of "today" in the given zone, as a UTC instant: local
 * 23:59:59.999. Computed from the zone's offset at `now` (handles
 * DST transitions day-by-day rather than assuming +00:00). Pure.
 */
export function endOfTodayUtc(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // en-CA yields YYYY-MM-DD order; recompose explicitly anyway.
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const offsetMs = zoneOffsetMs(timezone, now);
  // Local midnight-end minus the zone offset = UTC instant.
  const dayEndLocalMs = Date.parse(`${day}T23:59:59.999Z`);
  return new Date(dayEndLocalMs - offsetMs).toISOString();
}

/** Offset of `zone` from UTC at `at`, in milliseconds. Pure. */
export function zoneOffsetMs(zone: string, at: Date = new Date()): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // The wall reading resolves whole seconds only, so `at` is
  // floored to the second first: otherwise a millisecond component
  // leaks into the offset and every derived instant ("today"
  // midnight, wall-clock "until") lands up to a second late.
  const atSec = at.getTime() - (((at.getTime() % 1000) + 1000) % 1000);
  const asUtc = Date.parse(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
  );
  return asUtc - atSec;
}

/**
 * "Paused until <date>" label in the given zone, e.g.
 * "Paused until 29 October". Callers always pass
 * {@link ASSIGNMENT_TIMEZONE}; the parameter stays explicit so
 * the pure formatter remains zone-agnostic and testable. Pure.
 */
export function formatPausedUntil(pausedUntil: string, timezone: string): string {
  const at = new Date(pausedUntil);
  if (Number.isNaN(at.getTime())) return "Paused";
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
  }).format(at);
  return `Paused until ${label}`;
}

/**
 * Interpret a zone-less wall-clock reading ("YYYY-MM-DDTHH:mm",
 * as produced by `datetime-local` inputs) in the given IANA zone
 * and return the UTC instant. Offset-less input is the only form
 * that needs a zone; explicit instants (trailing Z or numeric
 * offset) are absolute and returned verbatim. Pure.
 *
 * Offset resolution mirrors `endOfTodayUtc` (wall reading minus
 * the zone's own offset, refined with a second pass so a
 * DST-bearing zone converges). IST has no DST, so the first pass
 * is already exact — the zone database, not a hardcoded +5:30,
 * is the source of truth.
 */
export function wallClockInZoneToUtc(wall: string, zone: string, now: Date = new Date()): number {
  try {
    const m =
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
        wall.trim(),
      );
    if (!m) return NaN;
    const [, y, mo, d, h, mi, s = "00", ms = "000"] = m;
    const asUtc = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
    if (Number.isNaN(asUtc)) return NaN;
    const first = asUtc - zoneOffsetMs(zone, now);
    return asUtc - zoneOffsetMs(zone, new Date(first));
  } catch {
    return NaN;
  }
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

function cleanOptionalString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? null : trimmed;
}

export function validateTableAssignee(
  entry: TableAssigneeInput,
  index: number,
): ValidTableAssignee {
  const where = `Assignee ${index + 1}`;
  const rawUserId =
    typeof entry.user_id === "string" && entry.user_id.trim() !== ""
      ? entry.user_id.trim()
      : null;
  const displayName = cleanString(entry.display_name, 120);
  if (!displayName) throw new Error(`${where} needs a display name (1–120 characters).`);

  const emailRaw = cleanOptionalString(entry.email, 254);
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  if (emailRaw && !isValidAssigneeEmail(email as string)) {
    throw new Error(`${where} has an invalid email address.`);
  }
  const phoneRaw = cleanOptionalString(entry.phone, 32);
  let phone: string | null = null;
  if (phoneRaw) {
    const normalized = normalizeAssigneePhone(phoneRaw);
    if (!normalized) {
      throw new Error(
        `${where} has an invalid phone number. Use international format with country code, e.g. +911234567890.`,
      );
    }
    phone = normalized;
  }
  if (!rawUserId && !email && !phone) {
    throw new Error(
      `${where} needs a team member link or at least an email address or phone number.`,
    );
  }
  // An internal member link without any contact channel is fine
  // (ownership + roster email still work); an external-only
  // recipient needs at least one channel (enforced above).
  const weightRaw = entry.weight;
  const weight =
    typeof weightRaw === "number" && Number.isFinite(weightRaw)
      ? Math.trunc(weightRaw)
      : 0;
  if (weight < 0 || weight > 100) {
    throw new Error(`${where}: percentage must be a whole number from 0 to 100.`);
  }
  return {
    user_id: rawUserId,
    display_name: displayName,
    email,
    phone,
    weight,
    is_active: entry.is_active === undefined ? true : entry.is_active === true,
    notify_email:
      entry.notify_email === undefined ? true : entry.notify_email === true,
    notify_whatsapp:
      entry.notify_whatsapp === undefined ? false : entry.notify_whatsapp === true,
  };
}

/**
 * Validate a whole per-table config. Round robin ignores weights;
 * percentage mode requires the ACTIVE members' weights to total
 * exactly 100 (inactive members are excluded from the total, so
 * deactivating someone forces an explicit re-allocation — never a
 * silent rescale). Never adjusts input.
 */
export function validateTableConfig(input: TableConfigInput): ValidTableConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid assignment settings.");
  }
  const enabled = input.enabled === undefined ? false : input.enabled === true;
  const mode = input.mode ?? "round_robin";
  if (mode !== "round_robin" && mode !== "percentage") {
    throw new Error("Choose Round Robin or Percentage-Based distribution.");
  }
  // India-only: any supplied zone (including legacy per-table
  // values) normalizes to IST. Stored `paused_until` instants are
  // absolute UTC, so this never shifts an active pause.
  const timezoneRaw = ASSIGNMENT_TIMEZONE;
  const templateName = cleanOptionalString(input.whatsapp_template_name, 120);
  const templateLanguage =
    cleanOptionalString(input.whatsapp_template_language, 32) ?? "en_US";

  if (!Array.isArray(input.assignees) || input.assignees.length === 0) {
    if (enabled) throw new Error("Add at least one assignee before enabling automatic assignment.");
    return {
      enabled,
      mode,
      timezone: timezoneRaw,
      whatsapp_template_name: templateName,
      whatsapp_template_language: templateLanguage,
      assignees: [],
    };
  }
  if (input.assignees.length > 50) {
    throw new Error("A table supports at most 50 assignees.");
  }
  const seenUsers = new Set<string>();
  const assignees = (input.assignees as TableAssigneeInput[]).map((entry, index) => {
    const valid = validateTableAssignee(entry ?? {}, index);
    if (valid.user_id) {
      if (seenUsers.has(valid.user_id)) {
        throw new Error("A team member can appear only once per table.");
      }
      seenUsers.add(valid.user_id);
    }
    return valid;
  });

  if (mode === "percentage") {
    // Inactive members are out of the pool: their shares must be
    // re-allocated explicitly across the active members.
    const active = assignees.filter((a) => a.is_active);
    const total = active.reduce((sum, a) => sum + a.weight, 0);
    if (active.length === 0) {
      if (enabled) {
        throw new Error("Enable at least one assignee before enabling automatic assignment.");
      }
    } else if (total !== 100) {
      throw new Error(
        `Active assignees' percentages must total exactly 100% (currently ${total}%).`,
      );
    }
  } else {
    // Round robin ignores weights: normalize to 0 so a later mode
    // switch starts from a clean slate instead of stale shares.
    for (const a of assignees) a.weight = 0;
  }
  return {
    enabled,
    mode,
    timezone: timezoneRaw,
    whatsapp_template_name: templateName,
    whatsapp_template_language: templateLanguage,
    assignees,
  };
}

/**
 * Validate a pause/resume request and compute the UTC window end.
 * `now` is injectable for tests. The zone is always
 * {@link ASSIGNMENT_TIMEZONE}: "today" ends at IST midnight,
 * "days" keeps its duration semantics from now, and a zone-less
 * "until" wall reading is interpreted as IST wall time (explicit
 * instants with Z/offset stay absolute). Never adjusts input.
 */
export function validatePauseInput(input: PauseInput, now: Date = new Date()): ValidPause {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid pause request.");
  }
  // India-only: any supplied zone (including legacy values or
  // typos) normalizes to IST instead of rejecting the request,
  // so existing configurations keep working.
  const timezone = ASSIGNMENT_TIMEZONE;
  const scope = input.scope ?? "table";
  if (scope !== "table" && scope !== "account") {
    throw new Error("Pause scope must be this table or the whole account.");
  }
  const reason = cleanOptionalString(input.reason, 280);
  const mode = input.mode ?? "resume";
  if (mode === "resume") {
    return { paused_until: null, reason: null, scope, timezone };
  }
  if (mode === "today") {
    const until = endOfTodayUtc(timezone, now);
    if (Date.parse(until) <= now.getTime()) {
      throw new Error("Today has already ended in this timezone — pick a future date instead.");
    }
    return { paused_until: until, reason, scope, timezone };
  }
  if (mode === "days") {
    const days =
      typeof input.days === "number" && Number.isFinite(input.days)
        ? Math.trunc(input.days)
        : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error("Pause days must be a whole number from 1 to 365.");
    }
    return {
      paused_until: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
      reason,
      scope,
      timezone,
    };
  }
  if (mode === "until") {
    if (typeof input.until !== "string" || input.until.trim() === "") {
      throw new Error("Choose the date and time the pause ends.");
    }
    const raw = input.until.trim();
    // Explicit instants (Z suffix or numeric offset) are absolute
    // and keep their meaning; a bare wall reading from a
    // `datetime-local` input is IST wall time.
    const hasExplicitOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
    const at = hasExplicitOffset ? Date.parse(raw) : wallClockInZoneToUtc(raw, timezone, now);
    if (Number.isNaN(at)) {
      throw new Error("The resume date and time could not be understood.");
    }
    if (at <= now.getTime()) {
      throw new Error("The resume date and time must be in the future.");
    }
    if (at - now.getTime() > 366 * 24 * 60 * 60 * 1000) {
      throw new Error("Pauses longer than a year are not supported — deactivate instead.");
    }
    return { paused_until: new Date(at).toISOString(), reason, scope, timezone };
  }
  throw new Error("Choose today, a number of days, a resume date, or resume now.");
}
