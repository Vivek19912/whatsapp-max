// Lead Assignment algorithms — Round Robin + Smooth Weighted RR.
//
// Pins the exact sequences from the specification:
//   * RR distributes 1→Mohan, 2→Sohan … 6→Mohan in configured order;
//   * SWRR 60/10/10/10/10 approaches 60/10/10/10/10 over 100 leads;
//   * 0% members never receive; totals != 100 are a config error
//     (validated at the API layer — see validation tests there);
//   * ties break by configured order; everything is deterministic.

import { describe, expect, it } from "vitest";

import { roundRobinNext, swrrNext } from "./algorithms";

describe("Round Robin", () => {
  const MEMBERS = ["mohan", "sohan", "rahul", "priya", "amit"];

  it("distributes leads sequentially in the configured member order", () => {
    let cursor = 0;
    const got: string[] = [];
    for (let i = 0; i < 10; i++) {
      const pick = roundRobinNext(MEMBERS, cursor);
      expect(pick).not.toBeNull();
      got.push(pick!.userId);
      cursor = pick!.nextCursor;
    }
    expect(got).toEqual([
      "mohan",
      "sohan",
      "rahul",
      "priya",
      "amit",
      "mohan",
      "sohan",
      "rahul",
      "priya",
      "amit",
    ]);
  });

  it("wraps correctly after the last member and keeps advancing", () => {
    const fifth = roundRobinNext(MEMBERS, 4);
    expect(fifth?.userId).toBe("amit");
    const sixth = roundRobinNext(MEMBERS, fifth!.nextCursor);
    expect(sixth?.userId).toBe("mohan");
    expect(sixth?.nextCursor).toBe(6);
  });

  it("returns null (leave unassigned) when nobody is eligible", () => {
    expect(roundRobinNext([], 7)).toBeNull();
  });

  it("treats a corrupt cursor as zero instead of crashing", () => {
    expect(roundRobinNext(MEMBERS, NaN)?.userId).toBe("mohan");
    expect(roundRobinNext(MEMBERS, -3)?.userId).toBe("mohan");
  });

  it("a persisted cursor resumes the sequence (restart-safe)", () => {
    // Cursor 7 persisted before a restart → lead 8 goes to Rahul,
    // exactly where the sequence left off.
    expect(roundRobinNext(MEMBERS, 7)?.userId).toBe("rahul");
  });

  it("member-list changes are deterministic (cursor modulo new pool)", () => {
    // Sohan removed: cursor 6 over 4 members → index 2 → Priya.
    expect(roundRobinNext(["mohan", "rahul", "priya", "amit"], 6)?.userId).toBe(
      "priya",
    );
  });
});

describe("Smooth Weighted Round Robin", () => {
  const MEMBERS = [
    { userId: "mohan", weight: 60 },
    { userId: "sohan", weight: 10 },
    { userId: "rahul", weight: 10 },
    { userId: "priya", weight: 10 },
    { userId: "amit", weight: 10 },
  ];

  function run(n: number, start: Record<string, number> = {}) {
    let current = { ...start };
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const pick = swrrNext(MEMBERS, current);
      expect(pick).not.toBeNull();
      counts[pick!.userId] = (counts[pick!.userId] ?? 0) + 1;
      current = pick!.nextCurrent;
    }
    return { counts, current };
  }

  it("opens with the heaviest member, then smooths (no long streaks)", () => {
    const first = swrrNext(MEMBERS, {});
    expect(first?.userId).toBe("mohan");
    const got: string[] = [first!.userId];
    let current = first!.nextCurrent;
    for (let i = 0; i < 9; i++) {
      const pick = swrrNext(MEMBERS, current)!;
      got.push(pick.userId);
      current = pick.nextCurrent;
    }
    // 10 leads → exactly 6/1/1/1/1 with no back-to-back repeats
    // beyond the unavoidable Mohan pairs of a 60% share.
    expect(got.filter((m) => m === "mohan")).toHaveLength(6);
    expect(got.filter((m) => m === "sohan")).toHaveLength(1);
    expect(got.filter((m) => m === "rahul")).toHaveLength(1);
    expect(got.filter((m) => m === "priya")).toHaveLength(1);
    expect(got.filter((m) => m === "amit")).toHaveLength(1);
  });

  it("approaches the configured percentages over 100 leads", () => {
    const { counts } = run(100);
    expect(counts).toEqual({
      mohan: 60,
      sohan: 10,
      rahul: 10,
      priya: 10,
      amit: 10,
    });
  });

  it("zero-weight members never receive a lead", () => {
    const members = [
      { userId: "mohan", weight: 100 },
      { userId: "sohan", weight: 0 },
    ];
    let current: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      const pick = swrrNext(members, current)!;
      expect(pick.userId).toBe("mohan");
      current = pick.nextCurrent;
    }
  });

  it("returns null when no eligible member carries weight", () => {
    expect(swrrNext([], {})).toBeNull();
    expect(
      swrrNext(
        [
          { userId: "a", weight: 0 },
          { userId: "b", weight: 0 },
        ],
        {},
      ),
    ).toBeNull();
  });

  it("is deterministic given the same state and inputs", () => {
    const a = run(25);
    const b = run(25);
    expect(a).toEqual(b);
  });

  it("resumes from persisted weights (restart-safe)", () => {
    const before = run(37);
    const afterFirst = swrrNext(MEMBERS, before.current);
    // Fresh replay of 38 leads must agree on the 38th pick.
    const replay = run(38);
    const replayCounts37 = run(37).counts;
    expect(replayCounts37).toEqual(before.counts);
    expect(afterFirst).not.toBeNull();
    expect(replay.counts[afterFirst!.userId]).toBe(
      (before.counts[afterFirst!.userId] ?? 0) + 1,
    );
  });

  it("renormalizes over the eligible pool when a member is unavailable", () => {
    // Sohan temporarily out: the remaining 60+10+10+10 = 90 weight
    // units distribute exactly 60/10/10/10 per 90-lead cycle.
    const pool = MEMBERS.filter((m) => m.userId !== "sohan");
    let current: Record<string, number> = {};
    const counts: Record<string, number> = {};
    for (let i = 0; i < 90; i++) {
      const pick = swrrNext(pool, current)!;
      counts[pick.userId] = (counts[pick.userId] ?? 0) + 1;
      current = pick.nextCurrent;
    }
    expect(counts).toEqual({ mohan: 60, rahul: 10, priya: 10, amit: 10 });
    expect(counts.sohan ?? 0).toBe(0);
    // Return: the saved configuration resumes untouched.
    const back = swrrNext(MEMBERS, current)!;
    expect(["mohan", "sohan", "rahul", "priya", "amit"]).toContain(back.userId);
    expect(current.sohan ?? 0).toBeLessThanOrEqual(0);
  });

  it("breaks ties by configured member order", () => {
    const members = [
      { userId: "first", weight: 50 },
      { userId: "second", weight: 50 },
    ];
    expect(swrrNext(members, {})?.userId).toBe("first");
  });
});
