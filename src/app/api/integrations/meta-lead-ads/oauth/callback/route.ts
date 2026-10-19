// GET /api/integrations/meta-lead-ads/oauth/callback
//
// Meta redirects here with a one-time `code` and `state`. The state must
// match the same-browser cookie and a stored, unexpired, unconsumed state
// bound to the authenticated workspace. The code is exchanged server-side
// (then upgraded to a long-lived token when possible), verified against
// the shared app, and stored as a short-lived selection session. The
// browser only receives a redirect back to Settings.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { graphErrorDetails } from "@/lib/meta-lead-ads/errors";
import {
  debugToken,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getOAuthUser,
  listManagedPages,
} from "@/lib/meta-lead-ads/graph-client";
import {
  hashOAuthState,
  isOAuthCancellation,
  META_LEAD_OAUTH_SESSION_TTL_MS,
  META_LEAD_OAUTH_STATE_COOKIE,
  oauthRedirectUriFromRequest,
  oauthSettingsRedirect,
  oauthStatesMatch,
  type OAuthRedirectStatus,
} from "@/lib/meta-lead-ads/oauth";
import {
  consumeOAuthState,
  createOAuthSession,
} from "@/lib/meta-lead-ads/store";

function readStateCookie(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name !== META_LEAD_OAUTH_STATE_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

function backTo(
  request: Request,
  status: OAuthRedirectStatus,
  reason?: string,
): NextResponse {
  const response = NextResponse.redirect(
    oauthSettingsRedirect(request, status, reason),
  );
  response.cookies.set(META_LEAD_OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/meta-lead-ads/oauth",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  // Never echo Meta's error text into the redirect.
  if (isOAuthCancellation(oauthError)) return backTo(request, "cancelled");
  if (oauthError) return backTo(request, "error", "unexpected");
  if (!code || !state) return backTo(request, "error", "missing_code");

  const cookieState = readStateCookie(request);
  if (!cookieState || !oauthStatesMatch(state, cookieState)) {
    return backTo(request, "error", "invalid_state");
  }

  let ctx: Awaited<ReturnType<typeof requireRole>>;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    const config = metaLeadAdsConfig();
    if (!config) return backTo(request, "error", "unexpected");

    const admin = supabaseAdmin();
    const stateRow = await consumeOAuthState(admin, hashOAuthState(state));
    if (!stateRow) return backTo(request, "error", "invalid_state");
    if (stateRow.accountId !== ctx.accountId || stateRow.userId !== ctx.userId) {
      return backTo(request, "error", "account_mismatch");
    }

    const redirectUri = oauthRedirectUriFromRequest(request);
    let grant: Awaited<ReturnType<typeof exchangeCodeForToken>>;
    try {
      grant = await exchangeCodeForToken(config, code, redirectUri);
    } catch (err) {
      console.error("[meta-oauth] code exchange failed:", graphErrorDetails(err));
      return backTo(request, "error", "token_exchange_failed");
    }

    // Best-effort upgrade: a failed long-lived exchange must not block
    // page selection, but the returned expiry is tracked as-is.
    try {
      grant = await exchangeForLongLivedToken(config, grant.accessToken);
    } catch (err) {
      console.error("[meta-oauth] long-lived exchange failed:", graphErrorDetails(err));
    }

    let tokenInfo: Awaited<ReturnType<typeof debugToken>>;
    try {
      tokenInfo = await debugToken(config, grant.accessToken);
    } catch (err) {
      console.error("[meta-oauth] token verification failed:", graphErrorDetails(err));
      return backTo(request, "error", "token_exchange_failed");
    }
    if (!tokenInfo.isValid) return backTo(request, "error", "invalid_token");
    if (tokenInfo.appId && tokenInfo.appId !== config.appId) {
      return backTo(request, "error", "wrong_app");
    }

    let userName: string | null = null;
    let metaUserId = tokenInfo.userId;
    try {
      const user = await getOAuthUser(config, grant.accessToken);
      metaUserId = user.id ?? metaUserId;
      userName = user.name ?? null;
    } catch (err) {
      console.error("[meta-oauth] user lookup failed:", graphErrorDetails(err));
    }
    if (!metaUserId) return backTo(request, "error", "unexpected");

    let pages: Awaited<ReturnType<typeof listManagedPages>>;
    try {
      pages = await listManagedPages(config, grant.accessToken);
    } catch (err) {
      console.error("[meta-oauth] page discovery failed:", graphErrorDetails(err));
      return backTo(request, "error", "page_discovery_failed");
    }

    try {
      await createOAuthSession(admin, {
        accountId: ctx.accountId,
        userId: ctx.userId,
        accessToken: grant.accessToken,
        tokenExpiry: grant.expiresAt,
        scopes: tokenInfo.scopes.length > 0 ? tokenInfo.scopes : grant.scopes,
        metaUserId,
        metaUserName: userName,
        pages: pages.map((page) => ({
          id: page.id,
          name: page.name ?? null,
          tasks: page.tasks ?? [],
        })),
        expiresAt: new Date(Date.now() + META_LEAD_OAUTH_SESSION_TTL_MS).toISOString(),
      });
    } catch (err) {
      console.error("[meta-oauth] session create failed:", err);
      return backTo(request, "error", "session_failed");
    }

    return backTo(request, "select");
  } catch (err) {
    console.error("[meta-oauth] callback failed:", graphErrorDetails(err));
    return backTo(request, "error", "unexpected");
  }
}
