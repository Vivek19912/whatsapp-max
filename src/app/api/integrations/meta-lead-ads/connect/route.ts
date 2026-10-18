// GET /api/integrations/meta-lead-ads/connect
//
// Starts the Meta OAuth flow for the caller's account (admin+).
// Drops a short-lived httpOnly nonce cookie used as the CSRF check on
// the callback, then 302s the browser to Meta's consent dialog.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import {
  metaLeadAdsConfig,
  redirectUriFromRequest,
} from "@/lib/meta-lead-ads/config";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  buildAuthUrl,
  newStateNonce,
} from "@/lib/meta-lead-ads/oauth";

export async function GET(request: Request) {
  try {
    const ctx = await requireRole("admin");

    const config = metaLeadAdsConfig();
    if (!config) {
      return NextResponse.json(
        { error: "Meta Lead Ads is not configured on this server." },
        { status: 501 },
      );
    }

    const nonce = newStateNonce();
    const redirectUri = redirectUriFromRequest(request);
    const authUrl = buildAuthUrl(config, ctx.accountId, redirectUri, nonce);

    const res = NextResponse.redirect(authUrl);
    res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    });
    return res;
  } catch (err) {
    return metaErrorResponse(err);
  }
}
