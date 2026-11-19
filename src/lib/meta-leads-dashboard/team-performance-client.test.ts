import { describe, expect, it } from "vitest";
import {
  normalizeTeamPerformance,
  otherStagesCount,
  overallOtherCount,
  overallStageCount,
  resolveTeamDateRange,
  stageCount,
} from "./team-performance-client";

describe("resolveTeamDateRange", () => {
  const now = new Date(2026, 10, 19, 12, 0, 0); // 19 Nov 2026 local
  it("defaults Last 30 Days to t-29..today", () => {
    const r = resolveTeamDateRange("last30", now);
    expect(r).toEqual({ from: "2026-10-21", to: "2026-11-19", label: "Last 30 Days" });
  });
  it("maps all presets inclusively", () => {
    expect(resolveTeamDateRange("today", now)).toMatchObject({ from: "2026-11-19", to: "2026-11-19" });
    expect(resolveTeamDateRange("yesterday", now)).toMatchObject({ from: "2026-11-18", to: "2026-11-18" });
    expect(resolveTeamDateRange("last7", now)).toMatchObject({ from: "2026-11-13", to: "2026-11-19" });
    expect(resolveTeamDateRange("thisMonth", now)).toMatchObject({ from: "2026-11-01", to: "2026-11-19" });
    expect(resolveTeamDateRange("lastMonth", now)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolveTeamDateRange("allTime", now)).toEqual({ from: null, to: null, label: "All Time" });
  });
  it("passes custom through and swaps inverted bounds", () => {
    expect(resolveTeamDateRange("custom", now, "2026-11-05", "2026-11-01")).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-05",
    });
  });
});

describe("stage pivots reconcile", () => {
  const data = normalizeTeamPerformance({
    members: [
      {
        userId: "u1",
        name: "Rohit",
        email: null,
        avatar: null,
        total: 10,
        stages: [
          { stage: "New Lead", leads: 4 },
          { stage: "Contacted", leads: 2 },
          { stage: null, leads: 1 },
          { stage: "Custom X", leads: 3 },
        ],
        types: [],
      },
    ],
    unassigned: { total: 5, stages: [{ stage: "Lost", leads: 5 }] },
    summary: { total: 15, assigned: 10, unassigned: 5 },
    forms: [],
    tables: [
      {
        formId: "f1",
        formName: "Kerala",
        total: 15,
        assigned: 10,
        unassigned: 5,
        stages: [
          { stage: "New Lead", leads: 4 },
          { stage: "Contacted", leads: 2 },
          { stage: "Lost", leads: 5 },
          { stage: null, leads: 1 },
          { stage: "Custom X", leads: 3 },
        ],
      },
    ],
    leads: { total: 0, rows: [] },
  });

  it("counts pinned stages exactly and folds the rest into Other", () => {
    expect(stageCount(data.members[0].stages, "New Lead")).toBe(4);
    expect(otherStagesCount(data.members[0].stages, 10)).toBe(4); // null + custom
    expect(overallStageCount(data, "Lost")).toBe(5);
    expect(overallOtherCount(data)).toBe(4); // 15 - (4+2+0+0+5)
  });

  it("tables reconcile with summary", () => {
    const tTotal = data.tables.reduce((a, t) => a + t.total, 0);
    expect(tTotal).toBe(data.summary.total);
  });
});
