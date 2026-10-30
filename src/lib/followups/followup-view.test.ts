import { describe, expect, it } from "vitest";

import {
  classifyFollowup,
  compareFollowups,
  decideCompletionUpdate,
  deriveTomorrowWindow,
  inBucket,
  isInTomorrow,
  localDayBounds,
  shouldClearWorkspaceCell,
  type BucketRow,
} from "./followup-view";

// Fixed viewer-local day: 2026-03-10. Window built explicitly so the
// tests pin the scheduling-timezone convention without depending on
// the machine running them.
const WINDOW = {
  start: "2026-03-09T18:30:00.000Z", // 2026-03-10 00:00 +05:30
  end: "2026-03-10T18:29:59.999Z", // 2026-03-10 23:59:59.999 +05:30
};

const row = (over: Partial<BucketRow> = {}): BucketRow => ({
  scheduled_for: "2026-03-10T05:00:00.000Z",
  followup_completed_at: null,
  ...over,
});

describe("categorization", () => {
  it("1. overdue = past and not completed", () => {
    expect(
      classifyFollowup(row({ scheduled_for: "2026-03-08T04:00:00.000Z" }), WINDOW),
    ).toBe("overdue");
  });

  it("2. due today = within the viewer-local day", () => {
    expect(classifyFollowup(row(), WINDOW)).toBe("today");
    // Exact start/end edges belong to today.
    expect(classifyFollowup(row({ scheduled_for: WINDOW.start }), WINDOW)).toBe("today");
    expect(classifyFollowup(row({ scheduled_for: WINDOW.end }), WINDOW)).toBe("today");
  });

  it("3. upcoming = after the viewer-local day", () => {
    expect(
      classifyFollowup(row({ scheduled_for: "2026-03-11T04:00:00.000Z" }), WINDOW),
    ).toBe("upcoming");
  });

  it("4. completed excluded from actionable buckets", () => {
    const done = row({
      scheduled_for: "2026-03-08T04:00:00.000Z",
      followup_completed_at: "2026-03-09T01:00:00.000Z",
    });
    expect(classifyFollowup(done, WINDOW)).toBe("completed");
    expect(inBucket(done, "overdue", WINDOW)).toBe(false);
    expect(inBucket(done, "today", WINDOW)).toBe(false);
    expect(inBucket(done, "upcoming", WINDOW)).toBe(false);
    expect(inBucket(done, "pending", WINDOW)).toBe(false);
    expect(inBucket(done, "completed", WINDOW)).toBe(true);
    expect(inBucket(done, "all", WINDOW)).toBe(true);
  });

  it("6. date boundaries use the scheduling (viewer-local) window, not UTC", () => {
    // 2026-03-09 22:00 UTC == 2026-03-10 03:30 IST → today, even
    // though the UTC calendar day is the 9th.
    expect(
      classifyFollowup(row({ scheduled_for: "2026-03-09T22:00:00.000Z" }), WINDOW),
    ).toBe("today");
    // One millisecond before the local day starts → overdue.
    expect(
      classifyFollowup(row({ scheduled_for: "2026-03-09T18:29:59.999Z" }), WINDOW),
    ).toBe("overdue");
  });

  it("unparseable schedule stays visible as upcoming, never overdue", () => {
    expect(classifyFollowup(row({ scheduled_for: "not-a-date" }), WINDOW)).toBe(
      "upcoming",
    );
  });
});

describe("tomorrow subset", () => {
  const TOMORROW = {
    start: "2026-03-10T18:30:00.000Z", // 2026-03-11 00:00 +05:30
    end: "2026-03-11T18:29:59.999Z", // 2026-03-11 23:59:59.999 +05:30
  };

  it("counts only pending rows inside tomorrow's local day", () => {
    expect(isInTomorrow(row({ scheduled_for: "2026-03-11T04:00:00.000Z" }), TOMORROW)).toBe(true);
    // Edges belong to tomorrow.
    expect(isInTomorrow(row({ scheduled_for: TOMORROW.start }), TOMORROW)).toBe(true);
    expect(isInTomorrow(row({ scheduled_for: TOMORROW.end }), TOMORROW)).toBe(true);
  });

  it("excludes completed and cancelled records", () => {
    const done = row({
      scheduled_for: "2026-03-11T04:00:00.000Z",
      followup_completed_at: "2026-03-10T02:00:00.000Z",
    });
    expect(isInTomorrow(done, TOMORROW)).toBe(false);
    expect(classifyFollowup(done, WINDOW)).toBe("completed");
  });

  it("excludes today/overdue/far-future rows", () => {
    expect(isInTomorrow(row({ scheduled_for: "2026-03-10T05:00:00.000Z" }), TOMORROW)).toBe(false);
    expect(isInTomorrow(row({ scheduled_for: "2026-03-08T04:00:00.000Z" }), TOMORROW)).toBe(false);
    expect(isInTomorrow(row({ scheduled_for: "2026-03-12T04:00:00.000Z" }), TOMORROW)).toBe(false);
    expect(isInTomorrow(row({ scheduled_for: "not-a-date" }), TOMORROW)).toBe(false);
  });

  it("local midnight boundary: 1ms before tomorrow is today, not tomorrow", () => {
    expect(isInTomorrow(row({ scheduled_for: "2026-03-10T18:29:59.999Z" }), TOMORROW)).toBe(false);
    expect(classifyFollowup(row({ scheduled_for: "2026-03-10T18:29:59.999Z" }), WINDOW)).toBe("today");
  });

  it("deriveTomorrowWindow starts 1ms after today ends", () => {
    const t = deriveTomorrowWindow(WINDOW);
    expect(new Date(t.start).getTime()).toBe(new Date(WINDOW.end).getTime() + 1);
    expect(new Date(t.end).getTime() - new Date(t.start).getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });
});
describe("ordering", () => {
  it("5. overdue → today → upcoming → completed; ties by schedule/completion time", () => {
    const rows = [
      row({ scheduled_for: "2026-03-12T04:00:00.000Z" }), // upcoming
      row({
        scheduled_for: "2026-03-08T04:00:00.000Z",
        followup_completed_at: "2026-03-09T02:00:00.000Z",
      }), // completed (newer)
      row({ scheduled_for: "2026-03-08T04:00:00.000Z" }), // overdue
      row({ scheduled_for: "2026-03-10T06:00:00.000Z" }), // today (later)
      row({ scheduled_for: "2026-03-10T04:00:00.000Z" }), // today (earlier)
      row({
        scheduled_for: "2026-03-07T04:00:00.000Z",
        followup_completed_at: "2026-03-08T02:00:00.000Z",
      }), // completed (older)
    ];
    const sorted = [...rows].sort((a, b) => compareFollowups(a, b, WINDOW));
    expect(sorted.map((r) => classifyFollowup(r, WINDOW))).toEqual([
      "overdue",
      "today",
      "today",
      "upcoming",
      "completed",
      "completed",
    ]);
    expect(sorted[1].scheduled_for).toBe("2026-03-10T04:00:00.000Z");
    expect(sorted[4].followup_completed_at).toBe("2026-03-09T02:00:00.000Z");
  });
});

describe("completion transitions", () => {
  it("7/8. completion saves timestamp+actor; already-completed is idempotent", () => {
    expect(
      decideCompletionUpdate({ status: "scheduled", followup_completed_at: null }),
    ).toEqual({ kind: "cancel-and-complete" });
    expect(
      decideCompletionUpdate({ status: "processing", followup_completed_at: null }),
    ).toEqual({ kind: "cancel-and-complete" });
    expect(
      decideCompletionUpdate({
        status: "scheduled",
        followup_completed_at: "2026-03-09T02:00:00.000Z",
      }),
    ).toEqual({ kind: "already-completed" });
  });

  it("10/11. sent/failed/cancelled keep delivery history, completion only", () => {
    for (const status of ["sent", "failed", "cancelled"]) {
      expect(decideCompletionUpdate({ status, followup_completed_at: null })).toEqual({
        kind: "complete-only",
      });
    }
  });
});

describe("workspace cell sync guard", () => {
  it("13/19. clears only the cell that still refers to the completed follow-up", () => {
    expect(
      shouldClearWorkspaceCell("2026-03-10T05:30:00.000Z", "2026-03-10T05:30:00.000Z"),
    ).toBe(true);
    // Newer re-schedule must survive.
    expect(
      shouldClearWorkspaceCell("2026-03-12T05:30:00.000Z", "2026-03-10T05:30:00.000Z"),
    ).toBe(false);
    // Equivalent serializations still match (instant comparison).
    expect(
      shouldClearWorkspaceCell("2026-03-10T05:30:00.000+00:00", "2026-03-10T05:30:00.000Z"),
    ).toBe(true);
    expect(shouldClearWorkspaceCell(null, "2026-03-10T05:30:00.000Z")).toBe(false);
    expect(shouldClearWorkspaceCell("garbage", "2026-03-10T05:30:00.000Z")).toBe(false);
  });
});

describe("localDayBounds", () => {
  it("spans one viewer-local day as UTC instants", () => {
    const bounds = localDayBounds();
    expect(new Date(bounds.start).getTime()).toBeLessThan(
      new Date(bounds.end).getTime(),
    );
    expect(bounds.end).toContain("T");
  });
});
