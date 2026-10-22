import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import {
  recoveryErrorSlugFromExchangeError,
  recoveryErrorSlugFromParams,
  resolveSafeNextPath,
} from "@/lib/auth/recovery";

/**
 * GET /auth/callback — PKCE code-exchange landing for auth emails
 * (password recovery, invites, ...).
 *
 * Supabase redirects here after verifying the OTP with either:
 *   - `?code=` — exchange it for a session, then land on `next`
 *     (default /reset-password); or
 *   - `?error=&error_code=` — verification already failed at
 *     Supabase (expired/used/revoked link). Forward to
 *     /reset-password with a stable error slug, never raw
 *     provider text.
 *
 * Missing parameters land on /reset-password?error=invalid. The
 * code itself is never logged.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const target = resolveSafeNextPath(params.get("next"));

  const providerError = params.get("error");
  if (providerError) {
    const slug = recoveryErrorSlugFromParams({
      error: providerError,
      error_code: params.get("error_code"),
    });
    return NextResponse.redirect(
      new URL(`/reset-password?error=${slug}`, request.url),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/reset-password?error=invalid", request.url),
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const slug = recoveryErrorSlugFromExchangeError(error);
    return NextResponse.redirect(
      new URL(`/reset-password?error=${slug}`, request.url),
    );
  }

  return NextResponse.redirect(new URL(target, request.url));
}
