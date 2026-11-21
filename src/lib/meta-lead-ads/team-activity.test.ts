// Team activity lib — type + normalizer contracts.

import { describe, expect, it } from "vitest";

import {
  TEAM_ACTIVITY_TYPES,
  isTeamActivityType,
  normalizeTeamActivityResponse,
} from "./team-activity";

describe("team activity types", () => {
  it("offers only genuine actor-attributed types", () => {
    const values = TEAM_ACTIVITY_TYPES.map((t) => t.value);
    expect(values).toEqual([
      "lead_assigned",
      "lead_reassigned",
      "lead_unassigned",
      "followup_scheduled",
      "note_added",
      "whatsapp_sent",
    ]);
    // No fabricated capture/stage/config types.
    expect(values).not.toContain("lead_captured");
    expect(values).not.toContain("lead_stage_updated");
  });

  it("validates activity types strictly", () => {
    expect(isTeamActivityType("lead_assigned")).toBe(true);
    expect(isTeamActivityType("bogus")).toBe(false);
    expect(isTeamActivityType(null)).toBe(false);
  });
});

describe("normalizeTeamActivityResponse", () => {
  it("drops malformed and owner-less rows", () => {
    const out = normalizeTeamActivityResponse({
      activities: [
        {
          id: "a1",
          type: "lead_assigned",
          title: "Lead assigned",
          description: "x",
          timestamp: "2026-11-22T10:00:00.000Z",
          actorId: "u1",
          actorName: "Pooja",
          leadName: "Amit",
          leadId: "r1",
          tableId: "f1",
          tableName: "Spiti",
        },
        { id: "bad", type: "bogus", title: "x", description: "y", timestamp: "t", actorId: "u", actorName: "n" },
      ],
      nextCursor: "c",
      hasMore: true,
    });
    expect(out.activities).toHaveLength(1);
    expect(out.activities[0].id).toBe("a1");
    expect(out.hasMore).toBe(true);
  });
});
