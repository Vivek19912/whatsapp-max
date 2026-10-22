// GET /auth/callback — PKCE exchange landing for auth emails.
//
// Pins the reported-bug contract: the recovery redirect target
// now resolves to a real route (no more 404), valid codes land on
// `next`, provider-side failures (otp_expired et al) land on
// /reset-password with a stable slug, and untrusted `next` values
// can never become open redirects.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  exchangeResult: "ok" as "ok" | "bad-code",
  exchangedCode: null as string | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async (code: string) => {
        h.exchangedCode = code;
        if (h.exchangeResult === "bad-code") {
          return { data: null, error: new Error("invalid code") };
        }
        return { data: {}, error: null };
      },
    },
  }),
}));

const { GET } = await import("./route");

function get(path: string) {
  const url = `https://whatsappmax.in${path}`;
  return { nextUrl: new URL(url), url } as never;
}

beforeEach(() => {
  h.exchangeResult = "ok";
  h.exchangedCode = null;
});

describe("GET /auth/callback", () => {
  it("exchanges a valid code and lands on next", async () => {
    const res = await GET(get("/auth/callback?code=abc&next=/reset-password"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://whatsappmax.in/reset-password",
    );
    expect(h.exchangedCode).toBe("abc");
  });

  it("defaults to /reset-password without next", async () => {
    const res = await GET(get("/auth/callback?code=abc"));
    expect(res.headers.get("location")).toBe(
      "https://whatsappmax.in/reset-password",
    );
  });

  it("never open-redirects on hostile next values", async () => {
    for (const next of [
      "https://evil.example/reset-password",
      "//evil.example/reset-password",
      "/reset-password/evil",
      "/dashboard?next=https://evil.example",
    ]) {
      const res = await GET(
        get(`/auth/callback?code=abc&next=${encodeURIComponent(next)}`),
      );
      expect(res.headers.get("location")).toBe(
        "https://whatsappmax.in/reset-password",
      );
    }
  });

  it("maps provider otp_expired to the expired slug (the reported bug)", async () => {
    const res = await GET(
      get("/auth/callback?error=access_denied&error_code=otp_expired&next=/reset-password"),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://whatsappmax.in/reset-password?error=expired",
    );
    expect(h.exchangedCode).toBeNull();
  });

  it("maps other provider errors to denied without leaking details", async () => {
    const res = await GET(
      get("/auth/callback?error=access_denied&error_code=unexpected_failure&error_description=server+said+no"),
    );
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("https://whatsappmax.in/reset-password?error=denied");
    expect(location).not.toContain("server");
  });

  it("handles missing codes as invalid links", async () => {
    const res = await GET(get("/auth/callback"));
    expect(res.headers.get("location")).toBe(
      "https://whatsappmax.in/reset-password?error=invalid",
    );
    expect(h.exchangedCode).toBeNull();
  });

  it("maps failed exchanges to a fresh-link slug, never a raw error", async () => {
    h.exchangeResult = "bad-code";
    const res = await GET(get("/auth/callback?code=stale"));
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("https://whatsappmax.in/reset-password?error=expired");
    expect(location).not.toContain("stale");
  });
});
