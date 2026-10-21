// Lead Assignment rule input validation (pure).

import { describe, expect, it } from "vitest";

import { validateRuleInput } from "./validation";

const MEMBERS = [{ user_id: "u-1" }, { user_id: "u-2" }];

function swrr(overrides: Record<string, unknown> = {}) {
  return validateRuleInput({
    name: "Video Enquiries",
    scope: "specific",
    mode: "swrr",
    status: "active",
    tables: ["form-1"],
    members: [
      { user_id: "u-1", weight: 60 },
      { user_id: "u-2", weight: 40 },
    ],
    ...overrides,
  });
}

describe("validateRuleInput", () => {
  it("accepts a valid 60/40 SWRR rule and normalizes order", () => {
    const out = swrr();
    expect(out).toEqual({
      name: "Video Enquiries",
      scope: "specific",
      mode: "swrr",
      status: "active",
      tables: ["form-1"],
      members: [
        { user_id: "u-1", weight: 60 },
        { user_id: "u-2", weight: 40 },
      ],
    });
  });

  it("accepts a valid Round Robin rule (weights ignored)", () => {
    const out = validateRuleInput({
      name: "RR",
      scope: "all",
      mode: "round_robin",
      tables: [],
      members: MEMBERS,
    });
    expect(out.members).toEqual([
      { user_id: "u-1", weight: 0 },
      { user_id: "u-2", weight: 0 },
    ]);
  });

  it("rejects totals below or above 100% with the live total", () => {
    expect(() =>
      swrr({ members: [{ user_id: "u-1", weight: 60 }, { user_id: "u-2", weight: 30 }] }),
    ).toThrow(/exactly 100%.*\(currently 90%\)/);
    expect(() =>
      swrr({ members: [{ user_id: "u-1", weight: 60 }, { user_id: "u-2", weight: 50 }] }),
    ).toThrow(/currently 110%/);
  });

  it("rejects non-integer, negative, and over-100 percentages", () => {
    for (const weight of [12.5, -1, 101, "60", null]) {
      expect(() =>
        swrr({ members: [{ user_id: "u-1", weight }, { user_id: "u-2", weight: 0 }] }),
      ).toThrow(/whole numbers from 0 to 100/);
    }
  });

  it("allows (but never assigns) 0% members within a valid total", () => {
    const out = swrr({
      members: [
        { user_id: "u-1", weight: 100 },
        { user_id: "u-2", weight: 0 },
      ],
    });
    expect(out.members[1]).toEqual({ user_id: "u-2", weight: 0 });
  });

  it("rejects empty names, missing tables, and missing members", () => {
    expect(() => swrr({ name: "   " })).toThrow(/name/);
    expect(() => swrr({ tables: [] })).toThrow(/at least one table/);
    expect(() => swrr({ scope: "all", tables: ["form-1"] })).toThrow(/must not list/);
    expect(() => swrr({ members: [] })).toThrow(/at least one team member/);
    expect(() =>
      swrr({ members: [{ user_id: "u-1", weight: 50 }, { user_id: "u-1", weight: 50 }] }),
    ).toThrow(/only once/);
  });
});
