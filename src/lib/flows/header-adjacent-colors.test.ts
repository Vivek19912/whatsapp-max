import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  areAdjacentBackgroundsDistinct,
  areAdjacentHeaderColorsDistinct,
  assignHeaderBackgrounds,
  buildHeaderColorMap,
  HEADER_COLOR_POOL,
  HEADER_REFERENCE_PALETTE,
  normalizeRenderedColor,
  type HeaderColumnRef,
} from "./header-colors";

// ---------------------------------------------------------------------------
// Workspace table: adjacent visible headers never share a background.
// Colors derive from the EXACT rendered visible order and paint
// positionally (backgrounds[i] → headers[i]), so there is no key
// lookup to miss and no per-column fallback to repaint neighbours
// green. Hiding, showing, reordering, or adding columns rebuilds
// the sequence; palette exhaustion cycles to another existing
// color instead of naively repeating. First/last columns are the
// ends of the same pairwise sweep, so the horizontally scrollable
// tail obeys the same rule.
// ---------------------------------------------------------------------------

function cols(ids: string[]): HeaderColumnRef[] {
  return ids.map((visId, i) => ({ visId, label: `Column ${i}` }));
}

function assertAdjacentDistinct(
  columns: HeaderColumnRef[],
  map: Record<string, string>,
) {
  expect(areAdjacentHeaderColorsDistinct(columns, map)).toBe(true);
  for (let k = 1; k < columns.length; k++) {
    expect(
      normalizeRenderedColor(map[columns[k].visId]),
    ).not.toBe(normalizeRenderedColor(map[columns[k - 1].visId]));
  }
}

function assertPositionalDistinct(backgrounds: readonly string[]) {
  expect(areAdjacentBackgroundsDistinct(backgrounds)).toBe(true);
  for (let k = 1; k < backgrounds.length; k++) {
    expect(normalizeRenderedColor(backgrounds[k])).not.toBe(
      normalizeRenderedColor(backgrounds[k - 1]),
    );
  }
}

/**
 * Mirror of the page's visibleHeaderOrder construction: row when
 * visible, flow columns keyed by RENDER key with the legacy
 * visibility id as customs fallback, business columns in display
 * order. The regression tests below run the real assignment
 * against this exact shape.
 */
function renderOrder(args: {
  rowVisible?: boolean;
  flow: Array<{ key: string; label: string; system: boolean }>;
  business: Array<{ id: string; name: string }>;
}): HeaderColumnRef[] {
  const { rowVisible = true, flow, business } = args;
  return [
    ...(rowVisible ? [{ visId: "core:row", label: "Row" }] : []),
    ...flow.map((c) => ({
      visId: `${c.system ? "sys" : "flow"}:${c.key}`,
      label: c.label,
      fallbackIds: [`flow:${c.key}`],
    })),
    ...business.map((f) => ({ visId: `custom:${f.id}`, label: f.name })),
  ];
}

describe("default visible columns", () => {
  it("adjacent default headers differ", () => {
    const columns: HeaderColumnRef[] = [
      { visId: "core:row", label: "Row" },
      { visId: "flow:submission_time", label: "Submission Time" },
      { visId: "flow:name", label: "Name" },
      { visId: "flow:phone", label: "Phone Number" },
      { visId: "custom:a", label: "Assigned To" },
      { visId: "custom:b", label: "Call Status" },
    ];
    assertAdjacentDistinct(columns, buildHeaderColorMap(columns, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(columns, {}));
  });

  it("user-added columns keep neighbours distinct", () => {
    const base = cols(["custom:a", "custom:b", "custom:c"]);
    const extended = [
      ...base,
      { visId: "custom:newbie", label: "VIP Flag" },
      { visId: "flow:ExtraAnswer", label: "Extra Answer" },
    ];
    assertAdjacentDistinct(extended, buildHeaderColorMap(extended, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(extended, {}));
  });
});

describe("hidden / shown columns", () => {
  it("hiding a middle column keeps the remaining neighbours distinct", () => {
    const full = cols(["custom:a", "custom:b", "custom:c", "custom:d"]);
    const visible = [full[0], full[2], full[3]];
    assertAdjacentDistinct(visible, buildHeaderColorMap(visible, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(visible, {}));
  });

  it("showing the row column (first) keeps the first pair distinct", () => {
    const withoutRow = cols(["custom:a", "custom:b"]);
    const withRow: HeaderColumnRef[] = [
      { visId: "core:row", label: "Row" },
      ...withoutRow,
    ];
    const map = buildHeaderColorMap(withRow, {});
    assertAdjacentDistinct(withRow, map);
    expect(map["core:row"]).toBe("#f1f5f9");
    assertPositionalDistinct(assignHeaderBackgrounds(withRow, {}));
  });

  it("hiding the first column re-resolves the new first pair", () => {
    const full = cols(["custom:a", "custom:b", "custom:c"]);
    const visible = full.slice(1);
    assertAdjacentDistinct(visible, buildHeaderColorMap(visible, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(visible, {}));
  });

  it("restored columns return distinct inside the rendered order", () => {
    const order = renderOrder({
      flow: [
        { key: "submission_time", label: "Submission Time", system: true },
        { key: "phone", label: "Phone Number", system: true },
      ],
      business: [
        { id: "b1", name: "Assigned To" },
        { id: "b2", name: "Call Status" },
      ],
    });
    assertPositionalDistinct(assignHeaderBackgrounds(order, {}));
  });
});

describe("reordered columns", () => {
  it("reversed and rotated orders stay adjacent-distinct", () => {
    const ordered = cols(["custom:a", "custom:b", "custom:c", "custom:d"]);
    const reversed = [...ordered].reverse();
    const rotated = [...ordered.slice(2), ...ordered.slice(0, 2)];
    assertAdjacentDistinct(reversed, buildHeaderColorMap(reversed, {}));
    assertAdjacentDistinct(rotated, buildHeaderColorMap(rotated, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(reversed, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(rotated, {}));
  });

  it("business display reorder (Assigned To first) stays distinct", () => {
    const stored: HeaderColumnRef[] = [
      { visId: "custom:rest", label: "Lead Quality" },
      { visId: "custom:assigned", label: "Assigned To" },
      { visId: "custom:other", label: "Call Status" },
    ];
    const display = [stored[1], stored[0], stored[2]];
    assertAdjacentDistinct(display, buildHeaderColorMap(display, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(display, {}));
  });
});

describe("system/flow key collisions (previous root cause)", () => {
  // A flow answer whose var_key is exactly "name" sits beside the
  // system Name column ("WhatsApp Name"). The legacy visibility id
  // (`flow:name`) is identical for both, while the table renders
  // them as separate headers (React keys `sys:name` / `flow:name`).
  // The old map keyed by visibility id collapsed both headers onto
  // one entry — sharing one background with no repair possible —
  // and any key miss fell back to the per-column green default.
  const colliding = renderOrder({
    flow: [
      { key: "submission_time", label: "Submission Time", system: true },
      { key: "name", label: "Name", system: false },
      { key: "name", label: "WhatsApp Name", system: true },
      { key: "phone", label: "Phone Number", system: true },
    ],
    business: [{ id: "b1", name: "Assigned To" }],
  });

  it("documents the old collapse: one legacy id cannot color two headers", () => {
    const legacy = [
      { visId: "core:row", label: "Row" },
      { visId: "flow:submission_time", label: "Submission Time" },
      { visId: "flow:name", label: "Name" },
      { visId: "flow:name", label: "WhatsApp Name" },
      { visId: "flow:phone", label: "Phone Number" },
    ];
    const map = buildHeaderColorMap(legacy, {});
    // One map entry serves two rendered headers — keyed lookup is
    // structurally unable to paint them differently.
    expect(Object.keys(map)).toHaveLength(4);
  });

  it("render-keyed positional assignment keeps the colliding pair distinct", () => {
    // System columns namespace to `sys:<key>`; the flow answer keeps
    // `flow:<key>` — the shared logical key "name" yields two slots.
    expect(colliding.map((c) => c.visId)).toEqual([
      "core:row",
      "sys:submission_time",
      "flow:name",
      "sys:name",
      "sys:phone",
      "custom:b1",
    ]);
    const backgrounds = assignHeaderBackgrounds(colliding, {});
    expect(backgrounds).toHaveLength(colliding.length);
    assertPositionalDistinct(backgrounds);
  });

  it("legacy stored customs still apply through fallbackIds", () => {
    const backgrounds = assignHeaderBackgrounds(colliding, {
      "flow:phone": "#123456",
    });
    const phoneIdx = colliding.findIndex((c) => c.visId === "sys:phone");
    expect(phoneIdx).toBeGreaterThan(-1);
    expect(backgrounds[phoneIdx]).toBe("#123456");
    assertPositionalDistinct(backgrounds);
  });
});

describe("palette cycling", () => {
  it("more columns than reference palette slots still never repeat consecutively", () => {
    const many = Array.from({ length: HEADER_REFERENCE_PALETTE.length + 4 }, (_, i) => ({
      visId: `custom:c${i}`,
      label: `Dynamic ${i}`,
    }));
    const map = buildHeaderColorMap(many, {});
    assertAdjacentDistinct(many, map);
    assertPositionalDistinct(assignHeaderBackgrounds(many, {}));
    for (const hex of Object.values(map)) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("more columns than the full pool cycles without consecutive repeats", () => {
    const many = Array.from({ length: HEADER_COLOR_POOL.length + 10 }, (_, i) => ({
      visId: `custom:pool${i}`,
      label: `Pool ${i}`,
    }));
    const backgrounds = assignHeaderBackgrounds(many, {});
    assertPositionalDistinct(backgrounds);
    // The scrollable tail (last initially-visible → first scrolled
    // column and every pair after it) obeys the same rule.
    for (let k = 1; k < backgrounds.length; k++) {
      expect(normalizeRenderedColor(backgrounds[k])).not.toBe(
        normalizeRenderedColor(backgrounds[k - 1]),
      );
    }
  });

  it("cycling never naively repeats the first slot onto a matching neighbour", () => {
    const many = Array.from({ length: HEADER_COLOR_POOL.length + 2 }, (_, i) => ({
      visId: `custom:rep${i}`,
      label: `Rep ${i}`,
    }));
    const backgrounds = assignHeaderBackgrounds(many, {
      // Force the first slot onto the pool's first color so a naive
      // `pool[i % len]` cycle would duplicate at the wrap point.
      "custom:rep0": HEADER_COLOR_POOL[0],
    });
    expect(backgrounds[0]).toBe(HEADER_COLOR_POOL[0]);
    assertPositionalDistinct(backgrounds);
  });

  it("cycling is deterministic for the same visible order", () => {
    const many = Array.from({ length: HEADER_REFERENCE_PALETTE.length + 3 }, (_, i) => ({
      visId: `custom:det${i}`,
      label: `Det ${i}`,
    }));
    expect(assignHeaderBackgrounds(many, {})).toEqual(
      assignHeaderBackgrounds(many, {}),
    );
  });
});

describe("customs and edge columns", () => {
  it("custom overrides keep neighbours distinct", () => {
    const columns = cols(["custom:a", "custom:b", "custom:c"]);
    const map = buildHeaderColorMap(columns, {
      "custom:b": "#123456",
    });
    expect(map["custom:b"]).toBe("#123456");
    assertAdjacentDistinct(columns, map);
    assertPositionalDistinct(
      assignHeaderBackgrounds(columns, { "custom:b": "#123456" }),
    );
  });

  it("single column and last-column pairs are handled", () => {
    const single = cols(["custom:only"]);
    const singleMap = buildHeaderColorMap(single, {});
    expect(Object.keys(singleMap)).toHaveLength(1);
    expect(areAdjacentHeaderColorsDistinct(single, singleMap)).toBe(true);
    const two = cols(["custom:a", "custom:b"]);
    assertAdjacentDistinct(two, buildHeaderColorMap(two, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(single, {}));
    assertPositionalDistinct(assignHeaderBackgrounds(two, {}));
  });

  it("equivalent colors in different formats count as equal", () => {
    expect(normalizeRenderedColor("#93C47D")).toBe("#93c47d");
    expect(normalizeRenderedColor("  #abc ")).toBe("#aabbcc");
    expect(normalizeRenderedColor("rgb(147, 196, 125)")).toBe("#93c47d");
    expect(areAdjacentBackgroundsDistinct(["#93c47d", "rgb(147,196,125)"])).toBe(
      false,
    );
    expect(areAdjacentBackgroundsDistinct(["#93c47d", "#6d9eeb"])).toBe(true);
  });
});

describe("rendered header styles (not just the helper)", () => {
  // Mirrors the screenshot failure: Submission Time / Name /
  // WhatsApp Name rendered three identical greens. Builds the
  // page-shaped order (including the sys/flow "name" collision),
  // assigns positionally, renders real <th> elements with the
  // computed inline styles, then asserts over the final ordered
  // header list: backgroundColor[i] !== backgroundColor[i - 1].
  function renderedBackgrounds(
    columns: HeaderColumnRef[],
    customs: Record<string, string> = {},
  ): string[] {
    const backgrounds = assignHeaderBackgrounds(columns, customs);
    const html = renderToStaticMarkup(
      createElement(
        "tr",
        null,
        ...columns.map((c, i) =>
          createElement("th", {
            key: `${c.visId}:${i}`,
            style: { backgroundColor: backgrounds[i] },
          }),
        ),
      ),
    );
    const found = [...html.matchAll(/background-color:\s*([^;"']+)/gi)].map(
      ([, color]) => color.trim(),
    );
    expect(found).toHaveLength(columns.length);
    return found;
  }

  it("rendered <th> backgrounds differ for every adjacent pair", () => {
    const columns = renderOrder({
      flow: [
        { key: "submission_time", label: "Submission Time", system: true },
        { key: "name", label: "Name", system: false },
        { key: "name", label: "WhatsApp Name", system: true },
        { key: "phone", label: "Phone Number", system: true },
        { key: "travel_month", label: "Travel Month", system: false },
        { key: "persons", label: "No of Persons", system: false },
      ],
      business: [
        { id: "b1", name: "Assigned To" },
        { id: "b2", name: "Special Request" },
        { id: "b3", name: "Hotel Category" },
        { id: "b4", name: "Nights" },
      ],
    });
    const rendered = renderedBackgrounds(columns);
    expect(areAdjacentBackgroundsDistinct(rendered)).toBe(true);
    for (let k = 1; k < rendered.length; k++) {
      expect(normalizeRenderedColor(rendered[k])).not.toBe(
        normalizeRenderedColor(rendered[k - 1]),
      );
    }
  });

  it("rendered scrollable tail keeps the rule past the last fixed column", () => {
    const columns = renderOrder({
      flow: Array.from({ length: HEADER_COLOR_POOL.length + 4 }, (_, i) => ({
        key: `answer_${i}`,
        label: `Answer ${i}`,
        system: false,
      })),
      business: [{ id: "tail", name: "Tail Column" }],
    });
    const rendered = renderedBackgrounds(columns);
    // Transition between the last initially visible column and the
    // subsequent horizontally scrollable columns, plus the tail.
    const boundary = HEADER_COLOR_POOL.length - 1;
    for (let k = 1; k < rendered.length; k++) {
      expect(normalizeRenderedColor(rendered[k])).not.toBe(
        normalizeRenderedColor(rendered[k - 1]),
      );
    }
    expect(normalizeRenderedColor(rendered[boundary + 1])).not.toBe(
      normalizeRenderedColor(rendered[boundary]),
    );
  });

  it("rendered headers stay distinct with customs, hides, and added columns", () => {
    const base = renderOrder({
      flow: [
        { key: "submission_time", label: "Submission Time", system: true },
        { key: "phone", label: "Phone Number", system: true },
      ],
      business: [
        { id: "b1", name: "Assigned To" },
        { id: "b2", name: "Call Status" },
      ],
    });
    // Hide the second column, add a custom column at the end.
    const visible = [
      base[0],
      base[2],
      base[3],
      base[4],
      { visId: "custom:newbie", label: "VIP Flag" },
    ];
    const rendered = renderedBackgrounds(visible, {
      "custom:b1": "#123456",
    });
    for (let k = 1; k < rendered.length; k++) {
      expect(normalizeRenderedColor(rendered[k])).not.toBe(
        normalizeRenderedColor(rendered[k - 1]),
      );
    }
  });
});

describe("workspace table wiring (scoped, design preserved)", () => {
  const root = process.cwd();
  const page = readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");

  it("header colors derive from the exact rendered order and paint positionally", () => {
    expect(page).toContain("visibleHeaderOrder");
    expect(page).toContain("assignHeaderBackgrounds(");
    expect(page).toContain("headerBackgrounds");
    expect(page).toContain("headStyleAt(");
    // Flow color slots use the namespaced render key so a
    // system/flow logical-key collision keeps separate entries.
    expect(page).toContain("flowColumnRenderKey(c)");
    // No key-lookup fallback that can repaint misses green.
    expect(page).not.toContain("headerMap[visId] ??");
  });

  it("preserves palette, typography, borders, and table design", () => {
    // Compact header band (44px, 13px semibold) with the same
    // positional colors, borders, and sticky behavior.
    expect(page).toContain("h-11");
    expect(page).toContain("text-[13px]");
    expect(page).toContain("font-semibold");
    expect(page).toContain("border-border");
    expect(page).toContain("sticky top-0");
  });

  it("does not paint body cells with header colors", () => {
    expect(page).not.toMatch(/TableCell[^>]*backgroundColor/);
  });
});
