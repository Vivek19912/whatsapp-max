import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import {
  AUTH_SESSION_COOKIE_MAX_AGE_SECONDS,
  MIN_SESSION_PERSISTENCE_SECONDS,
  assertAuthCookieOptions,
  getAuthCookieOptions,
} from "./cookie-options";

const ORIGINAL = process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;
  else process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = ORIGINAL;
});

describe("getAuthCookieOptions", () => {
  it("is host-only (no domain) when no cookie domain is configured", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;
    expect(getAuthCookieOptions()).toEqual({});
  });

  it("sets the apex domain when NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN is configured", () => {
    process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = ".whatsappmax.in";
    expect(getAuthCookieOptions()).toEqual({ domain: ".whatsappmax.in" });
  });

  it("ignores a blank/whitespace cookie domain", () => {
    process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = "   ";
    expect(getAuthCookieOptions()).toEqual({});
  });
});

describe("session persistence duration", () => {
  it("the enforced auth-cookie lifetime is at least the 30-day requirement", () => {
    expect(AUTH_SESSION_COOKIE_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(
      MIN_SESSION_PERSISTENCE_SECONDS,
    );
    expect(MIN_SESSION_PERSISTENCE_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("the enforced lifetime is the @supabase/ssr 400-day max-age", () => {
    expect(AUTH_SESSION_COOKIE_MAX_AGE_SECONDS).toBe(400 * 24 * 60 * 60);
    expect(AUTH_SESSION_COOKIE_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(
      60 * 24 * 60 * 60,
    );
  });
});

describe("assertAuthCookieOptions", () => {
  it("returns {} on localhost/CI (no domain configured)", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN;
    expect(assertAuthCookieOptions()).toEqual({});
  });

  it("returns {domain} when the cookie domain is configured", () => {
    process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = ".whatsappmax.in";
    expect(assertAuthCookieOptions()).toEqual({ domain: ".whatsappmax.in" });
  });

  it("rejects a malformed cookie domain", () => {
    process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN = "whatsappmax.in";
    expect(() => assertAuthCookieOptions()).toThrow(/leading-dot/);
  });

  it("matches the installed @supabase/ssr DEFAULT_COOKIE_OPTIONS", () => {
    // Read the ACTUAL installed library defaults when importable in
    // node; otherwise assert against the recorded 0.12.0 constant.
    // Update the recorded constant (and cookie-options.ts docs) on bump.
    let libDefaults: Record<string, unknown> | null = null;
    try {
      const require = createRequire(import.meta.url);
      const ssr = require("@supabase/ssr") as Record<string, unknown>;
      if (ssr && typeof ssr.DEFAULT_COOKIE_OPTIONS === "object") {
        libDefaults = ssr.DEFAULT_COOKIE_OPTIONS as Record<string, unknown>;
      }
    } catch {
      libDefaults = null;
    }
    const recorded0120 = {
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      maxAge: 400 * 24 * 60 * 60,
    } as const;
    const observed = libDefaults ?? { ...recorded0120 };
    if (libDefaults) {
      // The installed lib must still match what we recorded for 0.12.0;
      // a drift here means the "recorded" fallback above is stale.
      expect({ ...libDefaults }).toMatchObject({ ...recorded0120 });
    }
    expect(() => assertAuthCookieOptions(observed)).not.toThrow();
    expect(observed.path).toBe("/");
    expect(String(observed.sameSite).toLowerCase()).toBe("lax");
    expect(observed.httpOnly).toBe(false);
    expect(observed.maxAge).toBe(AUTH_SESSION_COOKIE_MAX_AGE_SECONDS);
  });
});