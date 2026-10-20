import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Workspace column groups — Group 1 (system/contact) + Group 2
// (flow-derived) come from the table payload in derivation order;
// Group 3 (business/workspace) renders Assigned To, Received,
// Type, Stage first via orderBusinessColumns, then the rest in
// stored order. These are page-wiring assertions (same
// read-source pattern as the workspace scroll/grid tests):
// derivation lives in lib, the page only chooses render order.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

describe("Group 2 before Group 3 (flow columns render before business columns)", () => {
  it("flow header cells render before business header cells", () => {
    // Header cells paint positionally (headStyleAt) from
    // visibleHeaderOrder; the flow mapping precedes the business
    // mapping there, and the JSX header sites follow the same
    // sequence (flow header block before business header block).
    const orderFlow = pageSrc.indexOf("...flowColumnsVisible.map((c) => ({");
    const orderBusiness = pageSrc.indexOf("...customFieldsOrdered.map((f) => ({");
    expect(orderFlow).toBeGreaterThan(-1);
    expect(orderBusiness).toBeGreaterThan(orderFlow);
    const flowHead = pageSrc.indexOf("flowColumnsVisible.map((c, flowIdx) => {");
    const businessHead = pageSrc.indexOf("customFieldsOrdered.map((f, customIdx) => (");
    expect(flowHead).toBeGreaterThan(-1);
    expect(businessHead).toBeGreaterThan(flowHead);
  });

  it("flow body cells render before business body cells", () => {
    const flowBody = pageSrc.lastIndexOf("{flowColumnsVisible.map((c) => {");
    const businessBody = pageSrc.lastIndexOf("customFieldsOrdered.map((f) => (");
    expect(flowBody).toBeGreaterThan(-1);
    expect(businessBody).toBeGreaterThan(flowBody);
  });
});

describe("Group 3 pinned order (Assigned To, Received, Type, Stage)", () => {
  it("the page derives a display-ordered business list from visibility output", () => {
    expect(pageSrc).toContain("orderBusinessColumns(customFieldsVisible)");
    expect(pageSrc).toContain("customFieldsOrdered");
  });

  it("header, body, and color order all use the ordered list (never divergent)", () => {
    // visibleHeaderOrder (object form) uses the plain `(f) => ({`
    // opener; header cells take a positional index, body cells the
    // plain `(f) => (` form.
    const plain = pageSrc.split("customFieldsOrdered.map((f) => ({").length - 1;
    expect(plain).toBe(1);
    expect(pageSrc).toContain("customFieldsOrdered.map((f, customIdx) => (");
    expect(pageSrc).toContain("customFieldsOrdered.map((f) => (");
    // No JSX table render still uses the stored-order list.
    expect(pageSrc).not.toContain("{customFieldsVisible.map((f) => (");
  });

  it("visibility, widths, colors, and menu keep the stored-order identities", () => {
    // Header colors resolve on the DISPLAY order
    // (`...customFieldsOrdered`) so adjacent visible headers never
    // share a background after the pinned business reorder;
    // visibility/widths/menu still use stable stored identities.
    expect(pageSrc).toContain("...customFieldsOrdered.map((f) => ({");
    // The Columns menu reads the Meta-scoped list: Meta tables drop
    // Lead Received (it duplicates the Source answer column) while
    // Flow Tables pass the identical full-list reference through,
    // so their menu is unchanged.
    expect(pageSrc).toContain("customFields={customFieldsScoped}");
    expect(pageSrc).toContain(": customFields,");
  });
});
