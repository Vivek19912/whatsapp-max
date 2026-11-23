// All Meta Leads follow-up KPI strip — single-strip contract.
//
// Regression: the page rendered BOTH the aggregated All Meta strip
// (real counts) AND the individual-table strip keyed by the virtual
// flow id (which 404s → a second row of dashes plus a bogus
// "Follow-up counts are unavailable. Retry").
//
// Contract pinned here:
// - All Meta Leads renders ONLY <AllMetaFollowupKpis> (aggregated
//   endpoint, single error state with retry).
// - The individual <WorkspaceFollowupKpis> strip is gated off for
//   the virtual view but untouched for real Meta tables.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pageSrc = () =>
  readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");
const stripsSrc = () =>
  readFileSync(`${root}/src/components/workspace/workspace-followup-kpis.tsx`, "utf8");

describe("all meta leads — exactly one follow-up KPI strip", () => {
  it("renders the aggregated strip for the All view", () => {
    const src = pageSrc();
    expect(src).toContain("<AllMetaFollowupKpis");
    // The aggregated strip is the single source of truth here.
    expect(stripsSrc()).toContain("/api/workspace/all-meta-leads/followup-counts");
  });

  it("never renders the individual-table strip for the virtual view", () => {
    const src = pageSrc();
    // The per-table strip fetches /api/flows/<flowId>/followup-counts,
    // which cannot succeed for the non-UUID virtual id — it must be
    // gated off when the All view is selected.
    expect(src).toContain("isMetaTable && !isAllMetaLeads && followupFieldId && flowId");
    expect(src).not.toContain("isMetaTable && followupFieldId && flowId");
  });

  it("keeps the individual strip for real Meta tables", () => {
    const src = pageSrc();
    expect(src).toContain("<WorkspaceFollowupKpis");
    expect(src).toContain("followupFieldId={followupFieldId}");
    expect(stripsSrc()).toContain("/api/flows/${flowId}/followup-counts");
  });

  it("the aggregated strip owns one error state with retry (no duplicate rows)", () => {
    const src = stripsSrc();
    // One shared card renderer: a single error line + Retry action
    // owned by the aggregated component — not a second strip.
    expect(src).toContain("Follow-up counts are unavailable.");
    expect(src).toContain("onRetry");
    // The page mounts the aggregated strip exactly once.
    expect(pageSrc().split("<AllMetaFollowupKpis").length - 1).toBe(1);
  });
});
