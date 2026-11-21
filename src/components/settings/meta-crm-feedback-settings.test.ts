// Meta CRM Feedback settings — UI contract.
//
// Pins: feedback config (enable + dataset + verify), event history
// with honest status language, retry, and the five-step status
// ladder. Never claims optimization or a coverage percentage.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = readFileSync(
  `${root}/src/components/settings/meta-crm-feedback-settings.tsx`,
  "utf8",
);
const integration = readFileSync(
  `${root}/src/components/settings/meta-integration-settings.tsx`,
  "utf8",
);

describe("MetaCrmFeedbackSettings", () => {
  it("renders the feedback config section", () => {
    expect(src).toContain("CRM Feedback");
    expect(src).toContain("Enable CRM feedback");
    expect(src).toContain("Selected CRM dataset");
    expect(src).toContain("Save CRM Feedback");
    expect(src).toContain("/api/integrations/meta-crm/config");
  });

  it("renders event history with status filters and retry", () => {
    expect(src).toContain("Event History");
    expect(src).toContain("/api/integrations/meta-crm/events");
    expect(src).toContain("/api/integrations/meta-crm/events/retry");
    expect(src).toContain("Pending");
    expect(src).toContain("Sent");
    expect(src).toContain("Failed");
    expect(src).toContain("Skipped");
    expect(src).toContain("Retry delivery");
  });

  it("uses honest status language — never claims optimization or coverage", () => {
    expect(src).toContain("Event received by Meta");
    expect(src).toContain("under validation");
    expect(src).toContain("confirm in Meta Ads Manager");
    expect(src).not.toMatch(/fully optimi[sz]ed/i);
    expect(src).not.toMatch(/100\s*%/);
    expect(src).not.toContain("coverage:");
  });

  it("is wired into the CRM Integration tab", () => {
    expect(integration).toContain("MetaCrmFeedbackSettings");
    expect(integration).toContain("<MetaCrmDatasetSettings />");
  });
});
