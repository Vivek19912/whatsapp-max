// Password-recovery helpers — pure contract pins.
//
// Covers: safe landing paths (open-redirect proofing), verify-error
// mapping (otp_expired et al), exchange-failure mapping, password
// rules shared with the reset page, and update-error copy.

import { describe, expect, it } from "vitest";

import {
  NEW_PASSWORD_MIN_LENGTH,
  RECOVERY_ERROR_COPY,
  isRecoveryErrorSlug,
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
