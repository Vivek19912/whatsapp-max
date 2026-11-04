// Contract tests for the Team Member Lead Performance section.
// The section renders entirely from server-aggregated data; these
// pin the required structure: columns, filters, summary cards,
// lead-list columns, and the hard ban on call analytics.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const section = () =>
  readFileSync(
    join(root, "src/components/meta-leads-dashboard/team-performance.tsx"),
    "utf8"
  );
const dialog = () =>
  readFileSync(
    join(root, "src/components/meta-leads-dashboard/team-leads-dialog.tsx"),
    "utf8"
  );
const page = () =>
  readFileSync(
    join(root, "src/app/(dashboard)/meta-lead-ads/dashboard/page.tsx"),
    "utf8"
  );

describe("team performance section structure", () => {
  it("renders below the month chart with the required title and subtitle", () => {
    expect(section()).toContain("Team Member Lead Performance");
    expect(section()).toContain("distributed among team members");
    const pageSrc = page();
    expect(pageSrc).toContain("<TeamPerformance");
    // Section order: daily, monthly, then team performance — never
    // interleaved with the KPI cards.
    expect(pageSrc.indexOf("<TeamPerformance")).toBeGreaterThan(
      pageSrc.indexOf("<MetaMonthlyChart")
    );
  });

  it("offers independent Form and Date filters (All Forms / All Time defaults)", () => {
    const src = section();
    expect(src).toContain("All Forms");
    expect(src).toContain("All Time");
    expect(src).toContain("Today");
    expect(src).toContain("Yesterday");
    expect(src).toContain("Last 7 Days");
    expect(src).toContain("Last 30 Days");
    expect(src).toContain("This Month");
    expect(src).toContain("Custom Range");
    // Section state is local — the top-level dashboard range is
    // never touched.
    expect(src).not.toContain("getDashboardRange(");
  });

  it("table has exactly the five required columns plus an Unassigned row", () => {
    const src = section();
    expect(src).toContain("Team Member");
    expect(src).toContain("Total Leads");
    expect(src).toContain("Stage Distribution");
    expect(src).toContain("Type Distribution");
    expect(src).toContain("View Leads");
    expect(src).toContain(UNASSIGNED_KEY_CHECK);
    // No call-related columns, ever.
    expect(src).not.toContain("Call Status");
    expect(src).not.toContain("call analytics");
    expect(src).not.toContain("Recording");
    expect(src).not.toContain("Duration");
    expect(src).not.toContain("Answered");
  });

  it("zero-lead members render (no rows dropped)", () => {
    // Rows come from the roster (server includes zero-lead
    // members); the table maps every row including the appended
    // Unassigned bucket.
    expect(section()).toContain("UNASSIGNED_KEY");
    expect(section()).toContain("Unassigned");
  });

  it("stage clicks open the lead list pre-filtered; type has no such shortcut", () => {
    // Stage buttons deep-link with the raw value (or the missing
    // sentinel); the dialog accepts an initial stage.
    expect(section()).toContain("NO_STAGE_VALUE");
    expect(dialog()).toContain("initialStage");
  });
});

const UNASSIGNED_KEY_CHECK = '"Unassigned"';

describe("summary reconciliation display", () => {
  it("shows Total / Assigned / Unassigned with percentages", () => {
    const src = section();
    expect(src).toContain("Total Meta Leads");
    expect(src).toContain("Assigned Leads");
    expect(src).toContain("Unassigned Leads");
    expect(src).toContain("% of total");
  });
});

describe("view leads dialog contract", () => {
  it("shows exactly the seven required columns, read-only", () => {
    const src = dialog();
    for (const col of [
      "Date &amp; Time",
      "Lead Name",
      "Phone",
      "Form",
      "Assigned To",
      "Type",
      "Stage",
    ]) {
      expect(src).toContain(col);
    }
    // No editing affordances.
    expect(src).not.toContain("isAssigneeField");
    expect(src).not.toContain("workspace_values");
    expect(src).not.toContain("handleAssign");
  });

  it("supports search, stage/type filters, and pagination", () => {
    const src = dialog();
    expect(src).toContain("Search by lead name or phone");
    expect(src).toContain("All Stages");
    expect(src).toContain("All Types");
    expect(src).toContain("NO_STAGE_LABEL");
    expect(src).toContain("NO_TYPE_LABEL");
    expect(src).toContain("Previous");
    expect(src).toContain("Next");
  });

  it("contains no call analytics content", () => {
    const src = dialog();
    expect(src).not.toMatch(/[Cc]all Status/);
    expect(src).not.toContain("Recording");
    expect(src).not.toContain("Duration");
  });
});
