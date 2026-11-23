import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pageSrc = () =>
  readFileSync(`${root}/src/app/(dashboard)/table-assignments/page.tsx`, "utf8");
const apiSrc = () =>
  readFileSync(`${root}/src/app/api/workspace/table-assignments/route.ts`, "utf8");
const sidebarSrc = () =>
  readFileSync(`${root}/src/components/layout/sidebar.tsx`, "utf8");

describe("table assignments — owner-only access", () => {
  it("page hides from non-owners with an owner-only gate (nav is not the enforcement)", () => {
    const src = pageSrc();
    expect(src).toContain('accountRole !== "owner"');
    expect(src).toContain("Owner only");
    // The API enforces it server-side: non-owners get 403.
    expect(apiSrc()).toContain('requireRole("owner")');
  });

  it("sidebar lists Table Assignments after Notifications and gates it to owners", () => {
    const src = sidebarSrc();
    const itemIdx = src.indexOf('"/table-assignments"');
    expect(itemIdx).toBeGreaterThan(-1);
    expect(src.indexOf('"/notifications"')).toBeLessThan(itemIdx);
    const gateIdx = src.indexOf('if (item.href === "/table-assignments") return isOwner;');
    expect(gateIdx).toBeGreaterThan(-1);
  });
});

describe("table assignments — reuse of the existing assignment system", () => {
  it("edits through the existing four-step wizard dialog (no parallel UI)", () => {
    const src = pageSrc();
    expect(src).toContain("TableAssignmentDialog");
    expect(src).toContain('tableKind="meta_lead_ads"');
    expect(src).toContain("viewMode");
  });

  it("pauses/resumes through the existing per-table status endpoint", () => {
    expect(pageSrc()).toContain("assignment/status");
    expect(pageSrc()).toContain("row.flowId");
  });

  it("opens the original Workspace table via the existing selection mechanism", () => {
    const src = pageSrc();
    expect(src).toContain("saveSelectedFlowId");
    expect(src).toContain("/workspace?table=");
  });
});

describe("table assignments — listing contract", () => {  it("derives method/status/KPIs from saved config (no invented states)", () => {
    const src = pageSrc();
    expect(src).toContain("deriveTableStatus");
    expect(src).toContain("deriveMethodLabel");
    expect(src).toContain("computeKpis");
    expect(src).toContain("filterOverviewTables");
  });

  it("reuses shared pagination + filter + card primitives", () => {
    const src = pageSrc();
    expect(src).toContain("WorkspacePagination");
    expect(src).toContain("workspaceRowNumber");
    expect(src).toContain("isWorkspacePageSize");
    expect(src).toContain("KpiCard");
    expect(src).toContain("EmptyState");
  });

  it("never exposes private contact channels in the list payload", () => {
    expect(apiSrc()).not.toMatch(/select\([^)]*email[^)]*\)/);
  });
});

describe("table assignments — workspace deep link (?table=)", () => {
  const wsSrc = () =>
    readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");

  it("honors an explicit table param for hidden tables without disturbing normal selection", () => {
    const src = wsSrc();
    // Deep link wins over the remembered selection when valid ...
    expect(src).toContain("new URLSearchParams(window.location.search).get(\"table\")");
    expect(src).toContain("explicitTableRef.current = deepLinked;");
    // ... and the hidden-table fallback skips the pinned selection ...
    expect(src).toContain("explicitTableRef.current !== null && explicitTableRef.current === flowId");
    // ... until the user manually picks another table.
    expect(src).toContain("Manual selection releases any ?table= deep-link pin.");
  });
});
