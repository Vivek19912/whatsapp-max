// Pure helpers for the Workspace Follow-ups view (no DOM, no I/O).
//
// Two independent statuses are never merged here:
//   - WhatsApp reminder delivery: scheduled/processing/sent/failed/cancelled
//   - Sales-work completion: followup_completed_at/by NULL (pending) or set
//
// Bucketing uses an explicit viewer-local day window supplied by the
// caller (the scheduling UI's convention: the agent's browser zone).
// The server receives the window as ISO bounds; tests pin it explicitly.

export type FollowupBucket = "overdue" | "today" | "upcoming" | "completed";

export interface DayWindow {
  /** Inclusive local-day start as an ISO instant. */
  start: string;
  /** Inclusive local-day end as an ISO instant. */
  end: string;
}

export interface BucketRow {
  scheduled_for: string;
  followup_completed_at: string | null;
  followup_completed_by?: string | null;
}

/** Parse an ISO instant; NaN when unparseable (never throws). */
function instantOf(value: string | null | undefined): number {
  if (typeof value !== "string" || value.trim() === "") return NaN;
  return new Date(value).getTime();
}

/**
 * Local-day window for a reference moment, using the VIEWER's local
 * zone (same convention as combineFollowupDateTime/splitFollowupDateTime:
 * what the agent sees is what the buckets use). Pure and injectable
 * for tests via the Date parameter.
 */
export function localDayBounds(now: Date = new Date()): DayWindow {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Classify one follow-up row. Completed (completed_at set) always
 * wins, regardless of the reminder delivery status or schedule —
 * a sent reminder is NOT completed until manually marked.
 */
export function classifyFollowup(
  row: BucketRow,
  window: DayWindow,
): FollowupBucket {
  if (row.followup_completed_at) return "completed";
  const at = instantOf(row.scheduled_for);
  const start = instantOf(window.start);
  const end = instantOf(window.end);
  if (Number.isNaN(at) || Number.isNaN(start) || Number.isNaN(end)) {
    // Unparseable schedule can never be "due": surface as upcoming
    // so it stays visible instead of polluting Overdue.
    return "upcoming";
  }
  if (at < start) return "overdue";
  if (at <= end) return "today";
  return "upcoming";
}

/**
 * Whether a pending row falls inside tomorrow's viewer-local day.
 * Window bounds are supplied by the caller (same convention as the
 * scheduling UI); unparseable schedules never match.
 */
export function isInTomorrow(
  row: BucketRow,
  tomorrow: DayWindow,
): boolean {
  if (row.followup_completed_at) return false;
  const at = instantOf(row.scheduled_for);
  const start = instantOf(tomorrow.start);
  const end = instantOf(tomorrow.end);
  if (Number.isNaN(at) || Number.isNaN(start) || Number.isNaN(end)) return false;
  return at >= start && at <= end;
}

/**
 * Tomorrow's local-day window derived from today's bounds: the
 * 24h starting 1ms after today ends. DST transitions can make a
 * civil tomorrow 23/25h long — callers that need exact civil
 * boundaries should pass an explicit DayWindow instead.
 */
export function deriveTomorrowWindow(today: DayWindow): DayWindow {
  const endMs = instantOf(today.end);
  if (Number.isNaN(endMs)) return today;
  const start = new Date(endMs + 1);
  const end = new Date(endMs + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}
/** Bucket predicate used by list filtering (server + client agree). */
export function inBucket(
  row: BucketRow,
  bucket: FollowupBucket | "all" | "pending",
  window: DayWindow,
): boolean {
  if (bucket === "all") return true;
  const actual = classifyFollowup(row, window);
  if (bucket === "pending") return actual !== "completed";
  return actual === bucket;
}

export interface OrderedRow extends BucketRow {
  followup_completed_at: string | null;
}

/**
 * Actionable ordering: overdue first (earliest first), then due-today
 * by time, then upcoming earliest-first, then completed newest-first.
 * Completed never interleaves with actionable rows.
 */
export function compareFollowups(
  a: OrderedRow,
  b: OrderedRow,
  window: DayWindow,
): number {
  const rank: Record<FollowupBucket, number> = {
    overdue: 0,
    today: 1,
    upcoming: 2,
    completed: 3,
  };
  const ra = rank[classifyFollowup(a, window)];
  const rb = rank[classifyFollowup(b, window)];
  if (ra !== rb) return ra - rb;
  if (ra === 3) {
    // Completed: newest completion first.
    const ta = instantOf(a.followup_completed_at);
    const tb = instantOf(b.followup_completed_at);
    return tb - ta;
  }
  return instantOf(a.scheduled_for) - instantOf(b.scheduled_for);
}

/**
 * Cell-clear guard for manual completion: clear the Workspace
 * `Next Follow-up Date & Time` cell ONLY when it still refers to the
 * completed follow-up's own scheduled instant. A newer re-schedule
 * (different instant) is never clobbered. Instant comparison, not
 * string comparison, so equivalent serializations still match.
 */
export function shouldClearWorkspaceCell(
  cellValue: string | null | undefined,
  rowScheduledFor: string | null | undefined,
): boolean {
  const cell = instantOf(cellValue);
  const row = instantOf(rowScheduledFor);
  if (Number.isNaN(cell) || Number.isNaN(row)) return false;
  return cell === row;
}

export type CompletionDecision =
  | { kind: "already-completed" }
  | { kind: "cancel-and-complete" }
  | { kind: "complete-only" };

/**
 * Pure transition decision for the Complete action:
 * - already has completion metadata → idempotent no-op;
 * - still-scheduled/processing reminder → cancel delivery AND record
 *   completion (guarded update at the call site);
 * - sent/failed/cancelled reminder → record completion only, delivery
 *   history untouched (never rewritten to sent/delivered).
 */
export function decideCompletionUpdate(row: {
  status: string;
  followup_completed_at: string | null;
}): CompletionDecision {
  if (row.followup_completed_at) return { kind: "already-completed" };
  if (row.status === "scheduled" || row.status === "processing") {
    return { kind: "cancel-and-complete" };
  }
  return { kind: "complete-only" };
}
