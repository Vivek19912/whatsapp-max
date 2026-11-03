import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getSelectChip, assigneeChipFor, UNASSIGNED_CHIP, MEMBER_CHIP_PALETTE } from "./workspace-select-chips";

// ---------------------------------------------------------------------------
// Workspace dropdown chips — Sheets-style value colors (13 points).
//
// One pure mapping serves selected values, dropdown options, and
// read-only cells, so the three can never disagree. Contrast is
// asserted per pair (WCAG ratio ≥ 4.5) rather than eyeballed.
// ---------------------------------------------------------------------------

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("1. Call Status uses the defined colors", () => {
  it("maps every option to its exact background/text pair", () => {
    expect(getSelectChip("Call Status", "Connected")).toEqual({
      background: "#15803d",
      color: "#ffffff",
    });
    expect(getSelectChip("Call Status", "Not Answering")).toEqual({
      background: "#fef3c7",
      color: "#78350f",
    });
    expect(getSelectChip("Call Status", "Switched Off")).toEqual({
      background: "#e5e7eb",
      color: "#374151",
    });
    expect(getSelectChip("Call Status", "Busy")).toEqual({
      background: "#dbeafe",
      color: "#1e40af",
    });
    expect(getSelectChip("Call Status", "Call Back Later")).toEqual({
      background: "#dcfce7",
      color: "#166534",
    });
    expect(getSelectChip("Call Status", "Invalid Number")).toEqual({
      background: "#dc2626",
      color: "#ffffff",
    });
  });
});

describe("2. one mapping serves values and options (never random)", () => {
  it("is deterministic and case-tolerant per (field, value)", () => {
    expect(getSelectChip("Call Status", "Connected")).toEqual(
      getSelectChip("call status", "connected"),
    );
    expect(getSelectChip("Lead Quality", "Hot")).toEqual({
      background: "#15803d",
      color: "#ffffff",
    });
  });

  it("every mapped pair meets 4.5:1 text contrast", () => {
    const cases: Array<[string, string]> = [
      ["Call Status", "Connected"],
      ["Call Status", "Not Answering"],
      ["Call Status", "Switched Off"],
      ["Call Status", "Busy"],
      ["Call Status", "Call Back Later"],
      ["Call Status", "Invalid Number"],
      ["Lead Quality", "Hot"],
      ["Lead Quality", "Warm"],
      ["Lead Quality", "Cold"],
      ["Lead Quality", "Fake"],
      ["Quotation / Package", "Sent"],
      ["Quotation / Package", "Not Yet"],
      ["Lead Type", "Fresh"],
      ["Lead Type", "Hot"],
      ["Lead Type", "Warm"],
      ["Lead Type", "Cold"],
      ["Lead Type", "Prospect"],
      ["Stage", "New Lead"],
      ["Stage", "Contacted"],
      ["Stage", "Qualified"],
      ["Stage", "Quotation Required"],
      ["Stage", "Quotation Sent"],
      ["Stage", "In Negotiation"],
      ["Stage", "Ready To Book"],
      ["Stage", "Booking Confirmed"],
      ["Stage", "Follow Up"],
      ["Stage", "Amendment"],
      ["Stage", "Lost"],
      ["Stage", "Cancelled"],
      ["Stage", "Invalid"],
      ["Stage", "On Hold"],
      ["Stage", "Not connected"],
      ["Lead Received", "Website"],
      ["Lead Received", "Social Media"],
      ["Lead Received", "Facebook Ads"],
      ["Lead Received", "Instagram Ads"],
      ["Lead Received", "Google Ads"],
      ["Lead Received", "Whatsapp"],
      ["Lead Received", "Phone Call"],
      ["Lead Received", "Referral"],
      ["Lead Received", "Walk In"],
      ["Lead Received", "Repeat Customer"],
      ["Lead Received", "Partner"],
      ["Lead Received", "Other"],
      ["Follow-Up Status", "Follow-up Pending"],
      ["Follow-Up Status", "Negotiation Going On"],
      ["Follow-Up Status", "Booked"],
      ["Follow-Up Status", "Lost"],
      ["Follow-Up Status", "No Plan"],
      ["Reason for Lost Lead", "Budget Issue"],
      ["Reason for Lost Lead", "No Response"],
      ["Reason for Lost Lead", "Already Booked Elsewhere"],
      ["Reason for Lost Lead", "Date Issue"],
      ["Reason for Lost Lead", "Just Inquiry"],
      ["Reason for Lost Lead", "Travel Cancelled"],
      ["No. of Calls Tried", "7"],
    ];
    for (const [field, value] of cases) {
      const chip = getSelectChip(field, value);
      expect(chip).not.toBeNull();
      expect(contrast(chip!.background, chip!.color)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("every member palette entry meets 4.5:1 text contrast", () => {
    expect(MEMBER_CHIP_PALETTE.length).toBeGreaterThanOrEqual(10);
    for (const chip of MEMBER_CHIP_PALETTE) {
      expect(contrast(chip.background, chip.color)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(UNASSIGNED_CHIP.background, UNASSIGNED_CHIP.color)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("3/4. No. of Calls Tried renders neutral chips for exactly 1–10", () => {
  it("maps 1–10 to the same neutral gray chip", () => {
    const neutral = { background: "#e5e7eb", color: "#1f2937" };
    for (const n of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) {
      expect(getSelectChip("No. of Calls Tried", n)).toEqual(neutral);
    }
  });

  it("rejects anything outside 1–10 (no arbitrary text/numbers)", () => {
    for (const bad of ["0", "11", "3.5", "abc", "01", "five", ""]) {
      expect(getSelectChip("No. of Calls Tried", bad)).toBeNull();
    }
    // Surrounding whitespace trims to the valid option.
    expect(getSelectChip("No. of Calls Tried", " 7 ")).toEqual({
      background: "#e5e7eb",
      color: "#1f2937",
    });
  });
});

describe("5. Lead Quality uses the defined colors", () => {
  it("maps Hot/Warm/Cold/Fake exactly", () => {
    expect(getSelectChip("Lead Quality", "Hot")).toEqual({
      background: "#15803d",
      color: "#ffffff",
    });
    expect(getSelectChip("Lead Quality", "Warm")).toEqual({
      background: "#dcfce7",
      color: "#166534",
    });
    expect(getSelectChip("Lead Quality", "Cold")).toEqual({
      background: "#ffedd5",
      color: "#7c2d12",
    });
    expect(getSelectChip("Lead Quality", "Fake")).toEqual({
      background: "#dc2626",
      color: "#ffffff",
    });
  });
});

describe("6. Quotation / Package uses Sent/Not Yet with defined colors", () => {
  it("maps both options; nothing else gets a chip", () => {
    expect(getSelectChip("Quotation / Package", "Sent")).toEqual({
      background: "#15803d",
      color: "#ffffff",
    });
    expect(getSelectChip("Quotation / Package", "Not Yet")).toEqual({
      background: "#dc2626",
      color: "#ffffff",
    });
    expect(getSelectChip("Quotation / Package", "Maybe")).toBeNull();
    expect(getSelectChip("Quotation / Package", "sent")).toEqual({
      background: "#15803d",
      color: "#ffffff",
    });
  });
});

describe("7/9/10/11. Follow-Up Status: unique colors, no gray, matched paths", () => {
  it("maps all five options to distinct non-gray backgrounds", () => {
    const pairs: Array<[string, { background: string; color: string }]> = [
      ["Follow-up Pending", { background: "#fef3c7", color: "#78350f" }],
      ["Negotiation Going On", { background: "#ede9fe", color: "#5b21b6" }],
      ["Booked", { background: "#15803d", color: "#ffffff" }],
      ["Lost", { background: "#dc2626", color: "#ffffff" }],
      ["No Plan", { background: "#92400e", color: "#ffffff" }],
    ];
    const bgs = new Set<string>();
    for (const [option, expected] of pairs) {
      expect(getSelectChip("Follow-Up Status", option)).toEqual(expected);
      bgs.add(expected.background);
    }
    expect(bgs.size).toBe(5);
    for (const bg of bgs) {
      expect(bg.toLowerCase()).not.toBe("#e5e7eb");
    }
  });
});

describe("8/12/13/14. Reason for Lost Lead: distinct colors, gray only for Just Inquiry", () => {
  it("maps all six options to distinct backgrounds", () => {
    const pairs: Array<[string, { background: string; color: string }]> = [
      ["Budget Issue", { background: "#ffedd5", color: "#9a3412" }],
      ["No Response", { background: "#fef3c7", color: "#78350f" }],
      ["Already Booked Elsewhere", { background: "#ede9fe", color: "#5b21b6" }],
      ["Date Issue", { background: "#dbeafe", color: "#1e40af" }],
      ["Just Inquiry", { background: "#e5e7eb", color: "#374151" }],
      ["Travel Cancelled", { background: "#ffe4e6", color: "#9f1239" }],
    ];
    const bgs = new Set<string>();
    for (const [option, expected] of pairs) {
      expect(getSelectChip("Reason for Lost Lead", option)).toEqual(expected);
      bgs.add(expected.background);
    }
    expect(bgs.size).toBe(6);
  });

  it("gray appears exactly once (Just Inquiry)", () => {
    const grayUsers = [
      "Budget Issue",
      "No Response",
      "Already Booked Elsewhere",
      "Date Issue",
      "Just Inquiry",
      "Travel Cancelled",
    ].filter(
      (o) => getSelectChip("Reason for Lost Lead", o)?.background.toLowerCase() === "#e5e7eb",
    );
    expect(grayUsers).toEqual(["Just Inquiry"]);
  });
});

describe("Assigned To member colors (1–8)", () => {
  const roster = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  ];

  it("3. Unassigned is the gray chip", () => {
    expect(UNASSIGNED_CHIP).toEqual({ background: "#e5e7eb", color: "#374151" });
  });

  it("1/2. colors derive from the input roster (nothing hardcoded)", () => {
    const colors = roster.map((id) => assigneeChipFor(id, roster));
    expect(colors.every(Boolean)).toBe(true);
    // A different roster can assign differently — proof of dynamism.
    const other = ["ffffffff-ffff-4fff-8fff-ffffffffffff"];
    expect(assigneeChipFor(other[0], other)).not.toBeNull();
  });

  it("4/5. every roster member gets a unique color", () => {
    const chips = roster.map((id) => assigneeChipFor(id, roster)!);
    const bgs = new Set(chips.map((c) => c.background));
    expect(bgs.size).toBe(roster.length);
    // Deterministic: same roster, same assignment, every render.
    for (const id of roster) {
      expect(assigneeChipFor(id, roster)).toEqual(assigneeChipFor(id, roster));
    }
  });

  it("8. a new teammate takes another free color; earlier members keep theirs", () => {
    const before = roster.map((id) => assigneeChipFor(id, roster));
    const newcomer = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const grown = [...roster, newcomer];
    const after = grown.map((id) => assigneeChipFor(id, grown));
    expect(after.slice(0, roster.length)).toEqual(before);
    expect(new Set(after.map((c) => c!.background)).size).toBe(grown.length);
  });

  it("unknown ids stay plain (removed members preserved, never recolored)", () => {
    expect(assigneeChipFor("99999999-9999-4999-8999-999999999999", roster)).toBeNull();
    expect(assigneeChipFor("", roster)).toBeNull();
  });
});

describe("9. empty values remain unstyled", () => {
  it("resolves null for empty input on every field", () => {
    for (const field of [
      "Call Status",
      "No. of Calls Tried",
      "Lead Quality",
      "Quotation / Package",
      "Follow-Up Status",
      "Reason for Lost Lead",
    ]) {
      expect(getSelectChip(field, null)).toBeNull();
      expect(getSelectChip(field, undefined)).toBeNull();
      expect(getSelectChip(field, "")).toBeNull();
      expect(getSelectChip(field, "   ")).toBeNull();
    }
  });
});
describe("2/15. roster stays dynamic; business map ignores Assigned To", () => {
  it("getSelectChip never colors assignee rows (member chips live separately)", () => {
    expect(getSelectChip("Assigned To", "Unassigned")).toBeNull();
    expect(getSelectChip("Assigned To", "__clear__")).toBeNull();
    expect(getSelectChip("Assigned To", "11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(getSelectChip("Assigned To", "Some Teammate")).toBeNull();
    expect(getSelectChip("Unknown Field", "Connected")).toBeNull();
  });

  it("the roster still loads dynamically with no hardcoded members", () => {
    const root = process.cwd();
    for (const rel of [
      "src/lib/flows/workspace-select-chips.ts",
      "src/components/workspace/custom-cell.tsx",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8").toLowerCase();
      for (const name of ["travelenfield", "tarun sagar", "neha singh", "janak katyal"]) {
        expect(src).not.toContain(name);
      }
      expect(src).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    }
    const page = readFileSync(
      `${root}/src/app/(dashboard)/workspace/page.tsx`,
      "utf8",
    );
    expect(page).toContain("/api/account/members");
  });
});

describe("6/7/selected+options share the chips (assignee included)", () => {
  it("custom-cell paints chips in every select path", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/custom-cell.tsx`,
      "utf8",
    );
    expect(src).toContain("getSelectChip(field.name, shown)");
    expect(src).toContain("getSelectChip(field.name, o.value)");
    expect(src).toContain("assigneeChipFor(");
    expect(src).toContain("UNASSIGNED_CHIP");
    expect(src).toContain("<SelectChipView");
    // Chip styling: pill radius, compact size/weight, no gradient/shadow utilities.
    expect(src).toContain("rounded-full");
    expect(src).toContain("text-[12px]");
    expect(src).toContain("font-medium");
    expect(src).not.toContain("bg-gradient");
    expect(src).not.toMatch(/shadow-(sm|md|lg|xl)/);
    // Save path untouched (visual-only change).
    expect(src).toContain('save(v === "__clear__" ? null : v)');
  });
});

describe("12/13. behavior and Sheets unchanged", () => {
  it("the chip layer imports nothing outside presentation + pure mapping", () => {
    const lib = readFileSync(
      `${process.cwd()}/src/lib/flows/workspace-select-chips.ts`,
      "utf8",
    );
    expect(lib).not.toContain("supabase");
    expect(lib).not.toContain("validateWorkspaceValue");
  });

  it("Google Sheets is unaffected", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${process.cwd()}/${rel}`, "utf8");
      expect(src).not.toContain("SelectChip");
      expect(src).not.toContain("getSelectChip");
      expect(src).not.toContain("workspace-select-chips");
    }
  });
});

describe("Lead Type / Stage / Lead Received: exact option sets, distinct chips", () => {
  it("Lead Type maps its 5 options to distinct backgrounds", () => {
    const options = ["Fresh", "Hot", "Warm", "Cold", "Prospect"];
    const bgs = new Set(
      options.map((o) => {
        const chip = getSelectChip("Lead Type", o);
        expect(chip).not.toBeNull();
        return chip!.background;
      }),
    );
    expect(bgs.size).toBe(5);
  });

  it("Stage maps its 15 options to distinct backgrounds", () => {
    const options = [
      "New Lead",
      "Contacted",
      "Qualified",
      "Quotation Required",
      "Quotation Sent",
      "In Negotiation",
      "Ready To Book",
      "Booking Confirmed",
      "Follow Up",
      "Amendment",
      "Lost",
      "Cancelled",
      "Invalid",
      "On Hold",
      "Not connected",
    ];
    const bgs = new Set(
      options.map((o) => {
        const chip = getSelectChip("Stage", o);
        expect(chip).not.toBeNull();
        return chip!.background;
      }),
    );
    expect(bgs.size).toBe(15);
  });

  it("Lead Received maps its 12 options to distinct backgrounds", () => {
    const options = [
      "Website",
      "Social Media",
      "Facebook Ads",
      "Instagram Ads",
      "Google Ads",
      "Whatsapp",
      "Phone Call",
      "Referral",
      "Walk In",
      "Repeat Customer",
      "Partner",
      "Other",
    ];
    const bgs = new Set(
      options.map((o) => {
        const chip = getSelectChip("Lead Received", o);
        expect(chip).not.toBeNull();
        return chip!.background;
      }),
    );
    expect(bgs.size).toBe(12);
  });

  it("legacy Lead Quality / Quotation values keep their chips", () => {
    expect(getSelectChip("Lead Quality", "Fake")).toEqual({
      background: "#dc2626",
      color: "#ffffff",
    });
    expect(getSelectChip("Quotation / Package", "Sent")).toEqual({
      background: "#15803d",
      color: "#ffffff",
    });
  });
});
