import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Workspace column groups — Group 1 (system/contact) + Group 2
// (flow-derived) come from the table payload in derivation order;
// Group 3 (business/workspace) renders Assigned To, Received,
// Type, Stage first via orderBusinessColumns, then the rest in
// stored order. Since the shared-order refactor, ONE ordered id
// list (orderedColumns) drives BOTH the header row and the body
// rows: header cell #k and body cell #k always resolve from the
// same stable-id entry, so render order can never diverge. These
// are page-wiring assertions (same read-source pattern as the
// workspace scroll/grid tests): derivation lives in lib, the page
// only chooses render order.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

describe("one shared order drives header and body (never divergent)", () => {
  it("both grid loops iterate the same orderedColumns list", () => {
    // Exactly two consumers: the header TableRow and the body
    // TableRow. No loop iterates flow/custom arrays directly.
    const consumers = pageSrc.split("orderedColumns.map((entry)").length - 1;
    expect(consumers).toBe(2);
    expect(pageSrc).not.toContain("flowColumnsVisible.map((c, flowIdx)");
    expect(pageSrc).not.toContain("customFieldsOrdered.map((f, customIdx)");
    expect(pageSrc).not.toContain("{flowColumnsVisible.map((c) => {");
  });

  it("header and body resolve through entry renderers, not indexes", () => {
    expect(pageSrc).toContain("renderHeaderEntry(entry)");
    expect(pageSrc).toContain("renderBodyEntry(entry, row, rowIndex)");
    // Paint positions come from the entry (shared with the body),
    // never from loop-local arithmetic.
    expect(pageSrc).toContain("headStyleAt(entry.paintIndex");
    expect(pageSrc).not.toContain("customOrderAt(");
    expect(pageSrc).not.toContain("synthOrderBase");
    expect(pageSrc).not.toContain("businessOrderBase");
  });
});

describe("Group 3 pinned order (Assigned To, Received, Type, Stage)", () => {
  it("the page derives a display-ordered business list from scoped fields", () => {
    expect(pageSrc).toContain("orderBusinessColumns(customFieldsScoped)");
    expect(pageSrc).toContain("allBusinessOrdered");
  });

  it("default order keeps payload sequence (no synthetic columns)", () => {
    expect(pageSrc).toContain("buildDefaultOrderIds({");
    expect(pageSrc).toContain("customIds: allBusinessOrdered.map(");
    // Saved orders merge onto the default; unknown ids drop, new
    // ids append, pinned ids stay first.
    expect(pageSrc).toContain("mergeColumnOrder({");
    // No synthetic Follow-up N Result columns: the retired
    // sequential system leaves no trace in the order model.
    expect(pageSrc).not.toContain("followup-result");
    expect(pageSrc).not.toContain("Follow-up ${");
  });

  it("visibility, widths, colors, and menu keep the stored-order identities", () => {    // Header colors resolve on the DISPLAY order (orderedColumns
    // entries) so adjacent visible headers never share a
    // background after the pinned business reorder;
    // visibility/widths/menu still use stable stored identities.
    expect(pageSrc).toContain("customFields={customFieldsScoped}");
    expect(pageSrc).toContain(": customFields,");
    // No synthetic result entries anywhere in the order model.
    expect(pageSrc).not.toContain("resultOrderId(");
    const libSrc = readFileSync(
      `${root}/src/lib/flows/workspace-column-order.ts`,
      "utf8",
    );
    expect(libSrc).not.toContain("RESULT_ORDER_PREFIX");
    expect(libSrc).not.toContain("resultOrderId");
    expect(libSrc).not.toContain("kind: 'result'");
  });
});
