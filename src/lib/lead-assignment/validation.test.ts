// Lead Assignment rule input validation (pure).

import { describe, expect, it } from "vitest";

import {
  normalizeWeightText,
  parseWeightInput,
  validateMembersStep,
  validateRuleInput,
} from "./validation";

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

describe("normalizeWeightText (natural percentage editing)", () => {
  it("replaces the default 0 instead of prefixing it", () => {
    expect(normalizeWeightText("0", "05")).toBe("5");
    expect(normalizeWeightText("0", "00")).toBe("0");
    expect(normalizeWeightText("0", "050")).toBe("50");
    expect(normalizeWeightText("0", "010")).toBe("10");
    expect(normalizeWeightText("0", "0100")).toBe("100");
  });

  it("leaves every other edit untouched (cursor-safe)", () => {
    expect(normalizeWeightText("", "")).toBe("");
    expect(normalizeWeightText("0", "")).toBe("");
    expect(normalizeWeightText("", "5")).toBe("5");
    expect(normalizeWeightText("1", "12")).toBe("12");
    expect(normalizeWeightText("10", "100")).toBe("100");
    expect(normalizeWeightText("10", "05")).toBe("05");
    expect(normalizeWeightText("5", "")).toBe("");
  });
});

describe("parseWeightInput (empty is unfinished, never 0)", () => {
  it("parses display text without inventing values", () => {
    expect(parseWeightInput("0")).toBe(0);
    expect(parseWeightInput("50")).toBe(50);
    expect(parseWeightInput("050")).toBe(50);
    expect(parseWeightInput(" 60 ")).toBe(60);
    expect(parseWeightInput("100")).toBe(100);
    expect(parseWeightInput("12.5")).toBe(12.5);
  });

  it("returns null for empty or non-numeric text", () => {
    expect(parseWeightInput("")).toBeNull();
    expect(parseWeightInput("   ")).toBeNull();
    expect(parseWeightInput("abc")).toBeNull();
    expect(parseWeightInput(null)).toBeNull();
    expect(parseWeightInput(undefined)).toBeNull();
  });
});

describe("validateMembersStep rejects unfinished edits", () => {
  it("null/empty shares cannot validate, even at a 100 total", () => {
    expect(
      validateMembersStep({
        mode: "swrr",
        members: [
          { user_id: "u-1", weight: 100 },
          { user_id: "u-2", weight: null },
        ],
      }),
    ).toBe("Percentages must be whole numbers from 0 to 100.");
  });
});

describe("percentage editing flow (mirrors the panel handlers)", () => {
  // Simulates the panel's string-based editing state keystroke by
  // keystroke: display = text ?? String(weight), edits go through
  // normalizeWeightText, validation reads parseWeightInput.
  function simulate(initialWeight: number | null, keystrokes: Array<{ prev: string; raw: string }>) {
    let text: string | undefined;
    let weight: number | null = initialWeight;
    const displays: string[] = [text ?? String(weight ?? "")];
    for (const k of keystrokes) {
      text = normalizeWeightText(k.prev, k.raw);
      weight = parseWeightInput(text);
      displays.push(text);
    }
    return { displays, weight };
  }

  it("starts at 0, clears fully, and types 50 naturally", () => {
    // Initial display for a fresh member.
    expect(simulate(0, []).displays).toEqual(["0"]);
    // Select-all + Backspace on "0" → temporarily empty, invalid.
    const cleared = simulate(0, [{ prev: "0", raw: "" }]);
    expect(cleared.displays).toEqual(["0", ""]);
    expect(cleared.weight).toBeNull();
    expect(
      validateMembersStep({ mode: "swrr", members: [{ user_id: "u-1", weight: cleared.weight }] }),
    ).not.toBeNull();
    // Typing 50 into the empty field shows exactly "50".
    const typed = simulate(0, [
      { prev: "0", raw: "" },
      { prev: "", raw: "5" },
      { prev: "5", raw: "50" },
    ]);
    expect(typed.displays).toEqual(["0", "", "5", "50"]);
    expect(typed.weight).toBe(50);
  });

  it("replaces the default 0 with 10, 60, or 100", () => {
    for (const target of ["10", "60", "100"]) {
      const first = target[0];
      const r = simulate(0, [
        { prev: "0", raw: `0${first}` },
        { prev: first, raw: target },
      ]);
      expect(r.displays[r.displays.length - 1]).toBe(target);
      expect(r.weight).toBe(Number(target));
    }
  });

  it("Backspace/Delete/select-all/paste behave natively", () => {
    // Backspacing "60" → "6" keeps a valid share live.
    expect(simulate(60, [{ prev: "60", raw: "6" }]).weight).toBe(6);
    // Pasting "050" over the default 0 → "50".
    expect(simulate(0, [{ prev: "0", raw: "0050" }]).displays).toEqual(["0", "50"]);
    // Select-all + type into "60" replaces fully.
    expect(simulate(60, [{ prev: "60", raw: "4" }]).weight).toBe(4);
  });

  it("only an exact 100% total with all shares set allows progression", () => {
    const members = [
      { user_id: "u-1", weight: 60 as number | null },
      { user_id: "u-2", weight: null as number | null },
    ];
    expect(validateMembersStep({ mode: "swrr", members })).not.toBeNull();
    members[1].weight = 40;
    expect(validateMembersStep({ mode: "swrr", members })).toBeNull();
  });
});

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

describe("validateMembersStep (wizard Step 3 gate)", () => {
  const swrr = (members: Array<{ user_id: string; weight: number }>) =>
    validateMembersStep({ mode: "swrr", members });

  it("blocks all members at 0%", () => {
    expect(
      swrr([
        { user_id: "u-1", weight: 0 },
        { user_id: "u-2", weight: 0 },
      ]),
    ).toBe("Set each member's share — the total must be exactly 100%.");
  });

  it("blocks totals below 100%", () => {
    expect(
      swrr([
        { user_id: "u-1", weight: 60 },
        { user_id: "u-2", weight: 30 },
      ]),
    ).toBe("Total is 90% — must equal exactly 100%.");
  });

  it("blocks totals above 100%", () => {
    expect(
      swrr([
        { user_id: "u-1", weight: 60 },
        { user_id: "u-2", weight: 50 },
      ]),
    ).toBe("Total is 110% — must equal exactly 100%.");
  });

  it("passes exactly 100%", () => {
    expect(
      swrr([
        { user_id: "u-1", weight: 60 },
        { user_id: "u-2", weight: 40 },
      ]),
    ).toBeNull();
  });

  it("becomes invalid again the moment a valid total changes", () => {
    const members = [
      { user_id: "u-1", weight: 60 },
      { user_id: "u-2", weight: 40 },
    ];
    expect(swrr(members)).toBeNull();
    members[1].weight = 30;
    expect(swrr(members)).toBe("Total is 90% — must equal exactly 100%.");
  });

  it("rejects non-integer, negative, over-range, and non-numeric shares", () => {
    for (const weight of [12.5, -1, 101, Number.NaN, "60", null, undefined]) {
      expect(swrr([{ user_id: "u-1", weight: weight as number }])).toBe(
        "Percentages must be whole numbers from 0 to 100.",
      );
    }
  });

  it("blocks an empty member list", () => {
    expect(swrr([])).toBe("Select at least one team member.");
  });

  it("Round Robin proceeds without any percentage allocation", () => {
    expect(
      validateMembersStep({
        mode: "round_robin",
        members: [
          { user_id: "u-1", weight: 0 },
          { user_id: "u-2", weight: 0 },
        ],
      }),
    ).toBeNull();
    expect(
      validateMembersStep({ mode: "round_robin", members: [] }),
    ).toBe("Select at least one team member.");
  });
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
