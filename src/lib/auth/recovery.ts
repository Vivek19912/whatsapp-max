// ============================================================
// Password-recovery helpers (pure, no I/O).
//
// Flow: forgot-password page -> resetPasswordForEmail with
// redirectTo <origin>/auth/callback?next=/reset-password ->
// Supabase verifies the OTP and redirects here with either
// `?code=` (PKCE, exchange it) or `?error=&error_code=`
// (verification already failed at Supabase: expired, used, or
// revoked link). The callback route exchanges the code for a
// session and lands on `next`; failures land on /reset-password
// with an `error` slug — never raw provider messages, which can
// leak internals into URLs and logs.
// ============================================================

/** Destinations the callback is allowed to land on after exchange. */
export const SAFE_RECOVERY_NEXT_PATHS = ["/reset-password", "/dashboard"] as const;

/** Error slugs surfaced on /reset-password (stable, log-safe). */
export type RecoveryErrorSlug = "expired" | "denied" | "invalid" | "session";

/** User-facing copy per slug. Kept here so page and tests agree. */
export const RECOVERY_ERROR_COPY: Record<RecoveryErrorSlug, string> = {
  expired:
    "This reset link has expired or was already used. Request a new reset email and open the latest link once.",
  denied:
    "This reset link is not valid. Request a new reset email and open the latest link once.",
  invalid:
    "This reset link is incomplete. Request a new reset email and open the latest link once.",
  session:
    "Your recovery session expired. Request a new reset email and open the latest link once.",
};

export function isRecoveryErrorSlug(value: unknown): value is RecoveryErrorSlug {
  return (
    value === "expired" ||
    value === "denied" ||
    value === "invalid" ||
    value === "session"
  );
}

/**
 * Resolve the post-exchange landing path. Only exact allowlisted
 * same-origin paths are honored — everything else (absolute URLs,
 * protocol-relative `//evil`, sub-paths, encoded tricks) falls
 * back to /reset-password. `URLSearchParams.get` already decodes
 * percent-encoding, so matching the decoded value is sufficient.
 */
export function resolveSafeNextPath(next: string | null): string {
  if (!next) return "/reset-password";
  const allowed: readonly string[] = SAFE_RECOVERY_NEXT_PATHS;
  return (allowed as readonly string[]).includes(next) ? next : "/reset-password";
}

/**
 * Map Supabase's verify-failure redirect params to a slug.
 * otp_expired covers expired, already-used, and revoked tokens —
 * Supabase uses one code for all three, so the copy says so.
 */
export function recoveryErrorSlugFromParams(params: {
  error?: string | null;
  error_code?: string | null;
}): RecoveryErrorSlug {
  const code = (params.error_code ?? "").toLowerCase();
  if (code === "otp_expired") return "expired";
  if (params.error) return "denied";
  return "invalid";
}

/**
 * Map an exchangeCodeForSession failure to a slug. Exchange
 * failures mean the code is bad, already redeemed, or the PKCE
 * verifier is gone (different browser/device) — all resolve to
 * "request a new link", never to a retry of the same URL.
 */
export function recoveryErrorSlugFromExchangeError(err: unknown): RecoveryErrorSlug {
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (/expired|invalid|not found|verifier|flow state|code/.test(message)) return "expired";
  return "invalid";
}

/** Minimum password length — matches the signup-page policy. */
export const NEW_PASSWORD_MIN_LENGTH = 6;

/**
 * Validate the reset-password form. Returns the user-facing error
 * or null when the pair is acceptable. Pure, so the page and tests
 * share one rule.
 */
export function validateNewPassword(
  password: string,
  confirm: string,
): string | null {
  if (password !== confirm) return "Passwords do not match";
  if (password.length < NEW_PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${NEW_PASSWORD_MIN_LENGTH} characters`;
  }
  return null;
}

/**
 * Map an updateUser failure to user-facing copy. A missing session
 * (link opened in another browser, cookies cleared) is the common
 * case and gets recovery-specific guidance instead of a raw error.
 */
export function recoveryUpdateErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (/session|user not found|jwt|token|not authenticated/i.test(message)) {
    return "Your recovery session expired. Request a new reset email and open the latest link once.";
  }
  return message || "Could not update your password. Try again.";
}
