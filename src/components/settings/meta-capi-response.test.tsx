// Meta CAPI settings — full Meta response viewer (UI contract).
//
// Pins the visible surface: every delivery keeps its compact
// summary row, gains an expandable "View full Meta response"
// panel (event, status, time, HTTP status, pretty JSON, copy),
// uncaptured rows explain themselves, and expanding never
// triggers a delivery (viewing is read-only).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = readFileSync(
  `${root}/src/components/settings/meta-conversions-api-settings.tsx`,
  "utf8",
);

describe("Meta CAPI settings — full Meta response viewer", () => {
  it("keeps the compact summary row with test badges and Refresh", () => {
    expect(src).toContain("Recent deliveries");
    expect(src).toContain("Refresh");
    expect(src).toContain("statusBadge(d.status)");
    expect(src).toContain("d.isTest");
  });

  it("adds an expandable full-response panel per delivery", () => {
    expect(src).toContain("View full Meta response");
    expect(src).toContain("Hide full Meta response");
    expect(src).toContain("aria-expanded");
    expect(src).toContain("HTTP status");
  });

  it("renders the complete response as pretty, contained JSON with copy", () => {
    expect(src).toContain("JSON.stringify");
    expect(src).toContain("Copy response");
    expect(src).toContain("navigator.clipboard");
    expect(src).toContain("<pre");
  });

  it("explains uncaptured responses instead of inventing data", () => {
    expect(src).toContain("Full response not available for this delivery");
  });

  it("viewing is read-only — no new delivery can be triggered", () => {
    expect(src).not.toContain("sendEvents");
    expect(src).not.toContain("/followups");
    // The panel only reads the already-fetched row data.
    expect(src).toContain("DeliveryResponseDetails");
  });

  it("shows each delivery's summary fields inside the details", () => {
    expect(src).toContain("Event");
    expect(src).toContain("Time");
  });
});
