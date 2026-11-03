import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wiring contract for the Lead Source dropdown in ConversationList.
// Rendering the full list needs Supabase + browser APIs, so (like the
// Dial action tests) this pins the integration points as source
// assertions: dropdown placement/labels, search-key membership, both
// fetch param builds, client filtering, and the batched submission
// lookup. Behaviour itself is unit-tested in conversations.test.ts
// (matchesLeadSource) and search.test.ts (parse/buildSearchKey).
const listSrc = readFileSync(
  join(
    process.cwd(),
    "src",
    "components",
    "inbox",
    "conversation-list.tsx"
  ),
  "utf8"
);

describe("ConversationList Lead Source wiring", () => {
  it("renders a Lead Source dropdown with All Sources default", () => {
    expect(listSrc).toContain("Lead Source");
    expect(listSrc).toContain("All Sources");
    expect(listSrc).toContain("LEAD_SOURCE_LABELS");
    expect(listSrc).toContain("setSelectedSource");
  });

  it("places Lead Source second: All, Lead Source, Date, Tags, Company, Flow/Form, Team", () => {
    // Source-order assertion on the toolbar: each marker must appear
    // after the previous one. Markers are code tokens unique to their
    // dropdown in render order (searched strictly forward).
    const markers = [
      "FILTER_OPTIONS.map((opt)", // 1. All
      "All Sources", // 2. Lead Source option (inside its dropdown)
      "customDateOpen", // 3. Date popover (first toolbar use is after Lead Source)
      "tags.map((t)", // 4. Tags
      "companies.map((co)", // Company (kept in relative place; not reordered)
      "availableForms.map((form)", // 5a. Form (Instant Form source)
      "flows.map((flow)", // 5b. Flow (all other sources)
      "teamOptions.map((member)", // 6. Team
    ];
    let from = 0;
    const positions: number[] = [];
    for (const m of markers) {
      const idx = listSrc.indexOf(m, from);
      expect(idx, `toolbar marker missing or out of order: ${m}`).toBeGreaterThanOrEqual(0);
      positions.push(idx);
      from = idx + 1;
    }
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("includes the source in the search key so stale pages never show", () => {
    expect(listSrc).toContain('source: selectedSource ?? "all"');
  });

  it("sends the source param on page-1 and load-more fetches", () => {
    const sends = listSrc.match(/params\.set\("source", selectedSource\)/g) ?? [];
    expect(sends.length).toBe(2);
  });

  it("filters the normal list with the same classifier as the server", () => {
    expect(listSrc).toContain(
      "matchesLeadSource(c, selectedSource, submissionContactIds)"
    );
  });

  it("loads submission links in one batched query, never per-row", () => {
    expect(listSrc).toContain('from("meta_lead_submissions")');
    expect(listSrc).toContain('.eq("status", "processed")');
    // Chunked .in() over the loaded contact ids.
    expect(listSrc).toMatch(/\.in\("contact_id", ids\.slice\(i, i \+ 500\)\)/);
  });

  it("gates Instant Form / Other on lookup readiness (never silently wrong)", () => {
    // Readiness starts false and flips only on success (even zero rows).
    expect(listSrc).toContain("submissionLinksReady");
    expect(listSrc).toContain("setSubmissionLinksReady(false)");
    expect(listSrc).toContain("setSubmissionLinksReady(true)");
    // The pure gate keeps ctwa/all usable and search independent.
    expect(listSrc).toContain("isSourceFilterBlocked(");
    expect(listSrc).toContain("sourceLinksBlocked");
  });

  it("surfaces lookup failure with a distinct error + retry (no silent empty)", () => {
    expect(listSrc).toContain("submissionLinksError");
    expect(listSrc).toContain("setSubmissionLinksError");
    expect(listSrc).toContain("setSubmissionLinksRetry((n) => n + 1)");
    expect(listSrc).toContain("Could not load lead source data");
    // The effect refires on retry, resync, and list change; cleanup
    // cancels the superseded run.
    expect(listSrc).toContain("[conversations, resyncToken, submissionLinksRetry]");
  });

  it("replaces the Flow filter with a Form filter under Instant Form", () => {
    expect(listSrc).toContain("selectedSource === \"instant_form\"");
    expect(listSrc).toContain("All Forms");
    expect(listSrc).toContain("setSelectedFormId(");
    // Source changes reset the incompatible Form/Flow pick wholesale.
    expect(listSrc).toContain("handleSourceSelect");
    expect(listSrc).toContain("setSelectedFlowId(null)");
    // The form facet travels in the key and both fetch builds.
    expect(listSrc).toContain("metaFormId: selectedSource");
    const formSends = listSrc.match(/params\.set\("meta_form", selectedFormId\)/g) ?? [];
    expect(formSends.length).toBe(2);
    // Client filtering uses the per-contact form map, never N+1.
    expect(listSrc).toContain(
      "matchesFormFilter(c, selectedFormId, submissionForms)"
    );
  });

  it("derives Form options from this account's actual submissions", () => {
    expect(listSrc).toContain("availableForms");
    expect(listSrc).toContain("MetaFormOption");
    expect(listSrc).toContain("submissionForms");
    // Distinct, account-scoped, processed-only — no hardcoding.
    expect(listSrc).not.toContain("Kashmir");
  });

  it("keeps the filter independent: no existing filter is reset or dropped", () => {
    // Clear-all still clears every facet including the new ones.
    expect(listSrc).toContain("setSelectedSource(null)");
    expect(listSrc).toContain("setSelectedFormId(null)");
    // The chips row shows the source alongside the other facets.
    expect(listSrc).toContain("selectedSource &&");
    // Subscription stays keyed per request; no polling introduced.
    expect(listSrc).not.toContain("setInterval");
  });

  it("shows a form chip for the selected form; All Forms shows no chip", () => {
    // Source chip (existing) plus a distinct form chip only when a
    // specific form is picked; clearing the form removes just its chip.
    expect(listSrc).toContain("LEAD_SOURCE_LABELS[selectedSource]");
    expect(listSrc).toContain("selectedFormId &&");
    expect(listSrc).toContain("availableForms.find((f) => f.id === selectedFormId)");
  });

  it("hides the Flow filter while Instant Form is selected (Form takes its place)", () => {
    // Single ternary: Form dropdown when instant_form, Flow dropdown
    // otherwise — never both at once.
    expect(listSrc).toMatch(/selectedSource === "instant_form" \? \(/);
  });
});
