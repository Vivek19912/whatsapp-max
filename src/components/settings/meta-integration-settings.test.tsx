// Meta Settings tabs — Lead Capture + CRM Integration (CAPI stays hidden).
//
// Pins: Lead Capture remains default, CRM Integration is visible, the
// retired Conversions API tab is never rendered, and its implementation
// file is retained for reference.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = readFileSync(
  `${root}/src/components/settings/meta-integration-settings.tsx`,
  "utf8",
);

describe("MetaIntegrationSettings tabs", () => {
  it("shows Lead Capture and CRM Integration tabs", () => {
    expect(src).toContain('value="lead-capture"');
    expect(src).toContain("Lead capture");
    expect(src).toContain('value="crm-integration"');
    expect(src).toContain("CRM Integration");
  });

  it("keeps Lead Capture as the default subtab", () => {
    expect(src).toContain('useState("lead-capture")');
  });

  it("never renders the retired Conversions API tab", () => {
    expect(src).not.toContain('value="conversions-api"');
    expect(src).not.toContain("MetaConversionsApiSettings");
    expect(src).toContain("DEAD FEATURE");
  });

  it("retains the retired CAPI implementation file", () => {
    const capi = readFileSync(
      `${root}/src/components/settings/meta-conversions-api-settings.tsx`,
      "utf8",
    );
    expect(capi).toContain("DEAD FEATURE");
    expect(capi.length).toBeGreaterThan(1000);
  });
});
