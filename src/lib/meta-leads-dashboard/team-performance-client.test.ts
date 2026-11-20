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

  it("normalizes per-member and unassigned form splits and reconciles with totals", () => {
    const raw = normalizeTeamPerformance({
      members: [
        {
          userId: "u1",
          name: "Pooja",
          email: null,
          avatar: null,
          total: 8,
          stages: [],
          types: [],
          forms: [
            { formId: "f-sg", formName: "Singapore Lead Form", leads: 4 },
            { formId: "f-kl", formName: "Kerala Instant Form", leads: 3 },
            { formId: "f-goa", formName: "Goa Instant Form", leads: 1 },
            { formId: null, formName: "", leads: 5 },
          ],
        },
        { userId: "u2", name: "No Leads", email: null, avatar: null, total: 0, stages: [], types: [] },
      ],
      unassigned: {
        total: 20,
        stages: [],
        forms: [
          { formId: "f-a", formName: "Form A", leads: 12 },
          { formId: "f-b", formName: "Form B", leads: 8 },
        ],
      },
      summary: { total: 28, assigned: 8, unassigned: 20 },
      forms: [],
      tables: [],
      leads: { total: 0, rows: [] },
    });
    // Malformed entries (empty name) are dropped.
    expect(raw.members[0].forms).toEqual([
      { formId: "f-sg", formName: "Singapore Lead Form", leads: 4 },
      { formId: "f-kl", formName: "Kerala Instant Form", leads: 3 },
      { formId: "f-goa", formName: "Goa Instant Form", leads: 1 },
    ]);
    // Missing forms default to [] (old RPC payloads stay readable).
    expect(raw.members[1].forms).toEqual([]);
    // Per-member form sums equal the member total; unassigned likewise.
    const memberSum = raw.members[0].forms.reduce((a, f) => a + f.leads, 0);
    expect(memberSum).toBe(raw.members[0].total);
    const unSum = raw.unassigned.forms.reduce((a, f) => a + f.leads, 0);
    expect(unSum).toBe(raw.unassigned.total);
  });
});
