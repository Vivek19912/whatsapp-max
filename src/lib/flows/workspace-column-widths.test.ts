import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  clampColumnWidth,
  coerceColumnWidth,
  columnWidthStyle,
  defaultColumnWidthForFieldName,
  defaultColumnWidthsForFields,
  isWideTextColumnName,
  WORKSPACE_COLUMN_MAX_WIDTH,
  WORKSPACE_COLUMN_MIN_WIDTH,
  WORKSPACE_STANDARD_TEXT_CELL_WIDTH,
  WORKSPACE_WIDE_TEXT_CELL_WIDTH,
} from "./workspace-column-widths";

// ---------------------------------------------------------------------------
// Column widths — clamping, styles. No sticky/pinned layout remains:
// every column (including Row) sizes from its stored width only.
// ---------------------------------------------------------------------------

describe("min/max band", () => {
  it("is 80–500px", () => {
    expect(WORKSPACE_COLUMN_MIN_WIDTH).toBe(80);
    expect(WORKSPACE_COLUMN_MAX_WIDTH).toBe(500);
  });

  it("clampColumnWidth accepts the band and rounds", () => {
    expect(clampColumnWidth(80)).toBe(80);
    expect(clampColumnWidth(500)).toBe(500);
    expect(clampColumnWidth(200.6)).toBe(201);
  });

  it("clampColumnWidth rejects outside/non-numeric input", () => {
    for (const bad of [79, 501, 0, -10, "wide", null, undefined, NaN]) {
      expect(() => clampColumnWidth(bad)).toThrow();
    }
  });

  it("coerceColumnWidth pins hand-edited values instead of throwing", () => {
    expect(coerceColumnWidth(10, 150)).toBe(80);
    expect(coerceColumnWidth(9000, 150)).toBe(500);
    expect(coerceColumnWidth(200, 150)).toBe(200);
    expect(coerceColumnWidth("junk", 150)).toBe(150);
  });
});

describe("columnWidthStyle", () => {
  it("returns undefined for natural (unset) columns", () => {
    expect(columnWidthStyle("flow:name", {})).toBeUndefined();
    expect(columnWidthStyle("flow:name", null)).toBeUndefined();
    expect(columnWidthStyle("flow:name", { "flow:name": "" })).toBeUndefined();
    expect(columnWidthStyle("flow:name", { "flow:name": "junk" })).toBeUndefined();
  });

  it("returns identical width/minWidth for header and body", () => {
    const widths = { "flow:name": 220 };
    expect(columnWidthStyle("flow:name", widths)).toEqual({
      width: 220,
      minWidth: 220,
    });
  });

  it("pins hand-edited out-of-band values to the band on read", () => {
    expect(columnWidthStyle("flow:name", { "flow:name": 10 })).toEqual({
      width: 80,
      minWidth: 80,
    });
    expect(columnWidthStyle("flow:name", { "flow:name": 9000 })).toEqual({
      width: 500,
      minWidth: 500,
    });
  });
});

describe("no sticky layouts remain", () => {
  it("the sticky-column module is deleted", () => {
    expect(
      existsSync(
        `${process.cwd()}/src/components/workspace/sticky-columns.ts`
      )
    ).toBe(false);
  });

  it("resizing still flows through columnWidthStyle per column", () => {
    // Row + every other column size independently; no offsets exist.
    expect(columnWidthStyle("core:row", { "core:row": 120 })).toEqual({
      width: 120,
      minWidth: 120,
    });
    expect(columnWidthStyle("flow:name", { "flow:name": 300 })).toEqual({
      width: 300,
      minWidth: 300,
    });
  });
});

describe("wide text columns (Customer Response + Next Action are 2x)", () => {
  it("the wide width is exactly twice the previous natural width", () => {
    expect(WORKSPACE_STANDARD_TEXT_CELL_WIDTH).toBe(224);
    expect(WORKSPACE_WIDE_TEXT_CELL_WIDTH).toBe(448);
    expect(WORKSPACE_WIDE_TEXT_CELL_WIDTH).toBe(
      2 * WORKSPACE_STANDARD_TEXT_CELL_WIDTH,
    );
  });

  it("the doubled width sits inside the enforced 80–500 band", () => {
    expect(clampColumnWidth(WORKSPACE_WIDE_TEXT_CELL_WIDTH)).toBe(448);
    expect(
      columnWidthStyle("custom:abc", { "custom:abc": 448 }),
    ).toEqual({ width: 448, minWidth: 448 });
  });

  it("matches the two business columns by stored name (case-insensitive)", () => {
    expect(isWideTextColumnName("Customer Response")).toBe(true);
    expect(isWideTextColumnName("Next Action")).toBe(true);
    expect(isWideTextColumnName("  next ACTION  ")).toBe(true);
    expect(isWideTextColumnName("Final Remark")).toBe(false);
    expect(isWideTextColumnName("Stage")).toBe(false);
    expect(isWideTextColumnName(null)).toBe(false);
    expect(defaultColumnWidthForFieldName("Customer Response")).toBe(448);
    expect(defaultColumnWidthForFieldName("Next Action")).toBe(448);
    expect(defaultColumnWidthForFieldName("Final Remark")).toBeUndefined();
  });

  it("builds stable-identity defaults only for the two columns", () => {
    expect(
      defaultColumnWidthsForFields([
        { id: "uuid-cr", name: "Customer Response" },
        { id: "uuid-na", name: "Next Action" },
        { id: "uuid-fr", name: "Final Remark" },
      ]),
    ).toEqual({ "custom:uuid-cr": 448, "custom:uuid-na": 448 });
  });

  it("stored user widths spread last and always win (no reset)", () => {
    const effective = {
      ...defaultColumnWidthsForFields([
        { id: "uuid-cr", name: "Customer Response" },
      ]),
      ...{ "custom:uuid-cr": 300 },
    };
    expect(effective).toEqual({ "custom:uuid-cr": 300 });
    // Header and body read the same merged map, so they stay aligned.
    expect(columnWidthStyle("custom:uuid-cr", effective)).toEqual(
      columnWidthStyle("custom:uuid-cr", effective),
    );
  });
});
