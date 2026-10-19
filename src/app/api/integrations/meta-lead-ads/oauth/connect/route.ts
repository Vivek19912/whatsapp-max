// GET /api/integrations/meta-lead-ads/oauth/connect
//
// Starts the per-tenant Facebook Login flow for the caller's workspace.
// Stores a hashed one-time state bound to the authenticated account/user,
// sets the raw state in a same-site HttpOnly cookie, and redirects to
// Meta. The callback must present the same state from the same browser.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import {
  buildOAuthDialogUrl,
  generateOAuthState,
  hashOAuthState,
  META_LEAD_OAUTH_STATE_COOKIE,
  META_LEAD_OAUTH_STATE_TTL_MS,
  oauthRedirectUriFromRequest,
} from "@/lib/meta-lead-ads/oauth";
import { createOAuthState } from "@/lib/meta-lead-ads/store";

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

    const state = generateOAuthState();
    const redirectUri = oauthRedirectUriFromRequest(request);
    const admin = supabaseAdmin();
    await createOAuthState(admin, {
      accountId: ctx.accountId,
      userId: ctx.userId,
      stateHash: hashOAuthState(state),
      expiresAt: new Date(Date.now() + META_LEAD_OAUTH_STATE_TTL_MS).toISOString(),
    });

    const response = NextResponse.redirect(
      buildOAuthDialogUrl(config, redirectUri, state),
    );
    response.cookies.set(META_LEAD_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/integrations/meta-lead-ads/oauth",
      maxAge: META_LEAD_OAUTH_STATE_TTL_MS / 1000,
    });
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}
