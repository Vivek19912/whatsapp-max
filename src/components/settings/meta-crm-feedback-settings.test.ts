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

  it("loads the dataset dropdown independently of the config fetch", () => {
    // Regression: the dropdown used to stay empty ("No datasets
    // registered yet") whenever GET config failed, even with
    // datasets present. The registry has its own loader + error
    // state now, so a config failure can never blank it.
    expect(src).toContain("const loadDatasets = useCallback");
    expect(src).toContain("const loadConfigState = useCallback");
    expect(src).toContain("setDatasets(normalizePublicDatasets(ds.datasets))");
    expect(src).toContain("setDatasetsError");
    expect(src).toContain("setConfigError");
    // No early return that would skip setDatasets on config failure.
    expect(src).not.toContain("Promise.all([");
  });

  it("lists Created and Registered datasets without status filtering", () => {
    expect(src).toContain("normalizePublicDatasets");
    // The options render every loaded row; nothing gates on status.
    expect(src).toContain("{datasets.map((d) => (");
    expect(src).not.toMatch(/creationStatus\s*===?\s*["']Created["']/);
    expect(src).not.toMatch(/status\s*===?\s*["']Registered["']/);
  });

  it("surfaces a missing config table instead of an empty dropdown", () => {
    expect(src).toContain("migrationMissing");
    expect(src).toContain("175_meta_crm_feedback");
  });

  it("sizes the dataset dropdown to its content without clipping text", () => {
    // Root causes: the shared trigger pairs a fixed h-8 with py-2
    // (16px content box vs 20px text) and clamps the value with
    // line-clamp-1 (overflow hidden); the popup is locked to the
    // anchor width so long "name · id" options clip. The usage
    // below overrides all three via tailwind-merge (later classes
    // win the conflict groups) without touching the shared file.
    expect(src).toContain("h-auto min-h-9 w-full");
    expect(src).toContain("*:data-[slot=select-value]:line-clamp-none");
    expect(src).toContain("w-max min-w-(--anchor-width) max-w-[calc(100vw-2rem)]");
    // Long option labels may wrap instead of clipping on narrow screens.
    expect(src).toContain("[&_[data-slot=select-item-text]]:whitespace-normal");
  });
});
