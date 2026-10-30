// ============================================================
// Workspace table filters — pure model (no React, no I/O).
//
// All filters are server-side (the table is server-paginated via
// get_flow_table_rows; rows are never fanned out to the browser
// for filtering):
//
//   1. DATE — operates on the existing Submission Time
//      (flow_runs.started_at, TIMESTAMPTZ). Presets resolve to a
//      half-open [from, to) UTC range computed in the viewer's
//      LOCAL timezone — the same tz the table uses to display
//      Submission Time — so "Today" means the user's local today.
//      No second date field is created anywhere.
//   2. ASSIGNEE — operates on the existing "Assigned To" column.
//      Options derive from the live account roster (Settings →
//      Team Members via GET /api/account/members): All,
//      Unassigned, plus one entry per current member keyed by the
//      stable user_id. Filtering matches workspace_values
//      .value_text by ID equality — display names are never used
//      as filter keys.
//   3. COLUMN FILTERS — operate on five existing business columns
//      ("Call Status", "No. of Calls Tried", "Follow-Up Status",
//      "Last Contact Date", "Next Follow-up Date & Time") by
//      matching workspace_values.value_text against the STORED
//      values (never display labels, positions, or field ids from
//      the browser — field identity resolves server-side by
//      case-insensitive name). Categorical sections use OR within
//      the section; every section combines conjunctively (AND).
//
// Combination is conjunctive (AND) across all filters.
// Pagination, row numbering, views, search, visibility, pin/hide,
// and ordering are preserved because filtering happens inside the
// paginated RPC: total + page slice are computed AFTER all
// predicates.
//
// Timezones: date-only bounds ("Last Contact Date" stores
// canonical YYYY-MM-DD) compare as calendar days — tz-free.
// Datetime bounds ("Next Follow-up Date & Time" stores canonical
// UTC ISO via toISOString()) are UTC instants; day-scoped modes
// (specific date, range, today) resolve from the viewer's LOCAL
// midnights — the same tz the table uses to display the cells —
// so "Today" means the user's local today.
//
// No member names, emails, UUIDs, or roles are hardcoded here.
// ============================================================

import type { AssigneeMember } from "./workspace-assignee";
import { assigneeDisplayName } from "./workspace-assignee";

// ------------------------------------------------------------
// Date filter
// ------------------------------------------------------------

export const WORKSPACE_DATE_PRESETS = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "custom",
] as const;

export type WorkspaceDatePreset = (typeof WORKSPACE_DATE_PRESETS)[number];

export const WORKSPACE_DATE_PRESET_LABELS: Record<WorkspaceDatePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last30: "Last 30 days",
  custom: "Custom",
};

export function isWorkspaceDatePreset(value: unknown): value is WorkspaceDatePreset {
  return (
    typeof value === "string" &&
    (WORKSPACE_DATE_PRESETS as readonly string[]).includes(value)
  );
}

/** Applied date range: half-open [from, to) ISO instants, or null = no filter. */
export interface WorkspaceDateRange {
  from: string;
  to: string;
}

/** Midnight of the given local day, plus calendar-day arithmetic (DST-safe). */
function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addLocalDays(midnight: Date, n: number): Date {
  return new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + n);
}

/**
 * Resolve a date preset to a half-open [from, to) range.
 * Bounds are local-midnight-derived, serialized as UTC ISO
 * instants for TIMESTAMPTZ comparison server-side.
 *
 *   today      → local today 00:00 → tomorrow 00:00
 *   yesterday  → yesterday 00:00 → today 00:00
 *   last7      → 6 days ago 00:00 → tomorrow 00:00 (7 days incl. today)
 *   last30     → 29 days ago 00:00 → tomorrow 00:00 (30 days incl. today)
 *   custom     → from-date 00:00 → (to-date + 1) 00:00, both inclusive
 *
 * `now` defaults to the current time (injectable for tests).
 * Custom dates are "YYYY-MM-DD" calendar days; throws when
 * missing, malformed, non-calendar, or from > to.
 */
export function resolveWorkspaceDateRange(
  preset: WorkspaceDatePreset,
  custom: { from?: string | null; to?: string | null },
  now: Date = new Date(),
): WorkspaceDateRange | null {
  // "All" is represented by the caller as null (no preset) — this
  // resolver only handles concrete presets.
  const today = localMidnight(now);
  switch (preset) {
    case "today":
      return { from: today.toISOString(), to: addLocalDays(today, 1).toISOString() };
    case "yesterday":
      return {
        from: addLocalDays(today, -1).toISOString(),
        to: today.toISOString(),
      };
    case "last7":
      return {
        from: addLocalDays(today, -6).toISOString(),
        to: addLocalDays(today, 1).toISOString(),
      };
    case "last30":
      return {
        from: addLocalDays(today, -29).toISOString(),
        to: addLocalDays(today, 1).toISOString(),
      };
    case "custom": {
      const fromDay = parseCustomDay(custom.from);
      const toDay = parseCustomDay(custom.to);
      if (!fromDay || !toDay) {
        throw new Error("Choose both a From and a To date.");
      }
      if (fromDay.getTime() > toDay.getTime()) {
        throw new Error("The From date must be on or before the To date.");
      }
      return { from: fromDay.toISOString(), to: addLocalDays(toDay, 1).toISOString() };
    }
  }
}

/** Strict YYYY-MM-DD → local midnight, or null when absent/invalid. */
function parseCustomDay(value: string | null | undefined): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt;
}

/** Validate a resolved range (ISO datetimes, from <= to). Throws on invalid. */
export function validateWorkspaceDateRange(range: {
  from: unknown;
  to: unknown;
}): WorkspaceDateRange {
  if (typeof range.from !== "string" || typeof range.to !== "string") {
    throw new Error("Invalid date filter.");
  }
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new Error("Invalid date filter.");
  }
  if (fromMs > toMs) {
    throw new Error("The From date must be on or before the To date.");
  }
  return { from: range.from, to: range.to };
}

// ------------------------------------------------------------
// Assignee filter
// ------------------------------------------------------------

export const WORKSPACE_ASSIGNEE_ALL = "all";
export const WORKSPACE_ASSIGNEE_UNASSIGNED = "unassigned";

/**
 * Applied assignee selection. `all` = no filter. `unassigned` =
 * rows with no real assignment (no value row, or cleared /
 * "Unassigned"). `{ type: "member", userId }` matches
 * workspace_values.value_text by stable ID equality.
 */
export type WorkspaceAssigneeSelection =
  | { type: "all" }
  | { type: "unassigned" }
  | { type: "member"; userId: string };

export const ALL_ASSIGNEES: WorkspaceAssigneeSelection = { type: "all" };

/**
 * Dropdown rows for the Assigned-To FILTER: All + Unassigned +
 * one entry per CURRENT account member, in roster order. Unlike
 * the cell editor there is no Clear item and no preserved entry —
 * a removed member must not appear for new filtering, so unknown
 * stored values are never listed here.
 */
export interface AssigneeFilterOption {
  value: string;
  label: string;
  kind: "all" | "unassigned" | "member";
}

export function buildAssigneeFilterOptions(
  members: readonly AssigneeMember[],
): AssigneeFilterOption[] {
  const options: AssigneeFilterOption[] = [
    { value: WORKSPACE_ASSIGNEE_ALL, label: "All", kind: "all" },
    { value: WORKSPACE_ASSIGNEE_UNASSIGNED, label: "Unassigned", kind: "unassigned" },
  ];
  for (const m of members) {
    options.push({ value: m.user_id, label: assigneeDisplayName(m), kind: "member" });
  }
  return options;
}

/** Serialize a selection to its wire value (member → stable user_id). */
export function serializeAssigneeSelection(sel: WorkspaceAssigneeSelection): string {
  switch (sel.type) {
    case "all":
      return WORKSPACE_ASSIGNEE_ALL;
    case "unassigned":
      return WORKSPACE_ASSIGNEE_UNASSIGNED;
    case "member":
      return sel.userId;
  }
}

/**
 * Parse the `assignee` query param. "all" (or absent) = no
 * filter; "unassigned" = unassigned; any other non-empty string
 * is a member user_id matched by ID equality server-side
 * (unknown/foreign IDs simply match nothing — account isolation
 * holds because the match runs inside the account-scoped RPC).
 */
export function parseAssigneeParam(value: unknown): WorkspaceAssigneeSelection {
  if (value === null || value === undefined) return ALL_ASSIGNEES;
  if (typeof value !== "string") throw new Error("Invalid assignee filter.");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === WORKSPACE_ASSIGNEE_ALL) {
    return ALL_ASSIGNEES;
  }
  if (trimmed.toLowerCase() === WORKSPACE_ASSIGNEE_UNASSIGNED) {
    return { type: "unassigned" };
  }
  return { type: "member", userId: trimmed };
}

// ------------------------------------------------------------
// Column filters (five business columns)
// ------------------------------------------------------------

/**
 * Canonical stored names of the five filterable business columns
 * (lowercased + trimmed). The RPC resolves field identity by this
 * same rule, and the panel offers each column's own live options —
 * never hardcoded values, never positional indexes.
 */
export const COLUMN_FILTER_FIELD_NAMES = {
  callStatus: "call status",
  callsTried: "no. of calls tried",
  followUpStatus: "follow-up status",
  lastContactDate: "last contact date",
  nextFollowUp: "next follow-up date & time",
} as const;

/** True for one of the five filterable business columns. */
export function isColumnFilterFieldName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const key = name.trim().toLowerCase();
  return (Object.values(COLUMN_FILTER_FIELD_NAMES) as string[]).includes(key);
}

/** Maximum selected values per categorical section (abuse guard). */
export const COLUMN_FILTER_VALUES_MAX = 50;
/** Maximum length of one categorical value (matches option max). */
export const COLUMN_FILTER_VALUE_MAX = 80;
/** Numeric domain guard for call-count inputs. */
export const CALLS_TRIED_MIN = 0;
export const CALLS_TRIED_MAX = 999;

export const CALLS_TRIED_OPS = ["eq", "gt", "lt", "between"] as const;

export type CallsTriedOp = (typeof CALLS_TRIED_OPS)[number];

export function isCallsTriedOp(value: unknown): value is CallsTriedOp {
  return (
    typeof value === "string" &&
    (CALLS_TRIED_OPS as readonly string[]).includes(value)
  );
}

export const CALLS_TRIED_OP_LABELS: Record<CallsTriedOp, string> = {
  eq: "Equals",
  gt: "Greater than",
  lt: "Less than",
  between: "Between",
};

/** Numeric call-count condition. Absent value/min/max = incomplete. */
export interface CallsTriedFilter {
  op: CallsTriedOp;
  value?: number;
  min?: number;
  max?: number;
}

function parseCallsTriedInt(raw: unknown, what: string): number {
  // Number("") is 0 — blank inputs must fail, not filter for 0.
  const text = typeof raw === "number" ? null : String(raw ?? "").trim();
  if (text !== null && text === "") {
    throw new Error(
      `${what} must be a whole number between ${CALLS_TRIED_MIN} and ${CALLS_TRIED_MAX}.`,
    );
  }
  const num = typeof raw === "number" ? raw : Number(text);
  if (!Number.isInteger(num) || num < CALLS_TRIED_MIN || num > CALLS_TRIED_MAX) {
    throw new Error(
      `${what} must be a whole number between ${CALLS_TRIED_MIN} and ${CALLS_TRIED_MAX}.`,
    );
  }
  return num;
}

/**
 * Resolve a call-count condition to its normalized form. Throws on
 * missing/non-numeric/out-of-range inputs or min > max — callers
 * surface the message (toast) and never apply a half filter.
 */
export function resolveCallsTriedFilter(
  op: CallsTriedOp,
  inputs: { value?: unknown; min?: unknown; max?: unknown },
): CallsTriedFilter {
  switch (op) {
    case "eq":
    case "gt":
    case "lt":
      return { op, value: parseCallsTriedInt(inputs.value, "Call count") };
    case "between": {
      const min = parseCallsTriedInt(inputs.min, "Min calls");
      const max = parseCallsTriedInt(inputs.max, "Max calls");
      if (min > max) {
        throw new Error("Min calls must be on or below max calls.");
      }
      return { op, min, max };
    }
  }
}

/** Strict YYYY-MM-DD + real calendar day (viewer-tz-free). */
export function isCalendarDateString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/** Calendar-day arithmetic in UTC (DST-free) → YYYY-MM-DD. */
function addCalendarDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Shift a YYYY-MM-DD calendar day by n days (DST-free). Used to
 * restore range inputs from normalized half-open bounds (whose
 * `to` is already exclusive, i.e. one past the shown To day).
 */
export function shiftCalendarDay(day: string, n: number): string {
  return addCalendarDays(day, n);
}

/** Pad a date/time component to two digits. */
function pad2(v: number): string {
  return String(v).padStart(2, "0");
}

/**
 * UTC ISO instant → viewer-local YYYY-MM-DD (the same tz date
 * inputs and cell display use). Round-trips resolveFollowUpFilter
 * day bounds exactly.
 */
export function isoToLocalDay(iso: string): string {
  const dt = new Date(iso);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/**
 * UTC ISO instant → viewer-local YYYY-MM-DDTHH:mm for
 * datetime-local inputs. Round-trips before/after bounds (inputs
 * carry minute precision; seconds normalize away on apply).
 */
export function isoToLocalDateTime(iso: string): string {
  const dt = new Date(iso);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

export const COLUMN_DATE_MODES = ["date", "range", "before", "after"] as const;

export type ColumnDateMode = (typeof COLUMN_DATE_MODES)[number];

export function isColumnDateMode(value: unknown): value is ColumnDateMode {
  return (
    typeof value === "string" &&
    (COLUMN_DATE_MODES as readonly string[]).includes(value)
  );
}

export const COLUMN_DATE_MODE_LABELS: Record<ColumnDateMode, string> = {
  date: "Specific date",
  range: "Date range",
  before: "Before a date",
  after: "After a date",
};

/**
 * Last-Contact-Date filter: calendar-day bounds, half-open
 * [from, to) — specific date D covers [D, D+1), ranges are
 * inclusive on both ends, before-D is [..., D), after-D is
 * [D, ...). Null side = open-ended. Throws on missing,
 * malformed, non-calendar, or inverted inputs.
 */
export interface ColumnDateFilter {
  mode: ColumnDateMode;
  from: string | null;
  to: string | null;
}

export function resolveColumnDateFilter(
  mode: ColumnDateMode,
  inputs: { from?: unknown; to?: unknown },
): ColumnDateFilter {
  const dayOrNull = (raw: unknown): string | null => {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    return raw.trim();
  };
  const fromDay = dayOrNull(inputs.from);
  const toDay = dayOrNull(inputs.to);
  switch (mode) {
    case "date": {
      if (!fromDay || !isCalendarDateString(fromDay)) {
        throw new Error("Choose a valid date (YYYY-MM-DD).");
      }
      return { mode, from: fromDay, to: addCalendarDays(fromDay, 1) };
    }
    case "range": {
      if (!fromDay || !isCalendarDateString(fromDay) || !toDay || !isCalendarDateString(toDay)) {
        throw new Error("Choose both a valid From and To date.");
      }
      if (fromDay > toDay) {
        throw new Error("The From date must be on or before the To date.");
      }
      return { mode, from: fromDay, to: addCalendarDays(toDay, 1) };
    }
    case "before": {
      if (!toDay || !isCalendarDateString(toDay)) {
        throw new Error("Choose a valid date (YYYY-MM-DD).");
      }
      return { mode, from: null, to: toDay };
    }
    case "after": {
      if (!fromDay || !isCalendarDateString(fromDay)) {
        throw new Error("Choose a valid date (YYYY-MM-DD).");
      }
      return { mode, from: fromDay, to: null };
    }
  }
}

export const FOLLOW_UP_MODES = [
  ...COLUMN_DATE_MODES,
  "today",
  "overdue",
  "upcoming",
] as const;

export type FollowUpMode = (typeof FOLLOW_UP_MODES)[number];

export function isFollowUpMode(value: unknown): value is FollowUpMode {
  return (
    typeof value === "string" &&
    (FOLLOW_UP_MODES as readonly string[]).includes(value)
  );
}

export const FOLLOW_UP_MODE_LABELS: Record<FollowUpMode, string> = {
  date: "Specific date",
  range: "Date range",
  before: "Before a date/time",
  after: "After a date/time",
  today: "Today",
  overdue: "Overdue",
  upcoming: "Upcoming",
};

/** Strict datetime-local shape (YYYY-MM-DDTHH:mm, viewer-local wall clock). */
export function isDateTimeLocalString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const [, y, mo, d, hh, mm] = match.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return false;
  const dt = new Date(y, mo - 1, d, hh, mm);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === mo - 1 &&
    dt.getDate() === d &&
    dt.getHours() === hh &&
    dt.getMinutes() === mm
  );
}

/**
 * Next-Follow-up filter: half-open [from, to) UTC ISO instants.
 * Stored datetimes normalize to toISOString() on write, so bounds
 * normalize the same way — instant comparison, no tz skew:
 *   date/range/today resolve from viewer-LOCAL midnights (the tz
 *     the cells display in);
 *   overdue  → [..., now) — a set follow-up earlier than now;
 *   upcoming → [now, ...] — a set follow-up at/after now.
 * Rows with no (or unparsable) follow-up never match a datetime
 * predicate — empties are handled separately from dated rows.
 * `now` defaults to the current time (injectable for tests).
 */
export interface FollowUpFilter {
  mode: FollowUpMode;
  from: string | null;
  to: string | null;
}

export function resolveFollowUpFilter(
  mode: FollowUpMode,
  inputs: { from?: unknown; to?: unknown },
  now: Date = new Date(),
): FollowUpFilter {
  const isoOrThrow = (raw: unknown, what: string): string => {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`${what} is required (YYYY-MM-DD).`);
    }
    const day = raw.trim();
    if (!isCalendarDateString(day)) {
      throw new Error(`${what} must be a valid date (YYYY-MM-DD).`);
    }
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).toISOString();
  };
  const instantOrThrow = (raw: unknown, what: string): string => {
    if (!isDateTimeLocalString(raw)) {
      throw new Error(`${what} must be a valid date and time.`);
    }
    return new Date(String(raw).trim()).toISOString();
  };
  const today = localMidnight(now);
  switch (mode) {
    case "date": {
      const from = isoOrThrow(inputs.from, "Date");
      return {
        mode,
        from,
        to: new Date(new Date(from).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }
    case "range": {
      const fromDay = typeof inputs.from === "string" ? inputs.from.trim() : "";
      const toDay = typeof inputs.to === "string" ? inputs.to.trim() : "";
      if (!isCalendarDateString(fromDay) || !isCalendarDateString(toDay)) {
        throw new Error("Choose both a valid From and To date.");
      }
      if (fromDay > toDay) {
        throw new Error("The From date must be on or before the To date.");
      }
      const from = isoOrThrow(fromDay, "From date");
      const [y, m, d] = toDay.split("-").map(Number);
      const to = new Date(new Date(y, m - 1, d).getTime() + 24 * 60 * 60 * 1000).toISOString();
      return { mode, from, to };
    }
    case "before":
      return { mode, from: null, to: instantOrThrow(inputs.to, "Date and time") };
    case "after":
      return { mode, from: instantOrThrow(inputs.from, "Date and time"), to: null };
    case "today":
      return {
        mode,
        from: today.toISOString(),
        to: addLocalDays(today, 1).toISOString(),
      };
    case "overdue":
      return { mode, from: null, to: now.toISOString() };
    case "upcoming":
      return { mode, from: now.toISOString(), to: null };
  }
}

/**
 * Intersect two half-open [from, to) follow-up windows (null side =
 * unbounded). Used to AND a KPI bucket window with the user's own
 * Next Follow-up column filter without touching the saved
 * selection. An empty intersection collapses to `from === to`
 * (still a valid half-open range that matches nothing, which the
 * API accepts — it only rejects `from > to`).
 */
export function intersectFollowUpRanges(
  a: { from: string | null; to: string | null } | null,
  b: { from: string | null; to: string | null },
): { from: string | null; to: string | null } {
  const froms = [a?.from ?? null, b.from].filter(
    (v): v is string => typeof v === "string",
  );
  const tos = [a?.to ?? null, b.to].filter(
    (v): v is string => typeof v === "string",
  );
  const from = froms.length > 0 ? froms.sort()[froms.length - 1] : null;
  let to: string | null = tos.length > 0 ? tos.sort()[0] : null;
  if (from !== null && to !== null && from > to) to = from;
  return { from, to };
}

/**
 * Applied column filters. Categorical lists use OR within the
 * section (empty = inactive); every non-null section combines
 * with AND. Modes are preserved so the panel restores exactly
 * what was applied.
 */
export interface WorkspaceColumnFilters {
  callStatus: string[];
  callsTried: CallsTriedFilter | null;
  followUpStatus: string[];
  lastContact: ColumnDateFilter | null;
  nextFollowUp: FollowUpFilter | null;
}

/** Fresh inactive column filters (factory — never share/mutate). */
export function emptyColumnFilters(): WorkspaceColumnFilters {
  return {
    callStatus: [],
    callsTried: null,
    followUpStatus: [],
    lastContact: null,
    nextFollowUp: null,
  };
}

/** True when any of the five sections narrows the table. */
export function isColumnFiltersActive(columns: WorkspaceColumnFilters): boolean {
  return (
    columns.callStatus.length > 0 ||
    columns.callsTried !== null ||
    columns.followUpStatus.length > 0 ||
    columns.lastContact !== null ||
    columns.nextFollowUp !== null
  );
}

/** Active section count for the Filters badge (one per section). */
export function countActiveColumnFilters(columns: WorkspaceColumnFilters): number {
  return (
    (columns.callStatus.length > 0 ? 1 : 0) +
    (columns.callsTried !== null ? 1 : 0) +
    (columns.followUpStatus.length > 0 ? 1 : 0) +
    (columns.lastContact !== null ? 1 : 0) +
    (columns.nextFollowUp !== null ? 1 : 0)
  );
}

/**
 * Sanitize one categorical value list for the wire: trimmed,
 * de-duplicated (order-preserving), empties dropped. Throws past
 * the count/length guards.
 */
export function sanitizeFilterValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (v === "" || seen.has(v)) continue;
    if (v.length > COLUMN_FILTER_VALUE_MAX) {
      throw new Error(
        `Filter values must be ${COLUMN_FILTER_VALUE_MAX} characters or fewer.`,
      );
    }
    seen.add(v);
    out.push(v);
  }
  if (out.length > COLUMN_FILTER_VALUES_MAX) {
    throw new Error(
      `At most ${COLUMN_FILTER_VALUES_MAX} values per filter.`,
    );
  }
  return out;
}

/**
 * Serialize applied column filters to table query params.
 * Inactive sections contribute nothing (absent = inactive).
 * Multi-selects use repeated keys (comma-safe for values that
 * legitimately contain commas); the server reads them with
 * getAll.
 */
export function serializeColumnFilters(
  columns: WorkspaceColumnFilters,
): URLSearchParams {
  const qs = new URLSearchParams();
  for (const v of sanitizeFilterValues(columns.callStatus)) {
    qs.append("callStatus", v);
  }
  for (const v of sanitizeFilterValues(columns.followUpStatus)) {
    qs.append("followUpStatus", v);
  }
  if (columns.callsTried) {
    const ct = columns.callsTried;
    qs.set("callsTriedOp", ct.op);
    if (ct.op === "between") {
      qs.set("callsTriedMin", String(ct.min));
      qs.set("callsTriedMax", String(ct.max));
    } else {
      qs.set("callsTriedValue", String(ct.value));
    }
  }
  if (columns.lastContact) {
    if (columns.lastContact.from !== null)
      qs.set("lastContactFrom", columns.lastContact.from);
    if (columns.lastContact.to !== null)
      qs.set("lastContactTo", columns.lastContact.to);
  }
  if (columns.nextFollowUp) {
    if (columns.nextFollowUp.from !== null)
      qs.set("nextFollowUpFrom", columns.nextFollowUp.from);
    if (columns.nextFollowUp.to !== null)
      qs.set("nextFollowUpTo", columns.nextFollowUp.to);
  }
  return qs;
}

/**
 * Deterministic request-key fragment for applied column filters
 * (stable across renders for equal selections).
 */
export function columnFiltersRequestKey(columns: WorkspaceColumnFilters): string {
  return [...serializeColumnFilters(columns).entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
}

// ------------------------------------------------------------
// Combined table query (client → GET /api/flows/[id]/table)
// ------------------------------------------------------------

export interface WorkspaceTableQuery {
  view: string;
  search?: string | null;
  page: number;
  pageSize: number;
  /** Null = no date filter. */
  dateRange: WorkspaceDateRange | null;
  /** Defaults to all. */
  assignee: WorkspaceAssigneeSelection;
  /** Null = no column filters. */
  columns?: WorkspaceColumnFilters | null;
}

/**
 * Compose the table query string. Filter params ride alongside
 * the existing view/search/page/pageSize keys so pagination,
 * search, and views keep working with filters active — the
 * server paginates the FILTERED set, keeping row numbering
 * correct.
 */
export function buildWorkspaceTableQuery(q: WorkspaceTableQuery): string {
  const qs = new URLSearchParams({
    view: q.view,
    page: String(q.page),
    pageSize: String(q.pageSize),
  });
  if (q.search && q.search.trim()) qs.set("search", q.search.trim());
  if (q.dateRange) {
    qs.set("dateFrom", q.dateRange.from);
    qs.set("dateTo", q.dateRange.to);
  }
  const assignee = serializeAssigneeSelection(q.assignee ?? ALL_ASSIGNEES);
  if (assignee !== WORKSPACE_ASSIGNEE_ALL) qs.set("assignee", assignee);
  if (q.columns && isColumnFiltersActive(q.columns)) {
    for (const [k, v] of serializeColumnFilters(q.columns)) {
      // Base keys never collide, so append preserves repeats.
      qs.append(k, v);
    }
  }
  return qs.toString();
}

/** True when any filter narrows the table (drives badges + empty states). */
export function hasActiveWorkspaceFilters(args: {
  dateRange: WorkspaceDateRange | null;
  assignee: WorkspaceAssigneeSelection;
  columns?: WorkspaceColumnFilters | null;
}): boolean {
  return (
    args.dateRange !== null ||
    args.assignee.type !== "all" ||
    (args.columns ? isColumnFiltersActive(args.columns) : false)
  );
}
