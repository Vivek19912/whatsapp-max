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
    // The effect refires on retry; cleanup cancels the superseded run.
    expect(listSrc).toContain("[conversations, submissionLinksRetry]");
  });

  it("keeps the filter independent: no existing filter is reset or dropped", () => {
    // Clear-all still clears every facet including the new one.
    expect(listSrc).toContain("setSelectedSource(null)");
    // The chips row shows the source alongside the other facets.
    expect(listSrc).toContain("selectedSource &&");
    // Subscription stays keyed per request; no polling introduced.
    expect(listSrc).not.toContain("setInterval");
  });
});
