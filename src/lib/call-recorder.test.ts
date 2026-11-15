import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CALL_RECORDER_DOWNLOAD_PATH,
  CALL_RECORDER_PRODUCTION_HOST,
  callRecorderDownloadUrl,
  callRecorderSiteUrl,
} from "./call-recorder";

describe("call recorder download URL", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the permanent version-independent path", () => {
    expect(CALL_RECORDER_DOWNLOAD_PATH).toBe("/download/call-recorder");
  });

  it("builds the production URL from the configured site URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://whatsappmax.in");
    expect(callRecorderDownloadUrl()).toBe(
      "https://whatsappmax.in/download/call-recorder",
    );
  });

  it("trims whitespace and trailing slashes from the site URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "  https://whatsappmax.in/// ");
    expect(callRecorderSiteUrl()).toBe("https://whatsappmax.in");
    expect(callRecorderDownloadUrl()).toBe(
      "https://whatsappmax.in/download/call-recorder",
    );
  });

  it("never falls back to localhost or a placeholder", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(callRecorderSiteUrl()).toBe(CALL_RECORDER_PRODUCTION_HOST);
    expect(callRecorderDownloadUrl()).toBe(
      `${CALL_RECORDER_PRODUCTION_HOST}/download/call-recorder`,
    );
    expect(callRecorderDownloadUrl()).not.toContain("localhost");
    expect(callRecorderDownloadUrl()).not.toContain("example.com");
  });

  it("carries no version segment, so APK updates never change the QR", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://whatsappmax.in");
    expect(callRecorderDownloadUrl()).not.toMatch(/\d+\.\d+\.\d+/);
  });
});
