import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("GET /download/call-recorder", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects to the configured APK without login and without caching", async () => {
    vi.stubEnv(
      "CALL_RECORDER_APK_URL",
      "https://cdn.example.com/apks/call-recorder.apk",
    );
    const res = await GET();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://cdn.example.com/apks/call-recorder.apk",
    );
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("answers 503 instead of serving anything when no APK is published", async () => {
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not published/i);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("refuses non-https artifact URLs instead of open-redirecting", async () => {
    vi.stubEnv("CALL_RECORDER_APK_URL", "http://insecure.example.com/a.apk");
    const res = await GET();
    expect(res.status).toBe(503);
  });
});
