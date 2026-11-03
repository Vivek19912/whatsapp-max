// ============================================================
// Shared @supabase/ssr auth cookie options (browser + server +
// middleware).
//
// Persistence target: a signed-in session must survive browser
// restart, page refresh, and route navigation for at least 30 days,
// and the apex host (`https://whatsappmax.in`) and its `www`
// subdomain must share ONE session so a user is never "logged out"
// just by reaching the other hostname.
//
// Cookie lifetime: @supabase/ssr's cookie storage ALWAYS enforces
// `DEFAULT_COOKIE_OPTIONS.maxAge` (400 days) on every write
// (`setCookieOptions.maxAge = DEFAULT_COOKIE_OPTIONS.maxAge` in both
// the browser and server adapters), so the cookie survives far longer
// than the 30-day requirement. The Supabase refresh token is the
// long-lived credential; the access token (JWT) keeps its normal
// 1-hour expiry and is refreshed on demand. We deliberately do NOT
// lengthen the access token.
//
// Host sharing: the browser/SSR clients set auth cookies host-only by
// default (no `domain`), so apex and www hold separate sessions. Set
// `NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN` in production to the leading-dot
// registrable domain (e.g. `.whatsappmax.in`) so both hosts share one
// cookie. Leave it unset on localhost/CI — a domain cookie would be
// rejected for a different host. Never set it blindly.
// ============================================================

/** @supabase/ssr's enforced auth-cookie lifetime (400 days). */
export const AUTH_SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** The minimum required persistent-login window (30 days). */
export const MIN_SESSION_PERSISTENCE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Auth cookie options shared by every Supabase client factory.
 *
 * Only `domain` is configurable; `maxAge` is enforced to 400 days by
 * @supabase/ssr itself. Returns `{}` (host-only cookies) when no domain
 * is configured.
 */
export function getAuthCookieOptions(): { domain?: string } {
  const domain = (process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN ?? "").trim();
  return domain ? { domain } : {};
}

/**
 * Observed `@supabase/ssr` DEFAULT_COOKIE_OPTIONS shape (v0.12.0,
 * verified read-only in node_modules — NOT redeclared here so the
 * library stays the single source of truth):
 *
 *   { path: "/", sameSite: "lax", httpOnly: false,
 *     maxAge: 400 * 24 * 60 * 60 }
 *
 * Notes for future bumps:
 * - `httpOnly: false` is REQUIRED, not a weakness: the browser client
 *   persists the session via `document.cookie`, which cannot read or
 *   write HttpOnly cookies. (Server-set cookies keep their own flags.)
 * - `secure` is ABSENT from the library defaults; TLS enforcement is
 *   the deployment's job (https origins, `wss://`), not the cookie
 *   writer's. Never assert `secure === false` — a future version
 *   adding `secure: true` must not fail this guard.
 * - `maxAge` is force-applied on every write (browser AND server
 *   adapters overwrite any caller-supplied maxAge), so a caller can
 *   never shorten or lengthen the session lifetime from here.
 */
export interface ObservedSsrCookieDefaults {
  path?: unknown;
  sameSite?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  maxAge?: unknown;
  domain?: unknown;
}

/**
 * Test/runtime guard for the auth-cookie contract. Throws on the first
 * violation; returns the resolved options otherwise. Pass the installed
 * `@supabase/ssr` DEFAULT_COOKIE_OPTIONS as `libDefaults` to also pin
 * the library's emitted attributes (the vitest file does this). The
 * assertions that must survive a library bump are:
 *   - our floor (30d) still holds against the enforced maxAge (400d);
 *   - a configured domain is well-formed (leading-dot registrable);
 *   - the library still emits path=/, sameSite=lax, maxAge=400d and
 *     keeps httpOnly=false (document.cookie readability).
 */
export function assertAuthCookieOptions(
  libDefaults?: ObservedSsrCookieDefaults,
): { domain?: string } {
  if (AUTH_SESSION_COOKIE_MAX_AGE_SECONDS < MIN_SESSION_PERSISTENCE_SECONDS) {
    throw new Error(
      `auth cookie lifetime ${AUTH_SESSION_COOKIE_MAX_AGE_SECONDS}s is below the ${MIN_SESSION_PERSISTENCE_SECONDS}s persistence floor`,
    );
  }
  const options = getAuthCookieOptions();
  if (
    options.domain !== undefined &&
    !/^\.[^.\s]+\.[^.\s.]+$/.test(options.domain)
  ) {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN must be the leading-dot registrable domain (e.g. ".whatsappmax.in"), got ${JSON.stringify(options.domain)}`,
    );
  }
  if (libDefaults !== undefined) {
    const d = libDefaults as Record<string, unknown>;
    const problems: string[] = [];
    if (d.path !== "/") problems.push(`path: expected "/" got ${JSON.stringify(d.path)}`);
    if (
      typeof d.sameSite !== "string" ||
      d.sameSite.toLowerCase() !== "lax"
    ) {
      problems.push(`sameSite: expected "lax" got ${JSON.stringify(d.sameSite)}`);
    }
    // Must stay readable from document.cookie (browser persistence).
    if (d.httpOnly !== false) {
      problems.push(`httpOnly: expected false (document.cookie-readable) got ${JSON.stringify(d.httpOnly)}`);
    }
    if (d.maxAge !== AUTH_SESSION_COOKIE_MAX_AGE_SECONDS) {
      problems.push(
        `maxAge: expected ${AUTH_SESSION_COOKIE_MAX_AGE_SECONDS} (400d) got ${JSON.stringify(d.maxAge)}`,
      );
    }
    // Recorded 0.12.0 observation: no `secure` key emitted. Accept a
    // future `secure: true` (strictly safer); reject `secure: false`.
    if (d.secure === false) problems.push(`secure: must never be false`);
    if (problems.length > 0) {
      throw new Error(
        `@supabase/ssr DEFAULT_COOKIE_OPTIONS drifted (update the recorded defaults on bump): ${problems.join("; ")}`,
      );
    }
  }
  return options;
}