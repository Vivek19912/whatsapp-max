import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Meta Lead Ads agent dashboard — role branching on the same URL.
// The page is a client component (no DOM under vitest's node
// environment), so branching, data sources, and headings are
// pinned via source. The owner dashboard must stay byte-identical
// in behavior (see kpi-cards.test.ts); this file pins the agent
// additions only.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/meta-lead-ads/dashboard/page.tsx`,
  "utf8",
);

describe("agent dashboard branching", () => {
  it("branches on accountRole from useAuth: owner keeps full dashboard, others get personal", () => {
    expect(pageSrc).toContain("useAuth");
    expect(pageSrc).toContain("accountRole");
    expect(pageSrc).toContain("accountRole === 'owner'");
    expect(pageSrc).toContain("My Dashboard");
  });

  it("agent cards: assigned total plus assigned day windows", () => {
    for (const title of [
      'title="My Assigned Leads"',
      'title="Today\'s Assigned Leads"',
      'title="Yesterday\'s Assigned Leads"',
    ]) {
      expect(pageSrc, title).toContain(title);
    }
  });

  it("agent data source is the self-scoped loader (never the owner endpoint)", () => {
    expect(pageSrc).toContain("loadMetaAgentAnalytics");
    // The endpoint URL lives in the loader (pinned in
    // agent-analytics-client.test.ts); the page must only call the
    // agent loader for the personal view and the owner loader for
    // the account view.
    expect(pageSrc).toContain("loadMetaLeadsAnalytics");
  });

  it("agent charts reuse the owner design with scoped titles plus a status overview", () => {
    expect(pageSrc).toContain('title="My Leads — Last 30 Days"');
    expect(pageSrc).toContain('title="Monthly Leads"');
    expect(pageSrc).toContain("MetaStatusOverview");
    expect(pageSrc).toContain("<MetaStatusOverview");
  });

  it("no new navigation pages; same URL serves both roles", () => {
    expect(pageSrc).not.toMatch(/href=.*meta-lead-ads/);
    expect(pageSrc).not.toContain("TeamPerformance");
  });
});
