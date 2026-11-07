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

  it("places filters: All, Lead Source, Date, Form, Team, Tags, Flow", () => {
    // Source-order assertion on the toolbar: each marker must appear
    // after the previous one. Markers are code tokens unique to their
    // dropdown in render order (searched strictly forward). Tags is
    // second-last and Flow is last; Company keeps its relative place
    // after Date.
    const markers = [
      "FILTER_OPTIONS.map((opt)", // 1. All
      "All Sources", // 2. Lead Source option (inside its dropdown)
      "customDateOpen", // 3. Date popover (first toolbar use is after Lead Source)
      "companies.map((co)", // Company (kept in relative place; not reordered)
      "availableForms.map((form)", // 4. Form (always visible)
      "teamOptions.map((member)", // 5. Team
      "tags.map((t)", // 6. Tags (second-last)
      "flows.map((flow)", // 7. Flow (last)
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

  it("keeps Flow and Form always visible and independent", () => {
    // Both dropdowns render unconditionally — no source gating on
    // either. Form options come from this account's submissions;
    // Flow options from the workspace flows.
    expect(listSrc).toContain("All Forms");
    expect(listSrc).toContain("All flows");
    expect(listSrc).toContain("setSelectedFormId(");
    expect(listSrc).toContain("setSelectedFlowId(");
    // Source changes never reset the Form/Flow picks (independent
    // facets); Clear-all still resets everything (see below).
    expect(listSrc).toContain("handleSourceSelect");
    expect(listSrc).toMatch(
      /const handleSourceSelect = useCallback\(\(next: LeadSourceFilter\) => \{\s+setSelectedSource\(next\);\s+\}, \[\]\);/
    );
    // The form facet travels in the key and both fetch builds,
    // independent of the selected source.
    expect(listSrc).toContain("metaFormId: selectedFormId");
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

  it("applies the Form filter for any Lead Source (AND semantics)", () => {
    // Client filtering narrows by the form whenever one is picked,
    // with no source precondition — the source facet (above) and the
    // form facet (below) compose by intersection.
    expect(listSrc).toContain(
      "if (selectedFormId !== null && !formLinksBlocked) {"
    );
    expect(listSrc).not.toContain('selectedSource === "instant_form"');
    // Server-side parity: the form param travels for every source.
    expect(listSrc).not.toContain(
      'selectedSource === "instant_form" && selectedFormId'
    );
  });

  it("shows Flow and Form side by side for every Lead Source", () => {
    // No source-conditional ternary around the two dropdowns: both
    // render for all sources, including Instant Form.
    expect(listSrc).not.toMatch(/selectedSource === "instant_form" \? \(/);
    // The Flow dropdown still gates on having flows to offer; the
    // Form dropdown is unconditional (All Forms is always valid).
    expect(listSrc).toContain("flows.length > 0 && (");
  });

  it("orders filters All | Lead Source | Date | Form | Team | Tags | Flow", () => {
    // Visual order only — every marker below is render markup or
    // the conditional that gates its dropdown; each must appear
    // after the previous one. (The conditional Company picker,
    // when present, stays where it was: after Date.)
    const markers = [
      'activeFilter?.label ?? "All"',
      "LEAD_SOURCE_LABELS[selectedSource]",
      "<Popover open={customDateOpen}",
      '?? "Form"',
      "teamOptions.length > 0 && (",
      "{tags.length > 0 && (",
      "{flows.length > 0 && (",
    ];
    let from = -1;
    for (const marker of markers) {
      const idx = listSrc.indexOf(marker, from + 1);
      expect(idx, marker).toBeGreaterThan(from);
      from = idx;
    }
  });
});

describe("Clear-all visibility follows applied state, not chips", () => {
  it("gates the chips row on every facet including status and date", () => {
    // hasContactFilters alone would hide Clear all for Unread or
    // date-only selections (neither renders chips here).
    expect(listSrc).toContain("hasActiveInboxFilters({");
    expect(listSrc).toContain("{hasActiveFilters && (");
    expect(listSrc).not.toMatch(/\{hasContactFilters && \(/);
  });

  it("Clear all resets status and date alongside every chip facet", () => {
    const start = listSrc.indexOf("const clearContactFilters");
    expect(start).toBeGreaterThan(-1);
    const end = listSrc.indexOf("}, []);", start);
    const body = listSrc.slice(start, end);
    for (const reset of [
      "setFilter(\"all\")",
      "setDateFilter(\"all\")",
      "setSelectedTagIds([])",
      "setSelectedCompany(null)",
      "setSelectedFlowId(null)",
      "setSelectedFormId(null)",
      "setSelectedMemberIds([])",
      "setSelectedSource(null)",
    ]) {
      expect(body).toContain(reset);
    }
  });
});

describe("ConversationList Form options show full names", () => {
  it("never ellipsis-truncates form option text", () => {
    expect(listSrc).not.toContain('<span className="truncate">{form.name}</span>');
    expect(listSrc).toContain("{form.name}");
  });

  it("sizes the Form menu to its longest option within the viewport", () => {
    // Content-driven width (trigger floor, viewport cap) instead
    // of the fixed w-56 the other filter menus keep.
    expect(listSrc).toContain("w-max min-w-56 max-w-[calc(100vw-2rem)]");
    expect(listSrc).toContain("whitespace-normal break-words");
  });

  it("leaves every other filter menu exactly as before", () => {
    // Lead Source, Date, Tags, Flow, and Team keep their compact
    // fixed-width menus; only the Form menu grows.
    const fixed = listSrc.match(/max-h-64 w-56/g) ?? [];
    expect(fixed.length).toBe(5);
  });

  it("preserves Form selection behavior", () => {
    expect(listSrc).toContain("All Forms");
    expect(listSrc).toContain("setSelectedFormId(form.id)");
    expect(listSrc).toContain("setSelectedFormId(null)");
  });
});
