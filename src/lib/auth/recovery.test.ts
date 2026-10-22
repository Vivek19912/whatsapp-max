// Password-recovery helpers — pure contract pins.
//
// Covers: safe landing paths (open-redirect proofing), verify-error
// mapping (otp_expired et al), exchange-failure mapping, password
// rules shared with the reset page, and update-error copy.

import { describe, expect, it } from "vitest";

import {
  NEW_PASSWORD_MIN_LENGTH,
  RECOVERY_ERROR_COPY,
  authCallbackUrl,
  getAppBaseUrl,
  isRecoveryErrorSlug,
  normalizeConfiguredSiteUrl,
  recoveryErrorSlugFromExchangeError,
  recoveryErrorSlugFromParams,
  resolveSafeNextPath,
  validateNewPassword,
  recoveryUpdateErrorMessage,
} from "./recovery";

describe("resolveSafeNextPath", () => {
  it("allows the exact recovery landing paths", () => {
    expect(resolveSafeNextPath("/reset-password")).toBe("/reset-password");
    expect(resolveSafeNextPath("/dashboard")).toBe("/dashboard");
  });

  it("rejects absolute, protocol-relative, and nested URLs", () => {
    expect(resolveSafeNextPath("https://evil.example/reset-password")).toBe(
      "/reset-password",
    );
    expect(resolveSafeNextPath("//evil.example/reset-password")).toBe(
      "/reset-password",
    );
    expect(resolveSafeNextPath("/reset-password/evil")).toBe("/reset-password");
    expect(resolveSafeNextPath("/reset-password?next=https://evil.example")).toBe(
      "/reset-password",
    );
    expect(resolveSafeNextPath("")).toBe("/reset-password");
    expect(resolveSafeNextPath(null)).toBe("/reset-password");
  });
});

describe("recoveryErrorSlugFromParams", () => {
  it("maps otp_expired (expired, used, or revoked) to expired", () => {
    expect(
      recoveryErrorSlugFromParams({
        error: "access_denied",
        error_code: "otp_expired",
      }),
    ).toBe("expired");
    expect(
      recoveryErrorSlugFromParams({ error: null, error_code: "OTP_EXPIRED" }),
    ).toBe("expired");
  });

  it("maps other provider errors to denied, missing params to invalid", () => {
    expect(
      recoveryErrorSlugFromParams({ error: "access_denied", error_code: "bad_oauth_state" }),
    ).toBe("denied");
    expect(recoveryErrorSlugFromParams({})).toBe("invalid");
    expect(recoveryErrorSlugFromParams({ error: null, error_code: null })).toBe(
      "invalid",
    );
  });

  it("every slug has user-facing copy with a recovery action", () => {
    for (const slug of ["expired", "denied", "invalid", "session"] as const) {
      expect(isRecoveryErrorSlug(slug)).toBe(true);
      expect(RECOVERY_ERROR_COPY[slug]).toMatch(/new reset email/i);
    }
    expect(isRecoveryErrorSlug("otp_expired")).toBe(false);
  });
});

describe("recoveryErrorSlugFromExchangeError", () => {
  it("maps bad/used codes and lost verifiers to expired", () => {
    expect(recoveryErrorSlugFromExchangeError(new Error("invalid code"))).toBe(
      "expired",
    );
    expect(
      recoveryErrorSlugFromExchangeError(new Error("code verifier missing")),
    ).toBe("expired");
    expect(recoveryErrorSlugFromExchangeError(new Error("flow state not found"))).toBe(
      "expired",
    );
  });

  it("falls back to invalid for unknown failures", () => {
    expect(recoveryErrorSlugFromExchangeError(new Error("boom"))).toBe("invalid");
    expect(recoveryErrorSlugFromExchangeError(null)).toBe("invalid");
  });
});

describe("validateNewPassword", () => {
  it("requires matching passwords of minimum length", () => {
    expect(validateNewPassword("secret1", "secret1")).toBeNull();
    expect(validateNewPassword("secret1", "secret2")).toBe("Passwords do not match");
    expect(validateNewPassword("abc", "abc")).toBe(
      `Password must be at least ${NEW_PASSWORD_MIN_LENGTH} characters`,
    );
    expect(NEW_PASSWORD_MIN_LENGTH).toBe(6);
  });
});

describe("normalizeConfiguredSiteUrl", () => {
  it("accepts a canonical https URL (trailing slash trimmed)", () => {
    expect(normalizeConfiguredSiteUrl("https://whatsappmax.in")).toBe(
      "https://whatsappmax.in",
    );
    expect(normalizeConfiguredSiteUrl("  https://whatsappmax.in/  ")).toBe(
      "https://whatsappmax.in",
    );
  });

  it("rejects localhost, loopback, non-https, and malformed values", () => {
    expect(normalizeConfiguredSiteUrl("https://localhost:3000")).toBeNull();
    expect(normalizeConfiguredSiteUrl("https://127.0.0.1:3000")).toBeNull();
    expect(normalizeConfiguredSiteUrl("https://[::1]:3000")).toBeNull();
    expect(normalizeConfiguredSiteUrl("http://whatsappmax.in")).toBeNull();
    expect(normalizeConfiguredSiteUrl("https://user:pass@whatsappmax.in")).toBeNull();
    expect(normalizeConfiguredSiteUrl("not a url")).toBeNull();
    expect(normalizeConfiguredSiteUrl("")).toBeNull();
    expect(normalizeConfiguredSiteUrl(null)).toBeNull();
    expect(normalizeConfiguredSiteUrl(undefined)).toBeNull();
  });
});

describe("getAppBaseUrl", () => {
  const PROD = "https://whatsappmax.in";

  it("production always uses the configured URL, never the browser origin", () => {
    expect(
      getAppBaseUrl({
        configuredSiteUrl: PROD,
        browserOrigin: "https://localhost:3000",
        nodeEnv: "production",
      }),
    ).toBe(PROD);
  });

  it("production fails safe on missing or localhost config", () => {
    expect(() =>
      getAppBaseUrl({ configuredSiteUrl: null, nodeEnv: "production" }),
    ).toThrow(/not configured/);
    expect(() =>
      getAppBaseUrl({
        configuredSiteUrl: "https://localhost:3000",
        nodeEnv: "production",
      }),
    ).toThrow(/not configured/);
  });

  it("local development prefers the live browser origin (http allowed)", () => {
    expect(
      getAppBaseUrl({
        configuredSiteUrl: PROD,
        browserOrigin: "http://localhost:3000",
        nodeEnv: "development",
      }),
    ).toBe("http://localhost:3000");
    expect(
      getAppBaseUrl({
        configuredSiteUrl: PROD,
        browserOrigin: "http://127.0.0.1:3001",
        nodeEnv: "development",
      }),
    ).toBe("http://127.0.0.1:3001");
  });

  it("falls back to plain http localhost only outside production", () => {
    expect(
      getAppBaseUrl({ configuredSiteUrl: null, browserOrigin: null, nodeEnv: "test" }),
    ).toBe("http://localhost:3000");
  });
});

describe("authCallbackUrl", () => {
  it("generates the exact production recovery URL", () => {
    expect(
      authCallbackUrl("/reset-password", {
        configuredSiteUrl: "https://whatsappmax.in",
        nodeEnv: "production",
      }),
    ).toBe("https://whatsappmax.in/auth/callback?next=%2Freset-password");
  });

  it("generates an http localhost URL in local development", () => {
    expect(
      authCallbackUrl("/reset-password", {
        browserOrigin: "http://localhost:3000",
        nodeEnv: "development",
      }),
    ).toBe("http://localhost:3000/auth/callback?next=%2Freset-password");
  });

  it("encodes the destination exactly once with no nesting", () => {
    const url = authCallbackUrl("/reset-password", {
      configuredSiteUrl: "https://whatsappmax.in",
      nodeEnv: "production",
    });
    expect(url).not.toContain("%25");
    expect(url.split("?")).toHaveLength(2);
    expect(url).not.toContain("/auth/callback?next=/auth/callback");
  });

  it("never emits an https localhost URL in production", () => {
    const url = authCallbackUrl("/reset-password", {
      configuredSiteUrl: "https://whatsappmax.in",
      browserOrigin: "https://localhost:3000",
      nodeEnv: "production",
    });
    expect(url.startsWith("https://localhost")).toBe(false);
    expect(url).toContain("https://whatsappmax.in/auth/callback");
  });
});

describe("recoveryUpdateErrorMessage", () => {
  it("guides expired sessions back to a fresh link", () => {
    expect(recoveryUpdateErrorMessage(new Error("Auth session missing!"))).toMatch(
      /new reset email/i,
    );
    expect(recoveryUpdateErrorMessage(new Error("New password should be different"))).toBe(
      "New password should be different",
    );
    expect(recoveryUpdateErrorMessage(null)).toMatch(/try again/i);
  });
});
