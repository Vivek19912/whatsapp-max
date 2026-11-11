// Workspace table DOM validity — DndContext / SortableContext /
// DragOverlay must WRAP the native <table>, never live inside it.
//
// Background: dnd-kit renders screen-reader helpers (HiddenText +
// live region) as direct children of DndContext, and DragOverlay
// renders an inline wrapper div when active. Mounting DndContext
// between <table> and <thead> therefore puts <div>s inside the
// native table: invalid HTML, React validateDOMNesting warnings,
// and hydration mismatches. The fix keeps the exact same contexts,
// sensors, handlers, and overlay — only the hierarchy moved, so the
// providers now wrap the scroll viewport div instead.
//
// These tests pin the fixed hierarchy two ways:
//  1. source order in the real page (the regression guard — the old
//     code had <DndContext> AFTER <Table>);
//  2. rendered static markup of the same arrangement with the REAL
//     dnd-kit + shadcn primitives, checked by a stack-based HTML
//     validator (no jsdom needed; node environment).
// A negative control proves the validator actually catches a div
// placed directly inside table/thead/tbody/tr.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8"
);

function SortableHeaderCell({
  id,
  label,
  disabled,
}: {
  id: string;
  label: string;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef } = useSortable({
    id,
    disabled,
  });
  return (
    <TableHead ref={setNodeRef}>
      {!disabled ? (
        <button type="button" {...attributes} {...listeners} aria-label={`Drag ${label}`}>
          grip
        </button>
      ) : null}
      {label}
    </TableHead>
  );
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// Direct children allowed inside each native table section.
// Anything else (notably <div> from a misplaced provider) is
// invalid HTML and breaks hydration.
const ALLOWED_TABLE_CHILDREN: Record<string, Set<string>> = {
  table: new Set(["caption", "colgroup", "thead", "tbody", "tfoot"]),
  thead: new Set(["tr"]),
  tbody: new Set(["tr"]),
  tfoot: new Set(["tr"]),
  tr: new Set(["th", "td"]),
};

interface NestingViolation {
  parent: string;
  child: string;
  path: string;
}

/**
 * Minimal stack-based HTML validator: walks open/close tags and
 * reports any element directly nested inside a native table
 * section that the HTML spec forbids there. Text nodes, comments,
 * and everything inside th/td are unrestricted.
 */
export function findInvalidTableNesting(html: string): NestingViolation[] {
  const violations: NestingViolation[] = [];
  const stack: string[] = [];
  // Match tags while respecting quoted attribute values.
  const tagRe = /<(\/?)([A-Za-z][\w-]*)\b(?:(?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const [full, closing, rawName, selfClosing] = match;
    if (full.startsWith("<!--")) continue;
    const name = rawName.toLowerCase();
    if (name === "!doctype") continue;
    if (closing) {
      // Pop to the matching opener; anything unclosed above it is
      // malformed markup, which the validator also reports.
      const idx = stack.lastIndexOf(name);
      if (idx === -1) {
        violations.push({ parent: "(root)", child: `/${name}`, path: stack.join(">") });
      } else {
        stack.length = idx;
      }
      continue;
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : "(root)";
    const allowed = ALLOWED_TABLE_CHILDREN[parent];
    if (allowed && !allowed.has(name)) {
      violations.push({ parent, child: name, path: [...stack, name].join(">") });
    }
    const isVoid = VOID_ELEMENTS.has(name) || selfClosing === "/";
    if (!isVoid) stack.push(name);
  }
  return violations;
}

function FixedGrid() {
  const sensors = useSensors(useSensor(PointerSensor));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={() => {}}
    >
      <SortableContext items={["a", "b"]} strategy={horizontalListSortingStrategy}>
        <div className="workspace-table-viewport">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeaderCell id="a" label="A" />
                <SortableHeaderCell id="b" label="B" disabled />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>r1c1</TableCell>
                <TableCell>r1c2</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <DragOverlay>{null}</DragOverlay>
      </SortableContext>
    </DndContext>
  );
}

function renderFixedGrid() {
  return renderToStaticMarkup(<FixedGrid />);
}

describe("workspace grid: DnD providers wrap the native table", () => {
  it("opens DndContext before <table> and closes it after </table>", () => {
    const dndOpen = pageSrc.indexOf("<DndContext");
    const tableOpen = pageSrc.indexOf("<Table>");
    // NOTE: "</Table>" also appears inside a code comment, so the
    // real closing tag is the last occurrence in the file.
    const tableClose = pageSrc.lastIndexOf("</Table>");
    const dndClose = pageSrc.indexOf("</DndContext>");
    expect(dndOpen).toBeGreaterThanOrEqual(0);
    expect(tableOpen).toBeGreaterThanOrEqual(0);
    // Exactly one grid table in this file keeps the region math
    // below unambiguous.
    expect(pageSrc.indexOf("<Table>", tableOpen + 1)).toBe(-1);
    expect(dndOpen).toBeLessThan(tableOpen);
    expect(dndClose).toBeGreaterThan(tableClose);
  });

  it("opens SortableContext before <thead> and closes it after </table>", () => {
    const sortableOpen = pageSrc.indexOf("<SortableContext");
    const headOpen = pageSrc.indexOf("<TableHeader");
    const tableClose = pageSrc.lastIndexOf("</Table>");
    const sortableClose = pageSrc.indexOf("</SortableContext>");
    expect(sortableOpen).toBeGreaterThanOrEqual(0);
    expect(sortableOpen).toBeLessThan(headOpen);
    expect(sortableClose).toBeGreaterThan(tableClose);
  });

  it("keeps DragOverlay outside the native table, inside DndContext", () => {
    const overlayOpen = pageSrc.indexOf("<DragOverlay>");
    const overlayClose = pageSrc.indexOf("</DragOverlay>");
    const tableClose = pageSrc.lastIndexOf("</Table>");
    const dndClose = pageSrc.indexOf("</DndContext>");
    expect(overlayOpen).toBeGreaterThan(tableClose);
    expect(overlayClose).toBeLessThan(dndClose);
  });

  it("has no DnD tags between <table> and </table>", () => {
    const tableOpen = pageSrc.indexOf("<Table>");
    const tableClose = pageSrc.lastIndexOf("</Table>");
    const inner = pageSrc.slice(tableOpen, tableClose);
    expect(inner).not.toContain("<DndContext");
    expect(inner).not.toContain("<SortableContext");
    expect(inner).not.toContain("<DragOverlay>");
  });

  it("keeps every table section in the valid order (thead before tbody)", () => {
    const tableOpen = pageSrc.indexOf("<Table>");
    const tableClose = pageSrc.lastIndexOf("</Table>");
    const inner = pageSrc.slice(tableOpen, tableClose);
    const head = inner.indexOf("<TableHeader");
    const body = inner.indexOf("<TableBody");
    expect(head).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(head);
  });
});

describe("workspace grid: rendered table markup is valid HTML", () => {
  it("has no div inside native table elements (real dnd-kit + shadcn primitives)", () => {
    const html = renderFixedGrid();
    // Sanity: the grid actually rendered.
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<tbody");
    expect(html).toContain("Drag A");
    expect(findInvalidTableNesting(html)).toEqual([]);
  });

  it("keeps sortable wiring alive in the fixed hierarchy", () => {
    const html = renderFixedGrid();
    // Grip handles (useSortable attributes + listeners) still render
    // for eligible headers — drag is inert only when disabled.
    expect(html).toContain('aria-label="Drag A"');
    expect(html).not.toContain('aria-label="Drag B"');
    // Both columns render in items order.
    expect(html.indexOf(">A<")).toBeLessThan(html.indexOf(">B<"));
  });

  it("flags the old broken arrangement (provider div inside <table>)", () => {
    // Simulates the pre-fix mounted output: dnd-kit's HiddenText /
    // live-region div rendered as a direct table child.
    const broken = renderToStaticMarkup(
      <Table>
        <div data-dnd-accessibility="true">
          <TableHeader>
            <TableRow>
              <TableHead>H</TableHead>
            </TableRow>
          </TableHeader>
        </div>
        <TableBody>
          <TableRow>
            <TableCell>c</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    const violations = findInvalidTableNesting(broken);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.parent === "table" && v.child === "div")).toBe(true);
  });

  it("accepts divs inside cells (badges, buttons, menus stay legal)", () => {
    const html = renderToStaticMarkup(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>
              <div className="flex gap-1">
                <button type="button">Act</button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(findInvalidTableNesting(html)).toEqual([]);
  });
});

describe("other table variants stay provider-free (audited, unchanged)", () => {
  const read = (p: string) =>
    readFileSync(`${root}/src/${p}`, "utf8");

  it("pipeline board and settings keep DnD on plain divs (no tables)", () => {
    const board = read("components/pipelines/pipeline-board.tsx");
    expect(board).toContain("<DndContext");
    expect(board).not.toContain("<table");
    expect(board).not.toContain("<Table");
    const settings = read("components/pipelines/pipeline-settings.tsx");
    expect(settings).toContain("<DndContext");
    expect(settings).not.toContain("<table>");
    expect(settings).not.toContain("<Table>");
  });

  it("plain data tables use no DnD providers inside them", () => {
    for (const f of [
      "components/lead-assignment/lead-assignment-panel.tsx",
      "components/workspace/table-assignment-dialog.tsx",
      "components/recordings/recordings-table.tsx",
      "components/qr-codes/qr-codes-page.tsx",
    ]) {
      const src = read(f);
      if (src.includes("<Table")) {
        expect(src).not.toContain("<DndContext");
        expect(src).not.toContain("<SortableContext");
      }
    }
  });
});
