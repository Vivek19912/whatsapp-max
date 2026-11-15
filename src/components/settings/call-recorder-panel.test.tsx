import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelSrc = readFileSync(
  join(__dirname, "call-recorder-panel.tsx"),
  "utf8",
);

function occurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe("CallRecorderPanel (reference mockup)", () => {
  it("shows the page heading exactly once", () => {
    expect(occurrences(panelSrc, "Call Recorder")).toBe(1);
  });

  it("renders a real QR from the permanent download URL", () => {
    expect(panelSrc).toContain("callRecorderDownloadUrl()");
    expect(panelSrc).toContain("QRCode.toString(url,");
    expect(panelSrc).toContain('role="img"');
  });

  it("shows Scan to download directly above a single Download APK button", () => {
    expect(occurrences(panelSrc, "Scan to download")).toBe(1);
    expect(occurrences(panelSrc, "Download APK")).toBe(1);
    expect(panelSrc).toContain("<Download");
    const textIdx = panelSrc.indexOf("Scan to download");
    const buttonIdx = panelSrc.indexOf("Download APK");
    expect(buttonIdx).toBeGreaterThan(textIdx);
  });

  it("points the button at the exact same URL as the QR", () => {
    // One shared `url` binding feeds both the QR encoder and the
    // anchor — no parallel download mechanism to drift apart.
    expect(panelSrc).toContain("href={url}");
    expect(occurrences(panelSrc, "href=")).toBe(1);
  });

  it("carries no descriptions, versions, or installation copy", () => {
    expect(panelSrc).not.toMatch(/\d+\.\d+\.\d+/);
    expect(panelSrc).not.toMatch(/install/i);
    expect(panelSrc).not.toMatch(/version/i);
  });
});
