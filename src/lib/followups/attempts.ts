/**
 * Sequential sales follow-up attempts — shared state model.
 *
 * One row per scheduled attempt in `sales_followup_attempts`
 * (unlimited per lead); state is DERIVED from the row, never
 * stored, so it cannot drift:
 *   unresolved + scheduled_at > now  → scheduled
 *   unresolved + scheduled_at <= now → result_required (no job needed)
 *   completed_at set                → completed
 * Sequence closure lives in `sales_followup_closures`.
 *
 * Sales attempts are deliberately separate from WhatsApp reminders
 * (`whatsapp_followups`): the reminder notifies the salesperson,
 * the attempt tracks the sales interaction and its mandatory
 * result. Pure module — safe for client and server.
 */

/** The eight reportable outcomes, exact display strings. */
export const FOLLOWUP_OUTCOMES = [
  "Connected — Interested",
  "Connected — Not Interested",
  "Call Back Requested",
  "No Answer",
  "Busy",
  "Switched Off",
  "Wrong Number",
  "Other",
] as const;

export type FollowupOutcome = (typeof FOLLOWUP_OUTCOMES)[number];

export function isFollowupOutcome(value: unknown): value is FollowupOutcome {
  return (
    typeof value === "string" &&
    (FOLLOWUP_OUTCOMES as readonly string[]).includes(value)
  );
}

/** Maximum result/notes length (server + client enforced). */
export const FOLLOWUP_RESULT_MAX = 2000;

/** Summary length written into the Customer Response cell. */
export const FOLLOWUP_RESPONSE_SUMMARY_MAX = 160;

export interface SalesFollowupAttempt {
  id: string;
  account_id: string;
  flow_id: string;
  flow_run_id: string;
  attempt_number: number;
  scheduled_at: string;
  outcome: string | null;
  result_text: string | null;
  created_by: string | null;
  created_at: string;
  completed_by: string | null;
  completed_at: string | null;
  rescheduled_from: string | null;
  rescheduled_at: string | null;
  rescheduled_by: string | null;
  origin: string;
}

export type AttemptStatus = "scheduled" | "result_required" | "completed";

export function attemptStatus(
  attempt: Pick<SalesFollowupAttempt, "scheduled_at" | "completed_at">,
  nowMs: number = Date.now(),
): AttemptStatus {
  if (attempt.completed_at !== null) return "completed";
  return new Date(attempt.scheduled_at).getTime() <= nowMs
    ? "result_required"
    : "scheduled";
}

/** Lead-level derived state driving badges, Next Action, and guards. */
export type FollowupSequenceState =
  | { kind: "none"; nextAttemptNumber: 1 }
  | {
      kind: "scheduled" | "result_required" | "completed";
      activeAttempt: SalesFollowupAttempt | null;
      nextAttemptNumber: number;
    }
  | { kind: "closed"; nextAttemptNumber: number };

export function deriveSequenceState(
  attempts: SalesFollowupAttempt[],
  closed: boolean,
  nowMs: number = Date.now(),
): FollowupSequenceState {
  const ordered = [...attempts].sort(
    (a, b) => a.attempt_number - b.attempt_number,
  );
  const nextAttemptNumber =
    ordered.length === 0
      ? 1
      : Math.max(...ordered.map((a) => a.attempt_number)) + 1;
  if (ordered.length === 0) return { kind: "none", nextAttemptNumber: 1 };
  const open = ordered.find((a) => a.completed_at === null) ?? null;
  if (open) {
    return {
      kind: attemptStatus(open, nowMs) as "scheduled" | "result_required",
      activeAttempt: open,
      nextAttemptNumber,
    };
  }
  if (closed) return { kind: "closed", nextAttemptNumber };
  return {
    kind: "completed",
    activeAttempt: null,
    nextAttemptNumber,
  };
}

/**
 * Validate a result submission. Returns null when the outcome +
 * text pair is acceptable, otherwise a user-facing message.
 */
export function validateFollowupResult(
  outcome: unknown,
  resultText: unknown,
): string | null {
  if (!isFollowupOutcome(outcome)) {
    return "Choose the follow-up outcome.";
  }
  if (typeof resultText !== "string" || resultText.trim() === "") {
    return "Describe the follow-up result.";
  }
  if (resultText.trim().length > FOLLOWUP_RESULT_MAX) {
    return `Keep the result to ${FOLLOWUP_RESULT_MAX} characters or fewer.`;
  }
  return null;
}

/**
 * Validate a scheduled instant for a (re)schedule request. Past
 * scheduling is rejected, same rule as the existing reminder flow.
 */
export function validateScheduledAt(
  scheduledFor: unknown,
  nowMs: number = Date.now(),
): { iso: string } | { error: string } {
  if (typeof scheduledFor !== "string" || scheduledFor.trim() === "") {
    return { error: "Choose a follow-up date and time." };
  }
  const t = Date.parse(scheduledFor.trim());
  if (Number.isNaN(t)) return { error: "Enter a valid date and time." };
  if (t <= nowMs) return { error: "Choose a date and time in the future." };
  return { iso: new Date(t).toISOString() };
}

/** Next Action cell text for each sequence state. */
export function nextActionForState(
  state: FollowupSequenceState,
): string | null {
  switch (state.kind) {
    case "none":
      return "Schedule First Follow-up";
    case "scheduled":
      return `Follow-up ${state.activeAttempt!.attempt_number} Scheduled`;
    case "result_required":
      return `Record Result — Follow-up ${state.activeAttempt!.attempt_number}`;
    case "completed":
      return `Schedule Follow-up ${state.nextAttemptNumber}`;
    case "closed":
      return "View Follow-up History";
  }
}

/** Concise Customer Response summary for a completed attempt. */
export function responseSummaryForResult(
  outcome: string,
  resultText: string,
): string {
  const snippet = resultText.trim().replace(/\s+/g, " ");
  const cut =
    snippet.length > FOLLOWUP_RESPONSE_SUMMARY_MAX
      ? `${snippet.slice(0, FOLLOWUP_RESPONSE_SUMMARY_MAX - 1).trimEnd()}…`
      : snippet;
  return `${outcome} — ${cut}`;
}

/** Badge copy for the history timeline + dialogs. */
export function badgeForAttempt(
  attempt: Pick<SalesFollowupAttempt, "scheduled_at" | "completed_at" | "attempt_number">,
  nowMs: number = Date.now(),
): { label: string; tone: "info" | "warning" | "success" } {
  const status = attemptStatus(attempt, nowMs);
  if (status === "completed")
    return { label: `Follow-up ${attempt.attempt_number} · Completed`, tone: "success" };
  if (status === "result_required")
    return { label: `Follow-up ${attempt.attempt_number} · Result Required`, tone: "warning" };
  return { label: `Follow-up ${attempt.attempt_number} · Scheduled`, tone: "info" };
}
