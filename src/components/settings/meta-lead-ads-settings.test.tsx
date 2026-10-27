import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Meta Lead Ads settings — OAuth Connect card removal.
//
// Pins the UI contract: the "Connect with Facebook" card (heading,
// button, explanatory text, permissions note) must be absent, while the
// Manual setup section, polling-based sync UI, and Instant Forms UI
// remain available. Backend OAuth routes/data are intentionally
// untouched — this test covers the visible settings surface only.

const root = process.cwd();
const src = readFileSync(
  `${root}/src/components/settings/meta-lead-ads-settings.tsx`,
  "utf8",
);

describe("Meta Lead Ads settings — no OAuth Connect card", () => {
  it("renders no Connect with Facebook heading, button, or permissions note", () => {
    // JSX text nodes for the card title/button (the OAuth helper names
    // in code, e.g. toggleOAuthPage, contain different substrings).
    expect(src).not.toContain(">Connect with Facebook<");
    expect(src).not.toContain("onClick={connectWithFacebook}");
    expect(src).not.toContain("function connectWithFacebook");
    expect(src).not.toContain(
      "Advanced Access/App Review before public onboarding",
    );
  });

  it("keeps the Manual setup section with Save & verify, Disconnect, and diagnostics", () => {
    expect(src).toContain("Manual setup");
    expect(src).toContain("Dataset / Pixel ID");
    expect(src).toContain("Facebook Page ID");
    expect(src).toContain("System User access token");
    expect(src).toContain("Save &amp; verify");
    expect(src).toContain("Disconnect");
    expect(src).toContain("Run diagnostics");
  });

  it("keeps the polling, forms, and import UI", () => {
    expect(src).toContain("Load My Forms");
    expect(src).toContain("Instant Forms");
    expect(src).toContain("Import leads");
    expect(src).toContain("Polling active");
  });

  it("has no New-lead email notifications section (recipients live in Assignment)", () => {
    expect(src).not.toContain("New-lead email notifications");
    expect(src).not.toContain("Email the assigned salesperson for new leads");
    expect(src).not.toContain("Save notification settings");
    expect(src).not.toContain("Send test email to me");
    expect(src).not.toContain("Recent deliveries");
    expect(src).not.toContain("meta-notif-enabled");
    expect(src).not.toContain("NOTIFY_PLACEHOLDERS");
  });
});
