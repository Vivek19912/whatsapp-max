import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// next/font/local only resolves inside a Next.js build — stub the
// loader so importing the page module works under vitest.
vi.mock("next/font/local", () => ({
  default: () => ({ className: "font-dm-sans-stub" }),
}));

import { FollowupResultCell } from "@/app/(dashboard)/workspace/page";

// ---------------------------------------------------------------------------
// Workspace Follow-up N Result columns: dynamically generated display
// columns (one per attempt number through the table-wide max),
// positioned after Customer Response, fed by
// sales_followup_attempts — never by Customer Response. The grid
// renders only in the browser, so structure is pinned as source
// contracts here; mapping behavior is covered by the table-route
// tests, and the cell renders below for real.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

describe("dynamic result column generation", () => {
  it("derives one column per attempt through the table-wide max", () => {
    expect(pageSrc).toContain("followupResultCount");
    expect(pageSrc).toContain("payload?.followupResults");
    expect(pageSrc).toContain("followupResults.maxAttempt");
    expect(pageSrc).toContain("followupResultNumbers");
    expect(pageSrc).toContain("Array.from({ length: followupResultCount }");
  });

  it("labels headers exactly Follow-up N Result", () => {
    expect(pageSrc).toContain("label: `Follow-up ${i + 1} Result`");
    expect(pageSrc).toContain("{`Follow-up ${n} Result`}");
  });

  it("inserts the block after Customer Response (tail fallback)", () => {
    expect(pageSrc).toContain("customerResponseIdx");
    expect(pageSrc).toContain("customer response");
    // Header order splice + body insertion share the anchor.
    expect(pageSrc).toContain("customerResponseIdx + 1");
    expect(pageSrc).toContain("customerResponseIdx === -1");
  });

  it("keeps header paint positional across the inserted block", () => {
    // Business columns after the anchor shift past the generated
    // entries; the synthetic block paints from its own base — no
    // slot reads past the backgrounds array end.
    expect(pageSrc).toContain("customOrderAt(customIdx)");
    expect(pageSrc).toContain("synthOrderBase");
    expect(pageSrc).toContain("headStyleAt(synthOrderBase + k)");
  });

  it("renders result cells at the same positions in every body row", () => {
    expect(pageSrc).toContain("<FollowupResultCell");
    expect(pageSrc).toContain("followupResultValues[row.runId]?.[String(n)]");
    expect(pageSrc).toContain("followup-result:${n}");
  });

  it("stays out of the visibility/columns-menu systems", () => {
    // Display-only synthetic columns: no visibility ids, no resize
    // handles, no menu entries — they always render with the table.
    expect(pageSrc).not.toContain("followup-result:${n}`,\n");
  });
});

describe("FollowupResultCell", () => {
  it("renders an em dash for missing or unresolved attempts", () => {
    for (const props of [
      { outcome: null, resultText: null },
      { outcome: null, resultText: "draft?" },
    ] as const) {
      const html = renderToStaticMarkup(<FollowupResultCell {...props} />);
      expect(html).toContain("—");
      expect(html).not.toContain("Badge");
    }
  });

  it("renders the outcome badge with a two-line preview", () => {
    const html = renderToStaticMarkup(
      <FollowupResultCell
        outcome="Connected — Interested"
        resultText="Customer is interested in the Kashmir package but wants to discuss it with family first."
      />,
    );
    expect(html).toContain("Connected — Interested");
    expect(html).toContain("Kashmir package");
    expect(html).toContain("line-clamp-2");
  });

  it("exposes the full text on hover without clipping storage", () => {
    const full = "Line one. Line two with detail.";
    const html = renderToStaticMarkup(
      <FollowupResultCell outcome="Other" resultText={full} />,
    );
    expect(html).toContain(`title="${full}"`);
    expect(html).toContain(full);
  });
});

describe("Customer Response protection", () => {
  it("never writes results into Customer Response", () => {
    const resultSrc = readFileSync(
      `${root}/src/app/api/flows/[id]/sales-followups/[attemptId]/result/route.ts`,
      "utf8",
    );
    expect(resultSrc).not.toContain("customerResponseField");
    expect(resultSrc).not.toContain("responseSummaryForResult");
  });

  it("reads results from the attempts payload, not the response cell", () => {
    expect(pageSrc).toContain("payload?.followupResults?.values");
    expect(pageSrc).not.toMatch(/customValues\?\[row\.runId\]\?\.answer/i);
  });
});
