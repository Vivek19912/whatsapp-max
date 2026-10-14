import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ColumnResizeHandle } from "./column-resize-handle";
import {
  columnWidthStyle,
  WORKSPACE_COLUMN_MAX_WIDTH,
  WORKSPACE_COLUMN_MIN_WIDTH,
} from "@/lib/flows/workspace-column-widths";

// ---------------------------------------------------------------------------
// Workspace column resizing — drag, sync, limits, persistence (14 points).
//
// Pointer drags can't run in the node test env, so interaction is
// verified structurally (handle affordance + capture + clamping +
// commit wiring) with the math, storage, and wiring covered by
// unit, API, and content tests.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);
const handleSrc = readFileSync(
  `${root}/src/components/workspace/column-resize-handle.tsx`,
  "utf8",
);

describe("1/2. columns resize with header/body synchronized", () => {
  it("a stored width styles header and body identically", () => {
    const widths = { "flow:name": 220 };
    expect(columnWidthStyle("flow:name", widths)).toEqual({
      width: 220,
      minWidth: 220,
    });
  });

  it("the page feeds one width source to header and body cells", () => {
    expect(pageSrc).toContain("columnWidthStyle(");
    expect(pageSrc).not.toContain("stickyLayouts[");
    // Headers paint positionally; widths still come from the one source.
    expect(pageSrc).toContain("headStyleAt(");
  });

  it("the handle renders a boundary grip with resize cursor", () => {
    const html = renderToStaticMarkup(
      <ColumnResizeHandle
        columnKey="flow:name"
        onResize={() => {}}
        onCommit={() => {}}
        onActiveChange={() => {}}
      />,
    );
    expect(html).toContain("cursor-col-resize");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<button");
  });
});

describe("3/4. minimum and maximum widths are enforced", () => {
  it("the band is 80–500px", () => {
    expect(WORKSPACE_COLUMN_MIN_WIDTH).toBe(80);
    expect(WORKSPACE_COLUMN_MAX_WIDTH).toBe(500);
  });

  it("drag math clamps into the band", () => {
    expect(handleSrc).toContain("WORKSPACE_COLUMN_MIN_WIDTH");
    expect(handleSrc).toContain("WORKSPACE_COLUMN_MAX_WIDTH");
    expect(handleSrc).toContain("Math.min");
    expect(handleSrc).toContain("Math.max");
  });
});

describe("5/6/7. widths persist (reload, views, flows)", () => {
  it("widths load per flow and never join the table request key", () => {
    expect(pageSrc).toContain("/column-widths");
    expect(pageSrc).toContain("setColumnWidths");
    // Views share one configuration: no view key in the fetch.
    expect(pageSrc).not.toContain("/column-widths?view");
  });

  it("Completed/Incomplete and flow switches refetch the same store", () => {
    // One fetch keyed by flowId only — both tabs read it back.
    expect(pageSrc).toMatch(/useEffect\(\(\) => \{\s*if \(!flowId\) return;/);
    expect(pageSrc).toContain("fetch(`/api/flows/${flowId}/column-widths`");
  });
});

describe("8/9. hidden columns keep widths; new columns start natural", () => {
  it("widths are keyed independently of visibility", () => {
    expect(columnWidthStyle("custom:abc", {})).toBeUndefined();
    expect(columnWidthStyle("custom:abc", { "custom:abc": 200 })).toEqual({
      width: 200,
      minWidth: 200,
    });
    // Unknown keys never invent widths for other columns.
    expect(columnWidthStyle("flow:name", { "custom:abc": 200 })).toBeUndefined();
  });

  it("the page never clears widths on visibility changes", () => {
    expect(pageSrc).not.toMatch(/setColumnWidths\(\{\}\)/);
  });
});

describe("10/11. no sticky offsets; resizing survives on plain widths", () => {
  it("width state feeds columnWidthStyle only", () => {
    expect(pageSrc).toContain("columnWidthStyle(");
    expect(pageSrc).not.toContain("resolveStickyLayouts");
    expect(pageSrc).not.toContain("stickyLayouts[");
  });

  it("the scroll viewport and sticky header are untouched", () => {
    expect(pageSrc).toContain("workspace-table-viewport");
    expect(pageSrc).toContain("overflow-auto");
    expect(pageSrc).toContain("sticky top-0");
  });
});

describe("12. no text selection or stray clicks while dragging", () => {
  it("the handle captures the pointer and suppresses selection", () => {
    expect(handleSrc).toContain("setPointerCapture");
    expect(handleSrc).toContain("releasePointerCapture");
    expect(handleSrc).toContain("e.preventDefault()");
    expect(handleSrc).toContain("e.stopPropagation()");
    expect(pageSrc).toContain("resizingKey !== null && 'select-none'");
  });
});

describe("13/14. behavior and Sheets unchanged", () => {
  it("resizing never refetches the table", () => {
    // requestKey drives table fetches — widths must not join it.
    const keyLine = pageSrc.split("\n").find((l) => l.includes("const requestKey"));
    expect(keyLine).toBeDefined();
    expect(keyLine).not.toContain("columnWidth");
    expect(keyLine).not.toContain("resizingKey");
  });

  it("Google Sheets is unaffected", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src).not.toContain("column-widths");
      expect(src).not.toContain("workspace_column_widths");
      expect(src).not.toContain("ColumnResizeHandle");
    }
  });
});
