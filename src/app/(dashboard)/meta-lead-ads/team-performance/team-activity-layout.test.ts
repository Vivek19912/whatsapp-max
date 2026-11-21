// Team Performance dashboard — Workspace Activity layout contract.
//
// Pins: KPI + chart untouched, chart full-width, activity feed present
// with all five controls, removed sections gone.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const page = readFileSync(
  `${root}/src/app/(dashboard)/meta-lead-ads/team-performance/page.tsx`,
  "utf8",
);
const feed = readFileSync(
  `${root}/src/components/dashboard/team-activity-feed.tsx`,
  "utf8",
);
const api = readFileSync(
  `${root}/src/app/api/meta-lead-ads/team-activity/route.ts`,
  "utf8",
);

describe("team performance layout", () => {
  it("keeps KPIs and the stacked chart, chart full-width", () => {
    expect(page).toContain("Total Leads");
    expect(page).toContain("Assigned Leads by Team Member");
    expect(page).toContain("<TeamActivityFeed />");
    // No side-by-side grid constraining the chart anymore.
    expect(page).not.toContain("lg:grid-cols-2");
    expect(page).not.toContain("<StatusDistributionCard");
    expect(page).not.toContain("<MemberTableCard");
    expect(page).not.toContain("<TablesSummaryCard");
  });

  it("activity feed has the five required controls", () => {
    expect(feed).toContain("Search activity, lead name or table");
    expect(feed).toContain("All Team Members");
    expect(feed).toContain("All Activities");
    expect(feed).toContain("All Tables");
    expect(feed).toContain("Last 30 Days");
    expect(feed).toContain("Clear");
    expect(feed).toContain("Load More");
    expect(feed).toContain("Owner actions never appear here");
  });

  it("owner exclusion happens in the backend query, not the UI", () => {
    expect(api).toContain('requireRole("owner")');
    expect(api).toContain("neq(");
    expect(api).toContain("ownerId");
    expect(api).toContain("teamUserIds.has(actor)");
    expect(api).toContain("Cache-Control");
    expect(api).toContain("no-store");
  });
});
