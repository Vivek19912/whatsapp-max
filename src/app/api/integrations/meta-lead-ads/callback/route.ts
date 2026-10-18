// GET /api/integrations/meta-lead-ads/callback
//
// Meta redirects here with ?code=&state=. We enforce the CSRF pair
// (encrypted state ↔ httpOnly nonce cookie), require the state to
// bind to the signed-in admin's account, exchange the code for a
// long-lived user token, validate it, store it ENCRYPTED, and bounce
// back to the settings page.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import {
  metaLeadAdsConfig,
  redirectUriFromRequest,
} from "@/lib/meta-lead-ads/config";
import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";
import { debugToken, getMe } from "@/lib/meta-lead-ads/graph-client";
import {
  OAUTH_STATE_COOKIE,
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  parseOAuthState,
} from "@/lib/meta-lead-ads/oauth";
import { saveConnection } from "@/lib/meta-lead-ads/store";

function siteOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return `${proto}://${host}`;
}

function backTo(
  request: Request,
  status: "connected" | "error",
  detail?: string,
): NextResponse {
  const url = new URL("/settings", siteOrigin(request));
  url.searchParams.set("tab", "meta-lead-ads");
  url.searchParams.set("meta", status);
  if (detail) url.searchParams.set("reason", detail);
  const res = NextResponse.redirect(url);
  // Burn the CSRF nonce regardless of outcome.
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");
  const cookieNonce = readCookie(request, OAUTH_STATE_COOKIE);

  if (oauthError) return backTo(request, "error", oauthError);
  if (!code || !state) return backTo(request, "error", "missing_code");

  try {
    const config = metaLeadAdsConfig();
    if (!config) return backTo(request, "error", "not_configured");

    const ctx = await requireRole("admin");

    let parsed: { accountId: string; nonce: string };
    try {
      parsed = parseOAuthState(state);
    } catch (err) {
      const code = err instanceof MetaLeadAdsError ? err.code : "bad_state";
      return backTo(request, "error", code);
    }
    if (parsed.accountId !== ctx.accountId) {
      return backTo(request, "error", "account_mismatch");
    }
    if (!cookieNonce || cookieNonce !== parsed.nonce) {
      return backTo(request, "error", "csrf_failed");
    }

    const redirectUri = redirectUriFromRequest(request);
    const short = await exchangeCodeForUserToken(config, code, redirectUri);
    const long = await exchangeForLongLivedUserToken(config, short.accessToken);

    const info = await debugToken(config, long.accessToken);
    if (!info.isValid) {
      return backTo(request, "error", "invalid_token");
    }
    const me = await getMe(config, long.accessToken).catch(() => null);

    await saveConnection(
      ctx.supabase,
      ctx.accountId,
      {
        accessToken: long.accessToken,
        expiresAt: long.expiresAt,
        metaUserId: info.userId ?? me?.id ?? null,
        metaUserName: me?.name ?? null,
        scopes: info.scopes.join(","),
      },
      ctx.userId,
    );

    return backTo(request, "connected");
  } catch (err) {
    console.error(
      "[meta-lead-ads] callback failed:",
      err instanceof Error ? err.message : err,
    );
    return backTo(request, "error", "exchange_failed");
  }
}
