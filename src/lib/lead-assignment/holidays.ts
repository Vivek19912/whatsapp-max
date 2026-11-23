// ============================================================
// Team Availability — holiday model (pure) + assignment-time loader.
//
// One holiday row = one employee's leave window, evaluated at
// assignment time from DATE columns against the wall-clock date
// in the assignment timezone (Asia/Kolkata — same fixed zone as
// every other assignment rule). No cron, no writes on
// activation/expiry: a holiday simply starts/stops matching.
//
// Display/status rules:
// - cancelled  → "cancelled" (history only, never active)
// - end < today → "completed" (expired automatically)
// - start <= today <= end → "active"
// - start > today → "upcoming"
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { ASSIGNMENT_TIMEZONE } from "./table-validation";

export type HolidayStatus = "upcoming" | "active" | "completed" | "cancelled";

export interface HolidayWindow {
  id: string;
  user_id: string;
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD
  reason?: string | null;
  cancelled_at?: string | null;
}

/** Wall-clock calendar date (YYYY-MM-DD) in the assignment zone. */
export function todayInZone(
  timeZone: string = ASSIGNMENT_TIMEZONE,
  now: number = Date.now(),
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Lifecycle status of one holiday window against a wall-clock date. */
export function holidayStatus(
  h: Pick<HolidayWindow, "start_date" | "end_date" | "cancelled_at">,
  today: string,
): HolidayStatus {
  if (h.cancelled_at) return "cancelled";
  if (h.end_date < today) return "completed";
  if (h.start_date > today) return "upcoming";
  return "active";
}

/** True when the window covers `today` and is not cancelled. */
export function isHolidayActive(
  h: Pick<HolidayWindow, "start_date" | "end_date" | "cancelled_at">,
  today: string,
): boolean {
  return holidayStatus(h, today) === "active";
}

/** True when two inclusive YYYY-MM-DD ranges share at least one day. */
export function rangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Strict YYYY-MM-DD calendar date (real month/day, zero-padded).
 * Returns the normalized string or null when invalid.
 */
export function parseHolidayDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return value;
}

/**
 * Internal user ids with a live (active, non-cancelled) holiday
 * today. DATE columns compare lexicographically — no timestamp
 * pitfalls. Cancelled rows and non-overlapping windows are
 * dropped in code so the caller needs a single account-scoped
 * read (per-account holiday volume is tiny).
 */
export async function loadActiveHolidayUserIds(
  db: SupabaseClient,
  accountId: string,
  today: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await db
    .from("lead_assignment_holidays")
    .select("user_id, start_date, end_date, cancelled_at")
    .eq("account_id", accountId);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    user_id: unknown;
    start_date: unknown;
    end_date: unknown;
    cancelled_at: unknown;
  }>) {
    if (typeof r.user_id !== "string" || r.user_id === "") continue;
    if (typeof r.start_date !== "string" || typeof r.end_date !== "string") continue;
    if (typeof r.cancelled_at === "string" && r.cancelled_at !== "") continue;
    // Inclusive on both ends: active for the whole end date.
    if (r.start_date <= today && today <= r.end_date) out.add(r.user_id);
  }
  return out;
}

export interface AdjustedShare {
  key: string;
  name: string;
  /** Adjusted percentage, 2 decimals, shares sum to exactly 100. */
  percent: number;
}

/**
 * Temporary holiday redistribution of saved percentage weights:
 * each available member keeps its relative proportion
 * (weight / availableTotal × 100), rounded with deterministic
 * largest-remainder to exactly 100.00. Saved weights are never
 * mutated — this is computed at assignment/preview time.
 */
export function normalizeAdjustedPercentages(
  members: ReadonlyArray<{ key: string; name: string; weight: number }>,
): AdjustedShare[] {
  const total = members.reduce((s, m) => s + (m.weight > 0 ? m.weight : 0), 0);
  if (members.length === 0 || total <= 0) return [];
  const exact = members.map((m) => ({
    key: m.key,
    name: m.name,
    share: ((m.weight > 0 ? m.weight : 0) / total) * 100,
  }));
  // Floor to cents, then hand out leftover cents to the largest
  // fractional parts (ties → configured order, never favouring
  // one member systematically across calls).
  const floored = exact.map((e, i) => ({
    ...e,
    index: i,
    cents: Math.floor(e.share * 100 + 1e-9),
    frac: e.share * 100 - Math.floor(e.share * 100 + 1e-9),
  }));
  let leftover = 10000 - floored.reduce((s, f) => s + f.cents, 0);
  const order = [...floored].sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const f of order) {
    if (leftover <= 0) break;
    f.cents += 1;
    leftover -= 1;
  }
  return floored.map((f) => ({
    key: f.key,
    name: f.name,
    percent: f.cents / 100,
  }));
}

/** Round-robin order with holiday members removed (order preserved). */
export function excludeOnHoliday<T extends { key: string }>(
  members: readonly T[],
  onHoliday: ReadonlySet<string>,
): T[] {
  if (onHoliday.size === 0) return [...members];
  return members.filter((m) => !onHoliday.has(m.key));
}
