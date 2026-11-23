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

describe("table assignments — table-name regression (blank column fix)", () => {
  it("normalizes the payload into the page model instead of trusting wire keys", () => {
    const src = pageSrc();
    // The page normalizes every payload row so a key mismatch can never
    // blank the Meta Lead Ads Table column again; the legacy
    // snake_case fallbacks live in the shared overview helper.
    expect(src).toContain("normalizeAssignmentTableRow");
    const libSrc = readFileSync(
      `${root}/src/lib/lead-assignment/table-overview.ts`,
      "utf8",
    );
    expect(libSrc).toContain("flow_id");
    expect(libSrc).toContain("flow_name");
  });

  it("renders the verbatim Workspace table name (full flows.name)", () => {
    const src = pageSrc();
    expect(src).toContain("{row.tableName}");
    // The API guarantees tableName is the full flows.name; the page
    // must not strip the "Meta Lead Ads ·" prefix or substitute ids.
    expect(apiSrc()).toContain("tableName");
    expect(apiSrc()).not.toContain("stripMetaPrefix");
  });
});

describe("table assignments — active-by-default + full assignee names", () => {
  it("loads with the Status filter preselected to Active (All Status still available)", () => {
    const src = pageSrc();
    expect(src).toContain('useState<AssignmentStatusFilter>("active")');
    // Every status option stays selectable — nothing is hidden or deleted.
    for (const value of ['value="active"', 'value="paused"', 'value="not_configured"', 'value="all"']) {
      expect(src).toContain(value);
    }
  });

  it("renders every assignee's full name with wrapping (no avatars, no +N truncation)", () => {
    const src = pageSrc();
    // Full comma-separated names from the saved roster rows.
    expect(src).toContain('join(", ")');
    expect(src).toContain("whitespace-normal");
    // The old avatar/+N presentation is gone.
    expect(src).not.toContain("MAX_VISIBLE_ASSIGNEES");
    expect(src).not.toContain("avatarToneFor");
    expect(src).not.toContain("initialsFor");
    expect(src).not.toContain("+{overflow}");
  });

  it("keeps allocation + status rendering from the saved configuration", () => {
    const src = pageSrc();
    expect(src).toContain("allocationText");
    expect(src).toContain("deriveTableStatus");
    expect(src).toContain("TableAssignmentDialog");
  });
});

describe("table assignments — listing contract", () => {
  it("derives method/status/KPIs from saved config (no invented states)", () => {
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
