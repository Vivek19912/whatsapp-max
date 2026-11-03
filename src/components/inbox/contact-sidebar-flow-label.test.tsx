import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wiring contract for the contact-panel Flow/INSTANT FORM label.
// The sidebar needs browser + Supabase APIs to render, so (like the
// ConversationList source tests) this pins the integration points as
// source assertions. Behaviour is unit-tested in
// src/lib/inbox/contact-flow.test.ts (isMetaLeadFlowRun).
const sidebarSrc = readFileSync(
  join(process.cwd(), "src", "components", "inbox", "contact-sidebar.tsx"),
  "utf8"
);

describe("contact sidebar Flow / Instant Form label", () => {
  it("labels genuine Meta submissions INSTANT FORM, everything else Flow", () => {
    expect(sidebarSrc).toContain('{isInstantForm ? "Instant Form" : "Flow"}');
    expect(sidebarSrc).toContain("setIsInstantForm(");
  });

  it("derives the label from the displayed run's flow kind, not the name", () => {
    expect(sidebarSrc).toContain("isMetaLeadFlowRun(");
    expect(sidebarSrc).toContain("pickContactFlowRun(runs)");
    // No name-prefix guessing anywhere in the panel.
    expect(sidebarSrc).not.toContain("startsWith");
  });

  it("renders the flow name value exactly as resolved, in both cases", () => {
    expect(sidebarSrc).toContain("{flowName}");
    expect(sidebarSrc).toContain("title={flowName}");
  });

  it("keeps the Workflow icon and the No-flow empty state untouched", () => {
    expect(sidebarSrc).toContain("<Workflow");
    expect(sidebarSrc).toContain("No flow");
  });
});
