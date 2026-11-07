import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";
import { buildFlowTableColumns } from "@/lib/flows/flow-tables";

// ---------------------------------------------------------------------------
// Workspace enterprise horizontal scroll — structural verification.
//
// Real pixel scrolling can't run in a node test env, so these tests
// lock the MECHANICS that produce the required behavior: a single
// scroll viewport (one native scrollbar pair), ZERO pinned/frozen
// columns (every column scrolls horizontally as one unified
// grid), a stuck opaque header for vertical scrolling, and
// untouched data plumbing (order, pagination, visibility,
// filters, Sheets).
// ---------------------------------------------------------------------------

const root = process.cwd();
const page = readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");
const globals = readFileSync(`${root}/src/app/globals.css`, "utf8");
const tablePrimitive = readFileSync(`${root}/src/components/ui/table.tsx`, "utf8");

describe("5. frozen No. + Name columns — everything else scrolls", () => {
  it("the removed sticky-column module stays gone", () => {
    expect(
      existsSync(`${root}/src/components/workspace/sticky-columns.ts`)
    ).toBe(false);
  });

  it("the page carries no legacy sticky/pinned machinery", () => {
    for (const token of [
      "stickyLayouts",
      "resolveStickyLayouts",
      "stickyColumnStyle",
      "isStickyColumnKey",
      "visibleStickyKeys",
      "STICKY_Z",
      "STICKY_ROW_COLUMN_KEY",
      "STICKY_COLUMN_ORDER",
      "STICKY_FLOW_COLUMN_KEYS",
    ]) {
      expect(page).not.toContain(token);
    }
  });

  it("only No. and Name freeze; row, system, flow, custom, and lead columns all scroll normally", () => {
    // Row renders conditionally like any column (no frozen twin).
    expect(page).toContain("{rowVisible && (");
    // Exactly two sticky column offsets exist: No. at the viewport
    // edge and Name after its measured width. Every other body
    // cell carries no sticky positioning.
    expect(page).toContain("sticky left-0 z-[1]");
    expect(page).toContain("left: nameLeft");
    // Frozen identity is the system `name` key (never the label),
    // for headers and body cells alike.
    const nameChecks = page.match(/c\.system && c\.key === 'name'/g) ?? [];
    expect(nameChecks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("6. header and body share one width source", () => {
  it("both cells size from columnWidthStyle (no separate geometry)", () => {
    const uses = page.split("columnWidthStyle(").length - 1;
    expect(uses).toBeGreaterThanOrEqual(4);
    expect(page).toContain("TableHead");
    expect(page).toContain("TableCell");
  });

  it("the stuck header keeps its divider (tr border merges to th border)", () => {
    // tailwind-merge must collapse the primitive's tr-level divider
    // in favour of the th-level one, which travels with stuck cells.
    expect(cn("[&_tr]:border-b", "[&_tr]:border-b-0")).toBe("[&_tr]:border-b-0");
    expect(page).toContain("[&_tr]:border-b-0");
  });

  it("flow columns render in payload order (data order untouched)", () => {
    const { columns } = buildFlowTableColumns([], null);
    expect(columns.map((c) => c.key).slice(0, 3)).toEqual([
      "submission_time",
      "name",
      "phone",
    ]);
    expect(columns[columns.length - 1].key).toBe("status");
  });
});

describe("1/4/7. single table viewport, no page scroll, vertical intact", () => {
  it("the table viewport owns scrolling with a viewport-relative bound", () => {
    expect(page).toContain("workspace-table-viewport");
    expect(page).toContain("overflow-y-auto");
    expect(page).toContain("overflow-x-hidden");
    expect(page).toContain("max-h-[70vh]");
    // No fixed-px viewport heights/widths that break screen sizes.
    expect(page).not.toMatch(/max-h-\[\d+px\]/);
  });

  it("the inner Table scroll container is neutralized (one scrollbar)", () => {
    expect(globals).toContain(".workspace-table-viewport");
    expect(globals).toContain('[data-slot="table-container"]');
    expect(globals).toMatch(/overflow:\s*visible/);
  });

  it("the shared Table primitive stays generic (no sticky leaked in)", () => {
    expect(tablePrimitive).not.toContain("sticky");
  });

  it("the page root creates no sideways scrolling of its own", () => {
    expect(page).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(globals).not.toMatch(/body\s*\{[^}]*overflow-x/);
  });

  it("pagination footer sits outside the horizontal scroll area", () => {
    const viewportIdx = page.indexOf("workspace-table-viewport");
    const footerIdx = page.indexOf("<WorkspacePagination");
    expect(viewportIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(viewportIdx);
    // Old standalone pager is gone; footer owns paging now.
    expect(page).not.toContain(">Previous<");
    expect(page).toContain("onPage={setPage}");
    expect(page).toContain("totalPages={totalPages}");
  });
});

describe("custom columns render last in the table", () => {
  it("thead: Row, flow map, then custom map — in that order", () => {
    const thead = page.slice(
      page.indexOf("<TableHeader"),
      page.indexOf("</TableHeader>")
    );
    const rowIdx = thead.indexOf("{rowVisible && (");
    const flowIdx = thead.indexOf("flowColumnsVisible.map");
    // Business columns render through the Group 3 display-ordered
    // list derived from the visibility output.
    const customIdx = thead.indexOf("customFieldsOrdered.map");
    expect(rowIdx).toBeGreaterThan(-1);
    expect(flowIdx).toBeGreaterThan(rowIdx);
    expect(customIdx).toBeGreaterThan(flowIdx);
    // No lead pseudo-column conditional remains.
    expect(thead).not.toContain("{leadSourceVisible && (");
  });

  it("tbody rows follow the same order", () => {
    const tbody = page.slice(page.indexOf("<TableBody"));
    const flowIdx = tbody.indexOf("flowColumnsVisible.map");
    const customIdx = tbody.indexOf("customFieldsOrdered.map");
    expect(flowIdx).toBeGreaterThan(-1);
    expect(customIdx).toBeGreaterThan(flowIdx);
    expect(tbody).not.toContain("{leadSourceVisible && (");
    expect(tbody).not.toContain("<AdSourceCell");
  });
});

describe("8/9. pagination + visibility unchanged", () => {
  it("pagination plumbing is intact (footer owns paging)", () => {
    for (const token of [
      "workspaceRowNumber",
      "WorkspacePagination",
      "totalPages",
      "onPage={setPage}",
      "selectPageSize",
    ]) {
      expect(page).toContain(token);
    }
    // Old standalone pager is gone.
    expect(page).not.toContain(">Previous<");
  });

  it("column visibility plumbing is intact", () => {
    for (const token of [
      "applyVisibility",
      "useWorkspaceVisibility",
      "ColumnsMenu",
      "flowColumnsVisible",
      "customFieldsVisible",
    ]) {
      expect(page).toContain(token);
    }
    expect(page).not.toContain("leadSourceVisible");
  });

  it("no Lead Source pseudo-column remains in the table", () => {
    expect(page).not.toContain("LEAD_SOURCE_VIS_ID");
    expect(page).not.toContain("<AdSourceCell");
    expect(page).not.toContain("Lead Source\n");
  });

  it("renamed business headers render from stored field names", () => {
    // Headers render {formatColumnLabel(f.name)} — the provisioned
    // spec names below are what appear as Lead Type / Stage /
    // Lead Received; the legacy labels must not be hardcoded.
    expect(page).not.toContain("Lead Quality");
    expect(page).not.toContain("Quotation / Package");
    expect(page).not.toContain("AdSourceCell");
  });

  it("Lead Received detection feeds CustomCell without persisting", () => {
    expect(page).toContain("isLeadReceivedField");
    expect(page).toContain("receivedDefaults[row.runId]");
    expect(page).toContain("receivedDefaultLabel(adSourcePlatform(");
  });

  it("stored values win over detected defaults (never overwritten)", () => {
    const storedIdx = page.indexOf("customValues?.[row.runId]?.[f.id]");
    const detectedIdx = page.indexOf("receivedDefaults[row.runId]");
    expect(storedIdx).toBeGreaterThan(-1);
    expect(detectedIdx).toBeGreaterThan(storedIdx);
  });

  it("filters, search, and views are untouched", () => {
    for (const token of [
      "WorkspaceFilters",
      "debouncedSearch",
      "selectView",
      "VIEWS",
    ]) {
      expect(page).toContain(token);
    }
  });
});

describe("10. no regression to Google Sheets or Workspace data", () => {
  it("sheets read paths reference none of the scroll work", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src).not.toContain("workspace-table-viewport");
      expect(src).not.toContain("stickyColumnStyle");
    }
  });

  it("column definitions and data flow are untouched", () => {
    for (const token of ["cellText(row, c)", "CustomCell", "onSaved"]) {
      expect(page).toContain(token);
    }
  });
});
