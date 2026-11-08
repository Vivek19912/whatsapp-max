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
    // Entries resolve by attempt number within the table-wide max —
    // the shared order model carries n, never a parallel array.
    expect(pageSrc).toContain("n >= 1 && n <= followupResultCount");
    expect(pageSrc).toContain("resultOrderId(");
  });

  it("labels headers exactly Follow-up N Result", () => {
    expect(pageSrc).toContain("`Follow-up ${entry.n} Result`");
  });

  it("inserts the block after Customer Response (tail fallback)", () => {
    // Default-order construction splices synthetics after the
    // Customer Response anchor (tail when absent); the page passes
    // the full-list anchor into the shared order model.
    expect(pageSrc).toContain("fullCustomerResponseIdx");
    expect(pageSrc).toContain("customer response");
    expect(pageSrc).toContain("customerResponseIdx:");
    const libSrc = readFileSync(
      `${root}/src/lib/flows/workspace-column-order.ts`,
      "utf8",
    );
    expect(libSrc).toContain("customerResponseIdx + 1");
    expect(libSrc).toContain("customerResponseIdx === -1");
  });

  it("keeps header paint positional across the inserted block", () => {
    // Every entry — synthetics included — paints from its own
    // shared-order slot. No loop-local index math survives.
    expect(pageSrc).toContain("headStyleAt(entry.paintIndex)");
    expect(pageSrc).not.toContain("customOrderAt(");
    expect(pageSrc).not.toContain("synthOrderBase");
    expect(pageSrc).not.toContain("businessOrderBase");
  });

  it("renders result cells at the same positions in every body row", () => {
    expect(pageSrc).toContain("<FollowupResultCell");
    expect(pageSrc).toContain("followupResultValues[row.runId]?.[String(entry.n)]");
    expect(pageSrc).toContain("kind: 'result'");
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
      { outcome: null, resultText: null, completedAt: null },
      { outcome: null, resultText: "draft?", completedAt: null },
    ] as const) {
      const html = renderToStaticMarkup(<FollowupResultCell {...props} />);
      expect(html).toContain("—");
      expect(html).not.toContain("Badge");
      // No timestamp, no badge without a recorded result.
      expect(html).not.toContain("tabular-nums");
    }
  });

  it("renders the outcome badge with a two-line preview", () => {
    const html = renderToStaticMarkup(
      <FollowupResultCell
        outcome="Connected — Interested"
        resultText="Customer is interested in the Kashmir package but wants to discuss it with family first."
        completedAt="2026-11-07T12:13:00.000Z"
      />,
    );
    expect(html).toContain("Connected — Interested");
    expect(html).toContain("Kashmir package");
    expect(html).toContain("line-clamp-2");
  });

  it("shows the attempt's own completion timestamp, never the schedule", () => {
    const html = renderToStaticMarkup(
      <FollowupResultCell
        outcome="No Answer"
        resultText="Rang twice."
        completedAt="2026-11-07T17:43:00.000Z"
      />,
    );
    // Viewer-local date + time parts both present.
    expect(html).toContain("2026");
    expect(html).toContain("tabular-nums");
    // Unresolved attempts show no timestamp at all.
    const pending = renderToStaticMarkup(
      <FollowupResultCell outcome={null} resultText={null} completedAt={null} />,
    );
    expect(pending).not.toContain("tabular-nums");
  });

  it("renders timestamp + text with no badge when outcome is NULL", () => {
    const html = renderToStaticMarkup(
      <FollowupResultCell
        outcome={null}
        resultText="Shared the itinerary on WhatsApp."
        completedAt="2026-11-07T17:43:00.000Z"
      />,
    );
    expect(html).toContain("Shared the itinerary on WhatsApp.");
    expect(html).toContain("2026");
    expect(html).toContain("tabular-nums");
    // No invented outcome, no empty badge.
    expect(html).not.toContain("Other");
  });

  it("exposes the full text on hover without clipping storage", () => {
    const full = "Line one. Line two with detail.";
    const html = renderToStaticMarkup(
      <FollowupResultCell outcome="Other" resultText={full} completedAt={null} />,
    );
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
