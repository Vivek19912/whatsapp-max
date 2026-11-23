// Meta CRM dataset registry — local-only removal contract.
//
// Pins: Actions column with per-row Remove, confirmation dialog
// showing the dataset identity + local-only wording, in-use guard
// wiring (advance warning + server 409), refresh-after-remove,
// and zero Meta mutation surface (no Graph calls on this path).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = readFileSync(
  `${root}/src/components/settings/meta-crm-dataset-settings.tsx`,
  "utf8",
);
const routeSrc = readFileSync(
  `${root}/src/app/api/integrations/meta-crm/datasets/[id]/route.ts`,
  "utf8",
);

describe("MetaCrmDatasetSettings — remove registration (local only)", () => {
  it("adds an Actions column with Copy preserved and a per-row Remove button", () => {
    expect(src).toContain("Actions");
    expect(src).toContain("Copy dataset ID");
    expect(src).toContain("Remove dataset");
    expect(src).toContain("Trash2");
    // Only editors see the destructive action.
    expect(src).toContain("canEditSettings");
  });

  it("confirms with dataset identity and local-only wording", () => {
    expect(src).toContain("Remove CRM Dataset");
    expect(src).toContain("Are you sure you want to remove this CRM dataset from WhatsApp Max?");
    expect(src).toContain("Dataset Name");
    expect(src).toContain("Meta Dataset ID");
    expect(src).toContain("Business Portfolio ID");
    expect(src).toContain("will only remove the dataset registration from WhatsApp Max");
    expect(src).toContain("remain unchanged in Meta Events Manager");
    expect(src).toContain("Cancel");
    expect(src).toContain("Remove from WhatsApp Max");
  });

  it("warns when the dataset is currently used by CRM Feedback", () => {
    // Advance client warning (dialog) + authoritative server guard.
    expect(src).toContain("currently used by CRM Feedback");
    expect(src).toContain("Disable CRM feedback");
    expect(routeSrc).toContain("dataset_in_use");
    expect(routeSrc).toContain("409");
  });

  it("removes via account-scoped DELETE and refreshes without reload", () => {
    expect(src).toContain("method: \"DELETE\"");
    expect(src).toContain("/api/integrations/meta-crm/datasets/${encodeURIComponent(");
    expect(src).toContain("Dataset removed from WhatsApp Max");
    expect(src).toContain("await loadDatasets()");
    // Cancel leaves everything untouched.
    expect(src).toContain("closeRemove");
  });

  it("never calls Meta on the removal path", () => {
    expect(routeSrc).not.toContain("graph.facebook.com");
    expect(routeSrc).not.toMatch(/\bfetch\s*\(/);
    expect(routeSrc).not.toContain("access_token");
  });
});
