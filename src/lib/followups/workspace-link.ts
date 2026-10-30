// ============================================================
// Workspace follow-up → reminder link (pure, client-safe).
//
// Meta Lead Ads Tables let agents set a "Next Follow-up Date &
// Time" per lead. Saving it offers a "Create Follow-up Reminder"
// dialog that schedules exactly one linked reminder through the
// EXISTING whatsapp_followups system (same table, lifecycle,
// scheduler, and delivery — nothing parallel).
//
// Association identity: source_kind = 'meta_workspace_followup'
// plus source_run_id = the lead's flow_runs.id, scoped by
// account_id. Manual reminders (both columns NULL) are never
// matched by the link queries, so they keep working unchanged.
//
// Pure and dependency-free — unit tested directly. Flow Tables
// never import this module.
// ============================================================

/** Linkage discriminator stored in whatsapp_followups.source_kind. */
export const WORKSPACE_FOLLOWUP_SOURCE_KIND = "meta_workspace_followup";

/** Canonical Workspace column name carrying the per-lead follow-up. */
export const WORKSPACE_FOLLOWUP_FIELD_NAME = "next follow-up date & time";

/**
 * Viewer-local calendar-day window as UTC ISO instants. The
 * scheduling UI collects dates in the agent's browser zone and
 * stores absolute UTC instants; KPI buckets reuse that exact
 * convention — never a hardcoded zone. DST-safe: the end is
 * derived from the viewer's local midnight, not +24h arithmetic.
 */
export function localDayWindow(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Viewer-local day window N days after today (0 = today).
 * Month/year boundaries fall out of the Date arithmetic.
 */
export function localDayWindowOffset(now: Date, days: number): { start: string; end: string } {
  const shifted = new Date(now);
  shifted.setDate(shifted.getDate() + days);
  return localDayWindow(shifted);
}

export type FollowupKpiBucket = "overdue" | "today" | "tomorrow" | "upcoming";

/**
 * Server-side range for one KPI bucket, as half-open [from, to)
 * UTC ISO bounds over the stored follow-up instant. Bounds come
 * from viewer-local midnights (same convention as the counts
 * endpoint), so KPI filtering and KPI counts always agree:
 * - overdue:  [..., todayStart)
 * - today:    [todayStart, tomorrowStart)
 * - tomorrow: [tomorrowStart, dayAfterStart)
 * - upcoming: [tomorrowStart, ...) — includes tomorrow.
 * Empty/invalid instants never match a bounded range (same rule
 * as the table RPC: the predicate requires a real value).
 */
export function kpiBucketRange(
  bucket: FollowupKpiBucket,
  bounds: { todayStart: string; tomorrowStart: string; dayAfterStart: string },
): { from: string | null; to: string | null } {
  switch (bucket) {
    case "overdue":
      return { from: null, to: bounds.todayStart };
    case "today":
      return { from: bounds.todayStart, to: bounds.tomorrowStart };
    case "tomorrow":
      return { from: bounds.tomorrowStart, to: bounds.dayAfterStart };
    case "upcoming":
      return { from: bounds.tomorrowStart, to: null };
  }
}

/**
 * Whether a workspace field name is the canonical follow-up column.
 * Case/whitespace-insensitive; never matches non-text input.
 */
export function isWorkspaceFollowupFieldName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.trim().toLowerCase() === WORKSPACE_FOLLOWUP_FIELD_NAME
  );
}

/**
 * Default reminder message for a NEW Workspace follow-up: just
 * "<name>, <phone>". Never emits literal "undefined"/"null" and
 * never emits a dangling comma: name-only yields the name,
 * phone-only yields the phone, and neither yields "" (callers
 * treat a blank default as "no default to offer").
 *
 * Only new follow-ups flow through this default. Stored
 * `whatsapp_followups.message_text` rows are never rewritten by
 * changing this builder — there is no backfill.
 */
export function buildWorkspaceFollowupMessage(args: {
  name?: string | null;
  phone?: string | null;
}): string {
  const name = (args.name ?? "").trim();
  const phone = (args.phone ?? "").trim();
  if (name !== "" && phone !== "") return `${name}, ${phone}`;
  return name !== "" ? name : phone;
}

/**
 * Merge a linked reminder's saved message into an open dialog
 * without clobbering the agent: returns the linked message only
 * when the field still holds the untouched default. An explicitly
 * typed value — including a deliberately cleared field — is
 * preserved verbatim.
 */
export function mergeLinkedFollowupMessage(
  current: string,
  defaultMessage: string,
  linkedMessage: string | null | undefined,
): string {
  if (typeof linkedMessage !== "string" || linkedMessage === "") return current;
  return current === defaultMessage ? linkedMessage : current;
}

/**
 * Resolve which (recipient, custom) pair to persist for a
 * Workspace follow-up write.
 *
 * - No explicit value: creating → the profile snapshot
 *   (non-custom); updating → the row's stored pair verbatim, so an
 *   omitted field never rewrites history or flips auto-follow.
 * - Explicit value identical to the stored one → keep the stored
 *   custom flag untouched, so resaving an unchanged dialog never
 *   flips auto-follow rows to custom and never un-marks explicit
 *   overrides.
 * - Explicit value differs from stored → store it, marked custom
 *   only when it also differs from the current Settings number
 *   (reverting to the Settings number restores auto-follow).
 */
export function resolveRecipientUpdate(
  stored: { recipient_phone: string | null; recipient_custom: boolean } | null,
  explicit: string | null,
  profile: string | null,
): { recipient_phone: string | null; recipient_custom: boolean } {
  if (explicit === null) {
    if (!stored) return { recipient_phone: profile, recipient_custom: false };
    return { recipient_phone: stored.recipient_phone, recipient_custom: stored.recipient_custom };
  }
  if (stored && explicit === stored.recipient_phone) {
    return { recipient_phone: explicit, recipient_custom: stored.recipient_custom };
  }
  return { recipient_phone: explicit, recipient_custom: explicit !== profile };
}

/**
 * Local date/time parts for native date + time inputs, derived
 * from a stored ISO instant in the VIEWER's timezone (the same
 * zone the Workspace cell and reminder display use). Returns null
 * when the stored value is missing or unparseable — callers fall
 * back to blank inputs rather than inventing a date.
 */
export function splitFollowupDateTime(
  iso: string | null | undefined,
): { date: string; time: string } | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function parseDateInput(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible calendar dates (e.g. February 30) rather
  // than letting the Date constructor roll over into March.
  const check = new Date(y, m - 1, d);
  if (
    check.getFullYear() !== y ||
    check.getMonth() !== m - 1 ||
    check.getDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

function parseTimeInput(time: string): { h: number; min: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const min = Number(match[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

/**
 * Combine native date + time input values into a single ISO-8601
 * UTC instant. The wall-clock reading is interpreted in the
 * VIEWER's local timezone (via the multi-arg Date constructor, not
 * string parsing), so the stored instant always matches what the
 * agent picked — regardless of the server's timezone. Returns null
 * for missing or malformed inputs. Seconds are always zeroed so
 * repeated saves are stable.
 */
export function combineFollowupDateTime(
  date: string | null | undefined,
  time: string | null | undefined,
): string | null {
  if (typeof date !== "string" || typeof time !== "string") return null;
  const parsedDate = parseDateInput(date);
  const parsedTime = parseTimeInput(time);
  if (!parsedDate || !parsedTime) return null;
  return new Date(
    parsedDate.y,
    parsedDate.m - 1,
    parsedDate.d,
    parsedTime.h,
    parsedTime.min,
    0,
    0,
  ).toISOString();
}

/**
 * Validate a follow-up date/time pair for saving. Returns null when
 * the pair combines to a future instant, otherwise a user-facing
 * error message. `nowMs` defaults to Date.now() (injectable for
 * tests).
 */
export function validateFollowupDateTime(
  date: string | null | undefined,
  time: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (
    typeof date !== "string" ||
    date.trim() === "" ||
    typeof time !== "string" ||
    time.trim() === ""
  ) {
    return "Choose a follow-up date and time.";
  }
  const iso = combineFollowupDateTime(date, time);
  if (iso === null) {
    return "Enter a valid date and time.";
  }
  if (new Date(iso).getTime() <= nowMs) {
    return "Choose a date and time in the future.";
  }
  return null;
}

/**
 * Display formatting for a stored follow-up instant. Mirrors the
 * Workspace datetime cell (day, month, hour, minute in the viewer's
 * locale); invalid input renders an em dash, never "Invalid Date".
 */
export function formatWorkspaceFollowupDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
