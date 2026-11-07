import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Meta Lead Ads dashboard KPI cards — four cards in a fixed order,
// fed by the server-derived rolling KPIs. The page is a client
// component (no DOM under vitest's node environment), so layout
// and wiring are pinned via source.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/meta-lead-ads/dashboard/page.tsx`,
  "utf8",
);

describe("KPI card order and values", () => {
  it("renders four cards in order: Today, Yesterday, Last 7, Last 30", () => {
    const order = [
      'title="Today\'s Leads"',
      'title="Yesterday\'s Leads"',
      'title="Last 7 Days"',
      'title="Last 30 Days"',
    ];
    let from = -1;
    for (const title of order) {
      const idx = pageSrc.indexOf(title, from + 1);
      expect(idx, title).toBeGreaterThan(from);
      from = idx;
    }
  });

  it("binds each card to its own server-derived state", () => {
    expect(pageSrc).toContain("value={todayLeads}");
    expect(pageSrc).toContain("value={yesterdayLeads}");
    expect(pageSrc).toContain("value={last7Leads}");
    expect(pageSrc).toContain("value={last30Leads}");
    expect(pageSrc).toContain("setLast7Leads(d.last7Leads)");
    expect(pageSrc).toContain("setLast30Leads(d.last30Leads)");
  });

  it("keeps the responsive 1/2/4-column grid with four skeletons", () => {
    expect(pageSrc).toContain("grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4");
    for (const key of ["kpi-today", "kpi-yesterday", "kpi-last7", "kpi-last30"]) {
      expect(pageSrc).toContain(`key="${key}"`);
    }
  });

  it("leaves charts, routing, and headings untouched", () => {
    expect(pageSrc).toContain("<MetaDailyChart");
    expect(pageSrc).toContain("<MetaMonthlyChart");
    expect(pageSrc).not.toContain("TeamPerformance");
  });
});
