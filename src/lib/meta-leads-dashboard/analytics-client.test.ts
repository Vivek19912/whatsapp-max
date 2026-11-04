// Pure-client contracts for the Meta Lead Ads dashboard loader:
// shape validation, zero-fill, malformed-row rejection, and the
// pass-through of server-computed totals (never recomputed here).
import { describe, expect, it } from "vitest";

import {
  normalizeMetaDaily,
  normalizeMetaMonthly,
} from "./analytics-client";
import { assignFormColors } from "./form-colors";

describe("normalizeMetaDaily", () => {
  it("keeps server totals and per-form splits verbatim", () => {
    const out = normalizeMetaDaily(
      [
        { date: "2026-10-01", total: 5, forms: [{ formName: "Fair", leads: 3 }, { formName: "Expo", leads: 2 }] },
        { date: "2026-10-02", total: 0, forms: [] },
      ],
      2
    );
    expect(out).toEqual([
      { date: "2026-10-01", total: 5, forms: [{ formName: "Fair", leads: 3 }, { formName: "Expo", leads: 2 }] },
      { date: "2026-10-02", total: 0, forms: [] },
    ]);
  });

  it("front-pads short payloads with zero days (trailing edge aligned)", () => {
    const out = normalizeMetaDaily([{ date: "2026-10-03", total: 1, forms: [] }], 3);
    expect(out).toEqual([
      { date: "", total: 0, forms: [] },
      { date: "", total: 0, forms: [] },
      { date: "2026-10-03", total: 1, forms: [] },
    ]);
  });

  it("drops malformed days and trims long payloads to the newest 30", () => {
    const days = Array.from({ length: 32 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      total: 1,
      forms: [],
    }));
    const out = normalizeMetaDaily(
      [{ date: "bad", total: 1, forms: [] }, ...days, { date: "2026-10-01", total: -2, forms: [] }, null],
      30
    );
    expect(out).toHaveLength(30);
    expect(out.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true);
  });

  it("drops malformed form segments but keeps the day", () => {
    const out = normalizeMetaDaily(
      [{ date: "2026-10-01", total: 2, forms: [{ formName: "Fair", leads: 2 }, { formName: "", leads: 1 }, null] }],
      1
    );
    expect(out[0]).toEqual({
      date: "2026-10-01",
      total: 2,
      forms: [{ formName: "Fair", leads: 2 }],
    });
  });
});

describe("normalizeMetaMonthly", () => {
  it("always returns 12 months with explicit zeros", () => {
    const out = normalizeMetaMonthly([
      { month: 3, total: 7, forms: [{ formName: "Fair", leads: 7 }] },
    ]);
    expect(out).toHaveLength(12);
    expect(out.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(out[2]).toEqual({ month: 3, total: 7, forms: [{ formName: "Fair", leads: 7 }] });
    expect(out[0]).toEqual({ month: 1, total: 0, forms: [] });
  });

  it("ignores out-of-range and malformed months", () => {
    const out = normalizeMetaMonthly([
      { month: 0, total: 5, forms: [] },
      { month: 13, total: 5, forms: [] },
      { month: "x", total: 5, forms: [] },
    ]);
    expect(out.every((m) => m.total === 0)).toBe(true);
  });
});

describe("assignFormColors", () => {
  it("is deterministic and unique per form name", () => {
    const a = assignFormColors(["Fair", "Expo", "Fair"]);
    const b = assignFormColors(["Expo", "Fair"]);
    expect(a.get("Fair")).toBe(b.get("Fair"));
    expect(a.get("Expo")).toBe(b.get("Expo"));
    expect(a.get("Fair")).not.toBe(a.get("Expo"));
  });

  it("handles empty input", () => {
    expect(assignFormColors([]).size).toBe(0);
  });
});
