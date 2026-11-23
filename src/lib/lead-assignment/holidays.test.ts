// Team Availability — holiday status, ranges, redistribution.

import { describe, expect, it } from "vitest";

import {
  excludeOnHoliday,
  holidayStatus,
  isHolidayActive,
  normalizeAdjustedPercentages,
  rangesOverlap,
  todayInZone,
} from "./holidays";

describe("holidayStatus", () => {
  it("derives upcoming / active / completed from wall-clock dates", () => {
    const t = "2026-11-24";
    expect(holidayStatus({ start_date: "2026-11-25", end_date: "2026-11-26", cancelled_at: null }, t)).toBe("upcoming");
    expect(holidayStatus({ start_date: "2026-11-24", end_date: "2026-11-26", cancelled_at: null }, t)).toBe("active");
    expect(holidayStatus({ start_date: "2026-11-20", end_date: "2026-11-24", cancelled_at: null }, t)).toBe("active");
    expect(holidayStatus({ start_date: "2026-11-20", end_date: "2026-11-23", cancelled_at: null }, t)).toBe("completed");
  });

  it("cancelled windows are never active", () => {
    const h = { start_date: "2026-11-20", end_date: "2026-11-30", cancelled_at: "2026-11-24T00:00:00Z" };
    expect(holidayStatus(h, "2026-11-24")).toBe("cancelled");
    expect(isHolidayActive(h, "2026-11-24")).toBe(false);
  });
});

describe("rangesOverlap", () => {
  it("detects shared days inclusively", () => {
    expect(rangesOverlap("2026-11-25", "2026-11-30", "2026-11-28", "2026-12-02")).toBe(true);
    expect(rangesOverlap("2026-11-25", "2026-11-30", "2026-11-30", "2026-12-02")).toBe(true);
    expect(rangesOverlap("2026-11-25", "2026-11-30", "2026-12-01", "2026-12-02")).toBe(false);
  });
});

describe("todayInZone", () => {
  it("formats the IST wall-clock date", () => {
    // 2026-11-24T00:30:00Z is 06:00 IST on Nov 24.
    expect(todayInZone("Asia/Kolkata", Date.parse("2026-11-24T00:30:00Z"))).toBe("2026-11-24");
    // 2026-11-23T18:30:00Z is 00:00 IST on Nov 24 (still Nov 23 UTC).
    expect(todayInZone("Asia/Kolkata", Date.parse("2026-11-23T18:30:00Z"))).toBe("2026-11-24");
  });
});

describe("normalizeAdjustedPercentages — spec example (Pooja 16 on holiday)", () => {
  it("redistributes 14×6 to 100.00 with deterministic remainder", () => {
    const rest = ["Rishita", "Ritika", "Vandana", "Deepika", "Devender", "Diksha"].map((name) => ({
      key: name, name, weight: 14,
    }));
    const out = normalizeAdjustedPercentages(rest);
    expect(out).toHaveLength(6);
    const sum = out.reduce((s, r) => s + r.percent, 0);
    expect(Number(sum.toFixed(2))).toBe(100);
    // Saved proportions preserved (all equal here): within one cent.
    for (const r of out) expect([16.66, 16.67]).toContain(r.percent);
  });

  it("preserves unequal proportions (20/30/50)", () => {
    const out = normalizeAdjustedPercentages([
      { key: "a", name: "A", weight: 20 },
      { key: "b", name: "B", weight: 30 },
      { key: "c", name: "C", weight: 50 },
    ]);
    const sum = out.reduce((s, r) => s + r.percent, 0);
    expect(Number(sum.toFixed(2))).toBe(100);
    expect(out[0].percent).toBe(20);
    expect(out[1].percent).toBe(30);
    expect(out[2].percent).toBe(50);
  });

  it("handles empty and zero-weight pools", () => {
    expect(normalizeAdjustedPercentages([])).toEqual([]);
    expect(normalizeAdjustedPercentages([{ key: "a", name: "A", weight: 0 }])).toEqual([]);
  });
});

describe("excludeOnHoliday", () => {
  it("removes holiday members while preserving rotation order", () => {
    const members = ["Pooja", "Rishita", "Deepika", "Vandana"].map((name) => ({ key: name }));
    expect(excludeOnHoliday(members, new Set(["Rishita"])).map((m) => m.key)).toEqual([
      "Pooja", "Deepika", "Vandana",
    ]);
    expect(excludeOnHoliday(members, new Set()).map((m) => m.key)).toHaveLength(4);
  });
});
