import { describe, expect, it } from "vitest";

import {
  attemptStatus,
  badgeForAttempt,
  deriveSequenceState,
  FOLLOWUP_OUTCOMES,
  isFollowupOutcome,
  isSystemNextAction,
  nextActionForState,
  validateFollowupResult,
  validateScheduledAt,
  type SalesFollowupAttempt,
} from "@/lib/followups/attempts";

// ---------------------------------------------------------------------------
// Sequential sales follow-up state model: derived states, guards,
// validation, and display builders. The server routes reuse these
// exact helpers, so this pins the business rules once.
// ---------------------------------------------------------------------------

function attempt(
  over: Partial<SalesFollowupAttempt> = {},
): SalesFollowupAttempt {
  return {
    id: "a-1",
    account_id: "acct-1",
    flow_id: "flow-1",
    flow_run_id: "run-1",
    attempt_number: 1,
    scheduled_at: "2026-11-10T11:00:00.000Z",
    outcome: null,
    result_text: null,
    created_by: "u-1",
    created_at: "2026-11-01T10:00:00.000Z",
    completed_by: null,
    completed_at: null,
    rescheduled_from: null,
    rescheduled_at: null,
    rescheduled_by: null,
    origin: "scheduled",
    ...over,
  };
}

const NOW = new Date("2026-11-05T00:00:00.000Z").getTime();

describe("attemptStatus (no background job needed)", () => {
  it("stays scheduled before its time", () => {
    expect(
      attemptStatus(attempt({ scheduled_at: "2026-11-10T11:00:00.000Z" }), NOW),
    ).toBe("scheduled");
  });

  it("becomes result_required once its time passes", () => {
    expect(
      attemptStatus(attempt({ scheduled_at: "2026-11-04T11:00:00.000Z" }), NOW),
    ).toBe("result_required");
  });

  it("is completed once a result exists, regardless of time", () => {
    expect(
      attemptStatus(
        attempt({
          scheduled_at: "2026-11-04T11:00:00.000Z",
          completed_at: "2026-11-04T12:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe("completed");
  });
});

describe("deriveSequenceState", () => {
  it("starts with no history at attempt 1", () => {
    expect(deriveSequenceState([], false, NOW)).toEqual({
      kind: "none",
      nextAttemptNumber: 1,
    });
  });

  it("reports the open attempt and the next number", () => {
    const state = deriveSequenceState([attempt()], false, NOW);
    expect(state.kind).toBe("scheduled");
    if (state.kind === "scheduled") {
      expect(state.activeAttempt?.attempt_number).toBe(1);
      expect(state.nextAttemptNumber).toBe(2);
    }
  });

  it("derives numbers from actual history, never a call counter", () => {
    const history = [
      attempt({ id: "a-1", attempt_number: 1, completed_at: "2026-11-02T10:00:00.000Z" }),
      attempt({ id: "a-2", attempt_number: 2, completed_at: "2026-11-03T10:00:00.000Z" }),
      attempt({ id: "a-3", attempt_number: 3 }),
    ];
    const state = deriveSequenceState(history, false, NOW);
    expect(state.kind).toBe("scheduled");
    if (state.kind === "scheduled") expect(state.nextAttemptNumber).toBe(4);
  });

  it("continues past five attempts", () => {
    const history = Array.from({ length: 7 }, (_, i) =>
      attempt({
        id: `a-${i + 1}`,
        attempt_number: i + 1,
        completed_at: "2026-11-02T10:00:00.000Z",
      }),
    );
    const state = deriveSequenceState(history, false, NOW);
    expect(state.kind).toBe("completed");
    if (state.kind === "completed") expect(state.nextAttemptNumber).toBe(8);
  });

  it("reports closed only with no open attempt", () => {
    const done = attempt({ completed_at: "2026-11-02T10:00:00.000Z" });
    expect(deriveSequenceState([done], true, NOW).kind).toBe("closed");
    expect(deriveSequenceState([attempt()], true, NOW).kind).toBe("scheduled");
  });
});

describe("result validation", () => {
  it("accepts exactly the eight outcomes", () => {
    expect(FOLLOWUP_OUTCOMES).toHaveLength(8);
    for (const outcome of FOLLOWUP_OUTCOMES) {
      expect(validateFollowupResult(outcome, "Called back.")).toBeNull();
      expect(isFollowupOutcome(outcome)).toBe(true);
    }
    expect(isFollowupOutcome("Maybe later")).toBe(false);
  });

  it("treats outcome as optional (null, undefined, or blank)", () => {
    for (const outcome of [null, undefined, "", "   "]) {
      expect(
        validateFollowupResult(outcome, "Customer asked for details."),
      ).toBeNull();
    }
  });

  it("still rejects invalid non-null outcomes", () => {
    expect(validateFollowupResult("Maybe later", "note")).toBe(
      "Choose a valid follow-up outcome.",
    );
    expect(validateFollowupResult(42, "note")).toBe(
      "Choose a valid follow-up outcome.",
    );
  });

  it("keeps result text mandatory with its limit", () => {
    expect(validateFollowupResult("No Answer", "")).toBe("Describe the follow-up result.");
    expect(validateFollowupResult(null, "")).toBe("Describe the follow-up result.");
    expect(validateFollowupResult(null, "   ")).toBe("Describe the follow-up result.");
    expect(validateFollowupResult("Busy", "x".repeat(2001))).toContain("2000");
    expect(validateFollowupResult(null, "x".repeat(2001))).toContain("2000");
  });
});

describe("schedule validation", () => {
  it("rejects blank, malformed, and past instants", () => {
    expect(validateScheduledAt("", NOW)).toEqual({
      error: "Choose a follow-up date and time.",
    });
    expect(validateScheduledAt("not-a-date", NOW)).toEqual({
      error: "Enter a valid date and time.",
    });
    expect(validateScheduledAt("2026-11-01T10:00:00.000Z", NOW)).toEqual({
      error: "Choose a date and time in the future.",
    });
  });

  it("normalizes future instants to canonical ISO", () => {
    expect(validateScheduledAt("2026-11-10T11:00:00.000Z", NOW)).toEqual({
      iso: "2026-11-10T11:00:00.000Z",
    });
  });
});

describe("display builders", () => {
  it("maps states to next actions (no scheduled-status text)", () => {
    expect(nextActionForState({ kind: "none", nextAttemptNumber: 1 })).toBe(
      "Schedule First Follow-up",
    );
    // A scheduled attempt contributes nothing — the date already
    // shows in Next Follow-up Date & Time.
    expect(
      nextActionForState({
        kind: "scheduled",
        activeAttempt: attempt(),
        nextAttemptNumber: 2,
      }),
    ).toBeNull();
    expect(
      nextActionForState({
        kind: "result_required",
        activeAttempt: attempt(),
        nextAttemptNumber: 2,
      }),
    ).toBeNull();
    expect(
      nextActionForState({ kind: "closed", nextAttemptNumber: 3 }),
    ).toBe("View Follow-up History");
    expect(
      nextActionForState({ kind: "completed", activeAttempt: null, nextAttemptNumber: 2 }),
    ).toBeNull();
  });

  it("recognizes system-written Next Action values (and only those)", () => {
    for (const system of [
      "",
      "   ",
      "Follow-up 1 Scheduled",
      "Follow-up 12 Scheduled",
      "Schedule Follow-up",
      "Schedule Follow-up 3",
      "Schedule First Follow-up",
      "Record Result — Follow-up 2",
      "View Follow-up History",
    ]) {
      expect(isSystemNextAction(system)).toBe(true);
    }
    for (const userText of [
      "Call Ravi Tuesday",
      "Follow-up 1 scheduled for Monday", // different casing/shape
      "Schedule follow-up 2",
    ]) {
      expect(isSystemNextAction(userText)).toBe(false);
    }
  });

  it("never summarizes results into Customer Response (dedicated columns own display)", async () => {
    // responseSummaryForResult is intentionally gone: results live
    // in sales_followup_attempts and render in Follow-up N Result
    // columns — Customer Response keeps only what salespeople type.
    const api = await import("@/lib/followups/attempts");
    expect("responseSummaryForResult" in api).toBe(false);
    expect("FOLLOWUP_RESPONSE_SUMMARY_MAX" in api).toBe(false);
  });

  it("badges every attempt state distinctly", () => {
    expect(badgeForAttempt(attempt(), NOW).tone).toBe("info");
    expect(
      badgeForAttempt(attempt({ scheduled_at: "2026-11-01T00:00:00.000Z" }), NOW).tone,
    ).toBe("warning");
    expect(
      badgeForAttempt(attempt({ completed_at: "2026-11-02T00:00:00.000Z" }), NOW).tone,
    ).toBe("success");
  });
});
