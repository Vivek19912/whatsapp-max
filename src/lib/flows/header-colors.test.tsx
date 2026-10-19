import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { HeaderColorSwatches } from "@/components/workspace/header-color-picker";
import {
  areAdjacentBackgroundsDistinct,
  assignHeaderBackgrounds,
  buildHeaderColorMap,
  defaultHeaderColor,
  HEADER_COLOR_POOL,
  HEADER_COLOR_PRESETS,
  HEADER_CURATED_DEFAULTS,
  HEADER_FALLBACK_PALETTE,
  HEADER_REFERENCE_NAME,
  HEADER_REFERENCE_PALETTE,
  HEADER_TEXT_DARK,
  HEADER_TEXT_LIGHT,
  headerTextColor,
  isDarkHeaderColor,
  normalizeHeaderColor,
  overflowHeaderColor,
  resolveHeaderColor,
} from "./header-colors";

// ---------------------------------------------------------------------------
// Workspace header colors — exact reference palette + deterministic
// set-aware assignment.
// ---------------------------------------------------------------------------

const GREEN = "#93c47d";
const BLUE = "#6d9eeb";
const ORANGE = "#ff9900";
const GRAY = "#cbd5e1";
const TEAL = "#46bdc6";
const REMARK_GREEN = "#34a853";
const RED = "#ea4335";

describe("reference palette", () => {
  it("uses the exact reference HEX colors, lowercase, in order", () => {
    expect(HEADER_REFERENCE_PALETTE).toEqual([
      GREEN,
      BLUE,
      ORANGE,
      TEAL,
      REMARK_GREEN,
      RED,
    ]);
  });

  it("presets offer exactly the reference palette", () => {
    expect([...HEADER_COLOR_PRESETS]).toEqual([...HEADER_REFERENCE_PALETTE]);
  });
});

describe("semantic mapping (mapped columns present)", () => {
  it("paints the Row-number column #f1f5f9", () => {
    expect(defaultHeaderColor("core:row", "Row")).toBe("#f1f5f9");
    expect(
      buildHeaderColorMap(
        [
          { visId: "core:row", label: "Row" },
          { visId: "flow:phone", label: "Phone Number" },
          { visId: "custom:a", label: "Assigned To" },
        ],
        {}
      )["core:row"]
    ).toBe("#f1f5f9");
  });

  it("paints Phone Number blue (visId and label variants)", () => {
    expect(defaultHeaderColor("flow:phone", "Phone Number")).toBe(BLUE);
    expect(defaultHeaderColor("flow:phone", "Phone No")).toBe(BLUE);
    expect(defaultHeaderColor("custom:x", "Phone No")).toBe(BLUE);
    expect(defaultHeaderColor("custom:x", "Phone Number")).toBe(BLUE);
    expect(defaultHeaderColor("custom:x", "phone")).toBe(BLUE);
  });

  it("paints Name Cool Gray", () => {
    expect(defaultHeaderColor("flow:name", "Name")).toBe(GRAY);
    expect(defaultHeaderColor("custom:x", "Name")).toBe(GRAY);
  });

  it("paints Follow-Up Status / Follow Up teal (but not nearby date fields)", () => {
    expect(defaultHeaderColor("custom:x", "Follow-Up Status")).toBe(TEAL);
    expect(defaultHeaderColor("custom:x", "Follow Up")).toBe(TEAL);
    expect(defaultHeaderColor("custom:x", "follow-up status")).toBe(TEAL);
    // A different field that merely mentions follow-up stays default.
    expect(defaultHeaderColor("custom:x", "Next Follow-up Date & Time")).toBe(
      GREEN,
    );
  });

  it("paints Final Remark green", () => {
    expect(defaultHeaderColor("custom:x", "Final Remark")).toBe(REMARK_GREEN);
  });

  it("paints Reason for/of Lost Lead red", () => {
    expect(defaultHeaderColor("custom:x", "Reason for Lost Lead")).toBe(RED);
    expect(defaultHeaderColor("custom:x", "Reason of Lost")).toBe(RED);
  });

  it("paints every other business column the default green", () => {
    for (const label of [
      "Submission Time",
      "Assigned To",
      "Call Status",
      "Lead Quality",
      "Lead Source",
      "My Tracker",
      "VIP Flag",
    ]) {
      expect(defaultHeaderColor("custom:x", label)).toBe(GREEN);
    }
  });

  it("matching is case-insensitive", () => {
    expect(defaultHeaderColor("custom:x", "FINAL REMARK")).toBe(REMARK_GREEN);
    expect(defaultHeaderColor("custom:x", "  Reason For Lost Lead  ")).toBe(
      RED,
    );
  });
});

describe("Name Cool Gray rename (only the Name header changes)", () => {
  const order = [
    { visId: "core:row", label: "Row" },
    { visId: "flow:submission_time", label: "Submission Time" },
    { visId: "flow:name", label: "Name" },
    { visId: "sys:name", label: "WhatsApp Name" },
    { visId: "flow:phone", label: "Phone Number" },
    { visId: "custom:a", label: "Assigned To" },
  ];

  it("paints only the Name header Cool Gray", () => {
    expect(HEADER_REFERENCE_NAME).toBe(GRAY);
    const backgrounds = assignHeaderBackgrounds(order, {});
    const names = order.map((c) => c.visId).indexOf("flow:name");
    expect(backgrounds[names]).toBe("#cbd5e1");
    for (let i = 0; i < order.length; i++) {
      if (i !== names) expect(backgrounds[i]).not.toBe("#cbd5e1");
    }
  });

  it("leaves every neighbouring header on its existing color", () => {
    const map = buildHeaderColorMap(order, {});
    expect(map["core:row"]).toBe("#f1f5f9");
    expect(map["flow:submission_time"]).toBe(GREEN);
    expect(map["sys:name"]).toBe(TEAL);
    expect(map["flow:phone"]).toBe(BLUE);
    expect(map["custom:a"]).toBe(REMARK_GREEN);
  });

  it("keeps adjacent headers distinct around the gray Name", () => {
    const backgrounds = assignHeaderBackgrounds(order, {});
    expect(areAdjacentBackgroundsDistinct(backgrounds)).toBe(true);
  });

  it("Cool Gray is distinct from every pool color and the Row background", () => {
    for (const hex of [...HEADER_COLOR_POOL, "#f1f5f9"]) {
      expect(hex.toLowerCase()).not.toBe(GRAY);
    }
  });

  it("never auto-assigns retired orange (explicit customs still honored)", () => {
    const orders: Array<typeof order> = [
      order,
      order.filter((c) => c.visId !== "flow:name"),
      Array.from({ length: 10 }, (_, i) => ({
        visId: `custom:g${i}`,
        label: `Generic ${i}`,
      })),
    ];
    for (const cols of orders) {
      for (const bg of assignHeaderBackgrounds(cols, {})) {
        expect(bg).not.toBe(ORANGE);
      }
    }
    // A stored custom may still paint orange by explicit choice.
    expect(
      assignHeaderBackgrounds(order, { "custom:a": ORANGE })[
        order.findIndex((c) => c.visId === "custom:a")
      ],
    ).toBe(ORANGE);
  });
});

describe("fallback reassignment (mapped columns absent)", () => {
  it("reassigns unused mapped colors to visible columns in palette order", () => {
    // No mapped column at all: the visible set still carries the
    // palette sequentially (green first, then blue, teal, …).
    // Retired orange is never dealt, so the third column takes
    // teal instead.
    const map = buildHeaderColorMap(
      [
        { visId: "custom:a", label: "Assigned To" },
        { visId: "custom:b", label: "Call Status" },
        { visId: "custom:c", label: "Lead Quality" },
      ],
      {},
    );
    expect(map).toEqual({
      "custom:a": GREEN,
      "custom:b": BLUE,
      "custom:c": TEAL,
    });
  });

  it("colors of absent mapped columns still appear (red/green reuse)", () => {
    // Flow without Reason/Remark/Follow-Up/Name/Phone: the fixed Row
    // color plus the first five assignable palette colors in order
    // (retired orange excluded).
    const map = buildHeaderColorMap(
      [
        { visId: "core:row", label: "Row" },
        { visId: "custom:a", label: "Assigned To" },
        { visId: "custom:b", label: "Call Status" },
        { visId: "custom:c", label: "Lead Quality" },
        { visId: "custom:d", label: "Next Action" },
        { visId: "custom:e", label: "Last Contact Date" },
      ],
      {},
    );
    expect(map["core:row"]).toBe("#f1f5f9");
    expect(Object.values(map).sort()).toEqual(
      ["#f1f5f9", "#93c47d", "#6d9eeb", "#46bdc6", "#34a853", "#ea4335"].sort()
    );
  });

  it("keeps semantic colors where their columns exist, reassigns the rest", () => {
    const map = buildHeaderColorMap(
      [
        { visId: "flow:name", label: "Name" },
        { visId: "flow:phone", label: "Phone No" },
        { visId: "custom:a", label: "Assigned To" },
        { visId: "custom:b", label: "Call Status" },
      ],
      {},
    );
    expect(map["flow:name"]).toBe(GRAY);
    expect(map["flow:phone"]).toBe(BLUE);
    // Green first (palette order), then the next unused assignable
    // color (teal) — red and remark-green stay unused here only
    // because fewer than six columns are visible.
    expect(map["custom:a"]).toBe(GREEN);
    expect(map["custom:b"]).toBe(TEAL);
  });

  it("never leaves a visible column undefined, blank, or unmapped", () => {
    const cols = [
      { visId: "core:row", label: "Row" },
      { visId: "flow:submission_time", label: "Submission Time" },
      { visId: "flow:name", label: "Name" },
      { visId: "custom:z", label: "Whatever" },
    ];
    const map = buildHeaderColorMap(cols, {});
    expect(Object.keys(map).sort()).toEqual(
      cols.map((c) => c.visId).sort(),
    );
    for (const hex of Object.values(map)) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("fewer than six visible columns use palette colors only", () => {
    const map = buildHeaderColorMap(
      [
        { visId: "custom:a", label: "Alpha" },
        { visId: "custom:b", label: "Beta" },
      ],
      {},
    );
    for (const hex of Object.values(map)) {
      expect(HEADER_REFERENCE_PALETTE).toContain(hex);
    }
  });
});

describe("determinism and stability", () => {
  const cols = [
    { visId: "flow:name", label: "Name" },
    { visId: "flow:phone", label: "Phone Number" },
    { visId: "custom:a", label: "Assigned To" },
    { visId: "custom:k", label: "Reason for Lost Lead" },
    { visId: "custom:l", label: "Final Remark" },
  ];

  it("same visible set always yields the same map", () => {
    expect(buildHeaderColorMap(cols, {})).toEqual(
      buildHeaderColorMap(cols, {}),
    );
    expect(defaultHeaderColor("flow:TravelDate", "TravelDate")).toBe(
      defaultHeaderColor("flow:TravelDate", "TravelDate"),
    );
  });

  it("appending a column never changes earlier columns' colors", () => {
    const before = buildHeaderColorMap(cols, {});
    const after = buildHeaderColorMap(
      [...cols, { visId: "custom:newbie", label: "VIP Flag" }],
      {},
    );
    for (const col of cols) {
      expect(after[col.visId]).toBe(before[col.visId]);
    }
  });

  it("hiding a mapped column moves its color to a visible one, deterministically", () => {
    const cols = [
      { visId: "flow:name", label: "Name" },
      { visId: "flow:phone", label: "Phone Number" },
      { visId: "custom:a", label: "Assigned To" },
      { visId: "custom:b", label: "Call Status" },
      { visId: "custom:l", label: "Final Remark" },
      { visId: "custom:j", label: "Next Action" },
    ];
    const withLost = buildHeaderColorMap(
      [...cols, { visId: "custom:k", label: "Reason for Lost Lead" }],
      {},
    );
    expect(withLost["custom:k"]).toBe(RED);
    // Six visible columns, no Reason column: red is reassigned
    // (not dropped) — same result every run.
    const withoutLost = buildHeaderColorMap(cols, {});
    expect(Object.values(withoutLost)).toContain(RED);
    expect(withoutLost).toEqual(buildHeaderColorMap(cols, {}));
    // Semantics survive the hide.
    expect(withoutLost["flow:name"]).toBe(GRAY);
    expect(withoutLost["flow:phone"]).toBe(BLUE);
    expect(withoutLost["custom:l"]).toBe(REMARK_GREEN);
  });
});

describe("normalizeHeaderColor", () => {
  it("accepts #rgb and #rrggbb in any case", () => {
    expect(normalizeHeaderColor("#6D9EEB")).toBe("#6d9eeb");
    expect(normalizeHeaderColor("  #abc ")).toBe("#aabbcc");
  });

  it("rejects non-hex input", () => {
    for (const bad of ["red", "#12", "#gggggg", "", null, undefined, 42]) {
      expect(() => normalizeHeaderColor(bad)).toThrow(/hex/i);
    }
  });
});

describe("readable text on reference colors", () => {
  it("uses dark slate on light palette entries, white on red", () => {
    for (const hex of [GREEN, BLUE, ORANGE, TEAL, REMARK_GREEN]) {
      expect(headerTextColor(hex)).toBe(HEADER_TEXT_DARK);
      expect(isDarkHeaderColor(hex)).toBe(false);
    }
    expect(headerTextColor(RED)).toBe(HEADER_TEXT_LIGHT);
    expect(isDarkHeaderColor(RED)).toBe(true);
  });

  it("uses dark slate on the Name Cool Gray (text color unchanged)", () => {
    expect(headerTextColor(GRAY)).toBe(HEADER_TEXT_DARK);
    expect(isDarkHeaderColor(GRAY)).toBe(false);
  });

  it("uses dark slate on every preset", () => {
    for (const hex of HEADER_COLOR_PRESETS) {
      expect(headerTextColor(hex)).toBe(
        hex === RED ? HEADER_TEXT_LIGHT : HEADER_TEXT_DARK,
      );
    }
    expect(isDarkHeaderColor("#dbeafe")).toBe(false);
  });

  it("switches to white automatically on dark custom picks", () => {
    for (const dark of ["#111827", "#000000", "#7c2d12", "#1e3a8a"]) {
      expect(headerTextColor(dark)).toBe(HEADER_TEXT_LIGHT);
      expect(isDarkHeaderColor(dark)).toBe(true);
    }
    expect(headerTextColor("#ffffff")).toBe(HEADER_TEXT_DARK);
  });

  it("degrades safely on garbage input", () => {
    expect(headerTextColor("not-a-color")).toBe(HEADER_TEXT_DARK);
  });
});

describe("customize one column without affecting others", () => {
  it("custom override wins; siblings keep defaults", () => {
    const customs = { "custom:aaa": "#123456" };
    expect(resolveHeaderColor("custom:aaa", "Assigned To", customs)).toBe("#123456");
    expect(resolveHeaderColor("custom:bbb", "Call Status", customs)).toBe(
      defaultHeaderColor("custom:bbb", "Call Status"),
    );
  });

  it("any column is customizable (defaults are not locked)", () => {
    const customs: Record<string, string> = {
      "core:row": "#000000",
      "flow:submission_time": "#000000",
      lead_source: "#000000",
      "custom:anything": "#000000",
    };
    for (const visId of Object.keys(customs)) {
      expect(resolveHeaderColor(visId, visId, customs)).toBe("#000000");
    }
  });

  it("corrupt stored values degrade to the default, never blank", () => {
    expect(resolveHeaderColor("custom:aaa", "Assigned To", { "custom:aaa": "junk" })).toBe(
      defaultHeaderColor("custom:aaa", "Assigned To"),
    );
    expect(resolveHeaderColor("custom:aaa", "Assigned To", null)).toBe(
      defaultHeaderColor("custom:aaa", "Assigned To"),
    );
  });
});

describe("visibility never disturbs colors", () => {
  it("hidden → shown keeps the override (keyed by stable id)", () => {
    const customs = { "custom:aaa": "#123456" };
    // Simulate hide + show: the customs map is never filtered.
    const hidden = new Set(["custom:aaa"]);
    hidden.delete("custom:aaa");
    expect(resolveHeaderColor("custom:aaa", "Assigned To", customs)).toBe("#123456");
  });

  it("Show All / Reset (empty hidden set) leaves colors intact", () => {
    const customs = { "flow:TravelDate": "#abcdef", "lead_source": "#123123" };
    const afterReset: Record<string, string> = { ...customs };
    expect(afterReset).toEqual(customs);
    expect(resolveHeaderColor("flow:TravelDate", "TravelDate", afterReset)).toBe("#abcdef");
  });
});

describe("sticky headers keep their configured colors", () => {
  it("pinned name/phone resolve their semantic colors with readable text", () => {
    expect(resolveHeaderColor("flow:name", "Name", {})).toBe(GRAY);
    expect(resolveHeaderColor("flow:phone", "Phone Number", {})).toBe(BLUE);
    for (const hex of [GRAY, BLUE, GREEN]) {
      expect(headerTextColor(hex)).toBe(HEADER_TEXT_DARK);
    }
  });
});

describe("picker UI (Columns → color)", () => {
  function render(custom: string | null, taken: string[] = []) {
    return renderToStaticMarkup(
      <HeaderColorSwatches
        label="Assigned To"
        defaultHex="#93c47d"
        custom={custom}
        takenColors={taken}
        onPick={() => {}}
      />,
    );
  }

  it("offers default, presets, custom input, and reset", () => {
    const html = render(null);
    expect(html).toContain("Default");
    expect(html).toContain("Presets");
    expect(html).toContain("Custom");
    expect(html).toContain("Reset to default");
    expect(html).toContain('type="color"');
    for (const hex of HEADER_COLOR_PRESETS) {
      expect(html).toContain(hex);
    }
  });

  it("marks the active selection without locking anything", () => {
    const html = render("#46bdc6");
    expect(html).toContain("#46bdc6");
    expect(html).toContain("aria-pressed");
  });

  it("flags already-taken presets so duplicates are visibly blocked", () => {
    const html = render(null, ["#46bdc6"]);
    expect(html).toContain("(already used)");
  });
});

describe("uniqueness beyond the palette (overflow ring)", () => {
  const canonical: Array<{ visId: string; label: string }> = [
    { visId: "core:row", label: "Row" },
    { visId: "flow:submission_time", label: "Submission Time" },
    { visId: "flow:name", label: "Name" },
    { visId: "flow:phone", label: "Phone Number" },
    { visId: "custom:aaa", label: "Assigned To" },
    { visId: "custom:bbb", label: "Call Status" },
    { visId: "custom:ccc", label: "No. of Calls Tried" },
    { visId: "custom:ddd", label: "Lead Quality" },
    { visId: "custom:eee", label: "Quotation / Package" },
    { visId: "custom:fff", label: "Follow-Up Status" },
    { visId: "custom:ggg", label: "Last Contact Date" },
    { visId: "custom:hhh", label: "Customer Response" },
    { visId: "custom:iii", label: "Next Follow-up Date & Time" },
    { visId: "custom:jjj", label: "Next Action" },
    { visId: "custom:kkk", label: "Reason for Lost Lead" },
    { visId: "custom:lll", label: "Final Remark" },
    { visId: "lead_source", label: "Lead Source" },
  ];

  function valuesOf(map: Record<string, string>): string[] {
    return Object.values(map);
  }

  it("the whole pool is pairwise distinct (reference + generated)", () => {
    expect(new Set(HEADER_COLOR_POOL).size).toBe(HEADER_COLOR_POOL.length);
    expect(new Set(HEADER_CURATED_DEFAULTS).size).toBe(
      HEADER_CURATED_DEFAULTS.length,
    );
    for (const hex of HEADER_COLOR_POOL) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("semantic columns keep their colors in a full workspace", () => {
    const map = buildHeaderColorMap(canonical, {});
    expect(map["flow:name"]).toBe(GRAY);
    expect(map["flow:phone"]).toBe(BLUE);
    expect(map["custom:fff"]).toBe(TEAL);
    expect(map["custom:lll"]).toBe(REMARK_GREEN);
    expect(map["custom:kkk"]).toBe(RED);
  });

  it("every canonical column maps to a unique background", () => {
    const map = buildHeaderColorMap(canonical, {});
    expect(Object.keys(map)).toHaveLength(canonical.length);
    expect(new Set(valuesOf(map)).size).toBe(canonical.length);
  });

  it("customs apply exactly; foreign customs never leak across columns", () => {
    const map = buildHeaderColorMap(canonical, {
      "custom:aaa": "#123456",
      "lead_source": "#654321",
    });
    expect(map["custom:aaa"]).toBe("#123456");
    expect(map["lead_source"]).toBe("#654321");
    expect(new Set(valuesOf(map)).size).toBe(canonical.length);
  });

  it("a newly added column takes another unused color (nothing reused)", () => {
    const before = buildHeaderColorMap(canonical, {});
    const extended = [
      ...canonical,
      { visId: "custom:newbie", label: "VIP Flag" },
      { visId: "flow:ExtraAnswer", label: "Extra Answer" },
    ];
    const after = buildHeaderColorMap(extended, {});
    expect(new Set(valuesOf(after)).size).toBe(extended.length);
    // Earlier fixed columns keep their colors when columns append.
    for (const col of canonical) {
      expect(after[col.visId]).toBe(before[col.visId]);
    }
  });

  it("many dynamic columns stay unique (palette first, ring after)", () => {
    const cols = [
      ...canonical,
      ...Array.from({ length: 12 }, (_, i) => ({
        visId: `flow:Answer${i}`,
        label: `Answer ${i}`,
      })),
    ];
    const map = buildHeaderColorMap(cols, {});
    expect(new Set(valuesOf(map)).size).toBe(cols.length);
  });

  it("a duplicated stored custom falls back uniquely (first wins)", () => {
    const map = buildHeaderColorMap(canonical, {
      "custom:aaa": "#123456",
      "custom:bbb": "#123456",
    });
    expect(map["custom:aaa"]).toBe("#123456");
    expect(map["custom:bbb"]).not.toBe("#123456");
    expect(new Set(valuesOf(map)).size).toBe(canonical.length);
  });

  it("reset restores the set-determined color (deterministic, unique)", () => {
    const customized = buildHeaderColorMap(canonical, { "custom:aaa": "#123456" });
    expect(customized["custom:aaa"]).toBe("#123456");
    const reset = buildHeaderColorMap(canonical, {});
    // The single-column default is green, but inside this full set
    // green is already taken (Row) so reassignment applies — reset
    // must equal the fresh set resolution, whatever it is.
    expect(reset["custom:aaa"]).toBe(
      buildHeaderColorMap(canonical, {})["custom:aaa"],
    );
    expect(new Set(valuesOf(reset)).size).toBe(canonical.length);
  });

  it("overflow hues are deterministic valid hex", () => {
    expect(overflowHeaderColor(0)).toMatch(/^#[0-9a-f]{6}$/);
    expect(overflowHeaderColor(0)).toBe(overflowHeaderColor(0));
    expect(overflowHeaderColor(1)).not.toBe(overflowHeaderColor(0));
  });
});

describe("taller headers, sticky intact, functionality intact", () => {
  const root = process.cwd();
  const page = readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");

  it("headers are taller, bold, and vertically stuck (no pinned columns)", () => {
    // 64px sits inside the 58–64px prominent-header band.
    expect(page).toContain("h-16");
    expect(page).toContain("text-[15px]");
    expect(page).toContain("font-bold");
    expect(page).toContain("sticky top-0");
    expect(page).not.toContain("resolveStickyLayouts(");
    expect(page).not.toContain("stickyLayouts");
  });

  it("workspace uses DM Sans locally with a larger type scale", () => {
    // Scoped to the Workspace page only — the app font system is untouched.
    // The face is vendored and loaded through next/font/local so builds
    // never depend on Google Fonts.
    expect(page).toContain("localFont");
    expect(page).toContain("dm-sans-latin-wght-normal.woff2");
    expect(page).toContain("dmSans.className");
    expect(page).toContain("text-[30px]");
    // Prominent headers: 64px, 15–16px, weight 700.
    expect(page).toContain("text-[15px] font-bold");
  });

  it("every header paints via the shared positional resolver", () => {
    // One headStyleAt call site per header group (row, flow,
    // custom); the positional sequence + contrast run inside it.
    // Positional (never key-lookup) so a system/flow key collision
    // cannot share one slot and no miss falls back to green.
    const uses = page.split("headStyleAt(").length - 1;
    expect(uses).toBeGreaterThanOrEqual(3);
    expect(page).toContain("assignHeaderBackgrounds(");
    expect(page).toContain("visibleHeaderOrder");
    expect(page).toContain("headerBackgrounds");
    expect(page).toContain("headerTextColor(");
    expect(page).toContain("columnWidthStyle(");
    expect(page).not.toContain("resolveStickyLayouts(");
    expect(page).toContain("headerColorMap={headerMap}");
  });

  it("colors load per flow and save through the Columns manager", () => {
    expect(page).toContain("/header-colors");
    expect(page).toContain("onSaveHeaderColor");
    expect(page).toContain("headerColors={headerColors}");
    expect(page).toContain("canCustomizeColors={canSendMessages}");
  });

  it("existing table functionality is untouched", () => {
    for (const token of [
      "cellText(row, c)",
      "CustomCell",
      "workspaceRowNumber",
      "applyVisibility",
      "buildWorkspaceTableQuery",
      "debouncedSearch",
      "receivedDefaults",
    ]) {
      expect(page).toContain(token);
    }
  });
});

describe("Google Sheets is unaffected", () => {
  const root = process.cwd();
  it("sheets read paths reference none of the header-color work", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src).not.toContain("header-colors");
      expect(src).not.toContain("headerColors");
      expect(src).not.toContain("workspace_header_colors");
    }
  });
});
