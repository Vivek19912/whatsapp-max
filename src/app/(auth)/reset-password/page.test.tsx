// Reset-password page + recovery loop contract (source-pattern
// assertions; interaction itself needs a browser).
//
// Pins: the page exists under (auth), handles every error slug
// with a fresh-link path, validates locally, saves via the
// authenticated updateUser (never service-role), and the
// forgot-password entry still points at the real callback route.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(auth)/reset-password/page.tsx`,
  "utf8",
);
const callbackSrc = readFileSync(
  `${root}/src/app/auth/callback/route.ts`,
  "utf8",
);
const forgotSrc = readFileSync(
  `${root}/src/app/(auth)/forgot-password/page.tsx`,
  "utf8",
);

describe("reset-password page", () => {
  it("renders invalid-link guidance with a fresh-link path", () => {
    expect(pageSrc).toContain("Reset link invalid");
    expect(pageSrc).toContain('href="/forgot-password"');
    expect(pageSrc).toContain("Send a new reset link");
    expect(pageSrc).toContain("RECOVERY_ERROR_COPY");
    expect(pageSrc).toContain("isRecoveryErrorSlug");
  });

  it("validates locally and saves via the authenticated update", () => {
    expect(pageSrc).toContain("validateNewPassword(password, confirmPassword)");
    expect(pageSrc).toContain("supabase.auth.updateUser({");
    expect(pageSrc).toContain("password,");
    expect(pageSrc).toContain("recoveryUpdateErrorMessage(updateError)");
    expect(pageSrc).toContain("Password updated");
    expect(pageSrc).toContain('href="/login"');
  });

  it("never touches service-role keys or logs secrets", () => {
    expect(pageSrc).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(pageSrc).not.toContain("supabaseAdmin");
    expect(pageSrc).not.toContain("auth.admin");
    expect(callbackSrc).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(callbackSrc).not.toContain("supabaseAdmin");
    expect(callbackSrc).not.toContain("auth.admin");
    expect(callbackSrc).not.toMatch(/console\.(log|warn|error)/);
    expect(pageSrc).not.toMatch(/NEW_PASSWORD_MIN_LENGTH\s*=\s*\d/);
  });
});

describe("recovery loop is closed end to end", () => {
  it("forgot-password points at the real callback + reset page", () => {
    expect(forgotSrc).toContain("/auth/callback?next=/reset-password");
  });

  it("callback lands on the real reset page by default", () => {
    expect(callbackSrc).toContain("resolveSafeNextPath");
    expect(callbackSrc).toContain("exchangeCodeForSession");
    expect(callbackSrc).toContain("/reset-password?error=");
  });
});
