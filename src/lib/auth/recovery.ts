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
 * Inputs for app-base-URL resolution. Every field is injectable so
 * the policy is unit-testable without touching globals; callers
 * omit them to read the real environment.
 */
export interface AppBaseUrlOptions {
  /** Value of NEXT_PUBLIC_SITE_URL (canonical public URL). */
  configuredSiteUrl?: string | null;
  /** Browser origin, e.g. window.location.origin (dev only). */
  browserOrigin?: string | null;
  /** process.env.NODE_ENV. */
  nodeEnv?: string;
}

/**
 * Validate an explicitly configured site URL. Only absolute HTTPS
 * URLs with a real (non-loopback) host qualify — localhost,
 * 127.0.0.1, ::1, non-HTTPS schemes, credentials in the URL, and
 * unparseable values are all rejected (null).
 */
export function normalizeConfiguredSiteUrl(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
    return null;
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Canonical application base URL for email-bound links (recovery,
 * invites, ...). Policy, in order:
 *
 *   1. Production builds REQUIRE a valid configured
 *      NEXT_PUBLIC_SITE_URL and always use it — the browser origin
 *      is never consulted, so a localhost origin can never leak
 *      into a production email. Missing/invalid config throws
 *      instead of silently falling back to localhost.
 *   2. Anywhere else (dev/test), the live browser origin wins so
 *      the ordinary local server (any port) gets working links.
 *   3. Server-side without a request falls back to a configured
 *      URL when valid, else plain http://localhost:3000.
 */
export function getAppBaseUrl(options?: AppBaseUrlOptions): string {
  const nodeEnv =
    options && "nodeEnv" in options && options.nodeEnv !== undefined
      ? options.nodeEnv
      : process.env.NODE_ENV;
  const configured = normalizeConfiguredSiteUrl(
    options && "configuredSiteUrl" in options
      ? options.configuredSiteUrl
      : process.env.NEXT_PUBLIC_SITE_URL ?? null,
  );
  if (nodeEnv === "production") {
    if (!configured) {
      throw new Error(
        "Site URL is not configured for production email links. Set NEXT_PUBLIC_SITE_URL to the canonical https URL (e.g. https://whatsappmax.in).",
      );
    }
    return configured;
  }
  const browserOrigin =
    options && "browserOrigin" in options
      ? options.browserOrigin
      : typeof window !== "undefined"
        ? window.location.origin
        : null;
  if (typeof browserOrigin === "string" && browserOrigin.trim() !== "") {
    return browserOrigin.trim().replace(/\/+$/, "");
  }
  return configured ?? "http://localhost:3000";
}

/**
 * Recovery callback URL for resetPasswordForEmail's redirectTo.
 * The `next` destination is encoded exactly once here; the
 * /auth/callback route allowlists it again on arrival.
 */
export function authCallbackUrl(nextPath: string, options?: AppBaseUrlOptions): string {
  return `${getAppBaseUrl(options)}/auth/callback?next=${encodeURIComponent(nextPath)}`;
}

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
