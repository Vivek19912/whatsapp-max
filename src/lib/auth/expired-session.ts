// ============================================================
// Expired-session handling for authenticated client fetches.
//
// When an API route returns 401, the session is expired or invalid:
// clear the invalid client-side session state and send the user to
// the existing sign-in page (/login). Only 401 triggers this — 403,
// validation errors, and ordinary server errors keep their existing
// behavior.
//
// Guarantees:
//   - 401-only: every other status is ignored.
//   - Single-flight: simultaneous 401s (parallel fetches) trigger
//     exactly one sign-out + redirect.
//   - No redirect loops: no redirect when already on an auth page.
//   - Never throws: safe to call from any fetch .then/.catch chain.
//   - Does not extend/refresh sessions or change expiry policy — it
//     only clears the dead session and redirects.
// ============================================================

import { createClient } from "@/lib/supabase/client";

const LOGIN_PATH = "/login";

// Auth-adjacent paths where a redirect to /login would loop or fight
// the in-progress auth flow. Still clears the dead session, just
// skips the navigation.
const AUTH_PATH_PREFIXES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/join",
] as const;

let redirectArmed = false;

/** Test-only reset for the single-flight guard. */
export function resetExpiredSessionForTests(): void {
  redirectArmed = false;
}

/** True only for 401 Unauthorized — the expired/invalid session signal. */
export function isExpiredSessionStatus(status: unknown): boolean {
  return status === 401;
}

/** True when the current location is an auth page (redirect would loop). */
export function isAuthPagePath(pathname: string): boolean {
  return AUTH_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export interface HandleExpiredSessionDeps {
  /** Override for tests — defaults to clearing the browser session. */
  signOut?: () => Promise<unknown>;
  /** Override for tests — defaults to window.location.pathname. */
  getPathname?: () => string | null;
  /** Override for tests — defaults to window.location.href = LOGIN_PATH. */
  redirect?: () => void;
}

/**
 * Clear the dead client session and redirect to /login.
 *
 * Returns true when the caller should suppress its own 401 error UI
 * (the redirect is taking over). Returns false when there is nothing
 * to do (SSR, or a second call while a redirect is already in flight
 * — still "handled", so callers suppress their error UI too).
 *
 * Never throws. Only clears local state; never refreshes or extends
 * the session.
 */
export function handleExpiredSession(deps?: HandleExpiredSessionDeps): boolean {
  const hasWindow = typeof window !== "undefined";
  // SSR / non-browser with no injected deps: nothing to clear or
  // navigate, but report handled so callers skip raw-401 UI.
  if (!hasWindow && !deps) return true;
  // Single-flight: parallel 401s share one sign-out + redirect.
  if (redirectArmed) return true;
  redirectArmed = true;

  const pathname =
    deps?.getPathname?.() ?? (hasWindow ? window.location?.pathname : null) ?? null;
  const onAuthPage = typeof pathname === "string" && isAuthPagePath(pathname);

  const doSignOut =
    deps?.signOut ?? (() => createClient().auth.signOut());
  const doRedirect =
    deps?.redirect ??
    (hasWindow
      ? () => {
          window.location.href = LOGIN_PATH;
        }
      : () => {});

  // Fire-and-forget: callers must not stall their fetch chain on
  // sign-out, and a sign-out failure must still land on /login where
  // the shell + middleware finish the job.
  void Promise.resolve()
    .then(() => doSignOut())
    .catch(() => undefined)
    .then(() => {
      if (!onAuthPage) doRedirect();
    });

  return true;
}

/**
 * Convenience for fetch chains: when `res.status` is 401, clears the
 * dead session + redirects and returns true (caller must return early
 * WITHOUT setting its error state, so no raw 401 is displayed).
 * Any other status returns false (existing handling continues —
 * 403, validation, and 5xx are never redirected).
 */
export function handleExpiredSessionResponse(
  res: { status: number },
  deps?: HandleExpiredSessionDeps,
): boolean {
  if (!isExpiredSessionStatus(res.status)) return false;
  return handleExpiredSession(deps);
}
