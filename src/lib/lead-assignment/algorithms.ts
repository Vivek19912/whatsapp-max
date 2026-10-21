// ============================================================
// Lead Assignment algorithms — Round Robin (RR) and Smooth
// Weighted Round Robin (SWRR) as separate, pure backend services.
//
// Pure and dependency-free: no I/O, no database, no application
// imports. Persistence, concurrency, and rule resolution live in
// service.ts; these functions only compute the next selection from
// explicit state, so every sequence below is unit-testable and
// deterministic.
//
// Strictly separate from Chat Assignment (src/lib/assignment):
// nothing is imported from or shared with that engine.
// ============================================================

export interface WeightedMember {
  userId: string;
  /** Configured percentage weight 0-100 (the admin's percentages). */
  weight: number;
}

/** Monotonic RR cursor. Never reset by readers — it only advances. */
export interface RRPickerState {
  cursor: number;
}

export interface RRSelection {
  userId: string;
  /** Cursor value to persist (always cursor + 1). */
  nextCursor: number;
}

/**
 * Equal Round Robin: distribute sequentially in configured order,
 * wrapping after the last member. `members` must already be the
 * ELIGIBLE pool in configured order; `cursor` is the persisted
 * monotonic counter. Returns null when nobody is eligible —
 * callers leave the lead unassigned.
 */
export function roundRobinNext(
  members: readonly string[],
  cursor: number,
): RRSelection | null {
  if (members.length === 0) return null;
  const safeCursor = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0;
  const index = safeCursor % members.length;
  return { userId: members[index], nextCursor: safeCursor + 1 };
}

/** Persisted SWRR running weights, keyed by member user_id. */
export interface SWRRPickerState {
  current: Record<string, number>;
}

export interface SWRRSelection {
  userId: string;
  /** Full replacement running-weight map to persist atomically. */
  nextCurrent: Record<string, number>;
}

/**
 * Smooth Weighted Round Robin (deterministic, never random):
 *   1. add each eligible member's configured weight to its current
 *      weight (missing entries start at 0);
 *   2. select the eligible member with the highest current weight
 *      (ties break by configured member order);
 *   3. subtract the sum of the eligible members' configured weights
 *      from the selected member's current weight.
 *
 * Only members with weight > 0 can ever be selected, so a 0%
 * member never receives a lead. Weights are renormalized over the
 * CURRENT eligible pool (zero-weight and ineligible members simply
 * contribute nothing), while the saved configuration is untouched —
 * the original allocation resumes when a member returns.
 * Returns null when no eligible member carries weight > 0.
 */
export function swrrNext(
  members: readonly WeightedMember[],
  current: Record<string, number> | null | undefined,
): SWRRSelection | null {
  const pool = members.filter(
    (m) => typeof m.userId === "string" && m.userId !== "" && m.weight > 0,
  );
  if (pool.length === 0) return null;
  const next: Record<string, number> = { ...(current ?? {}) };
  for (const m of pool) {
    const prior = typeof next[m.userId] === "number" ? next[m.userId] : 0;
    next[m.userId] = prior + m.weight;
  }
  let selected = pool[0];
  for (const m of pool) {
    if (next[m.userId] > next[selected.userId]) selected = m;
  }
  const eligibleTotal = pool.reduce((sum, m) => sum + m.weight, 0);
  next[selected.userId] = next[selected.userId] - eligibleTotal;
  return { userId: selected.userId, nextCurrent: next };
}
