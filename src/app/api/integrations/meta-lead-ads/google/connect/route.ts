// GET /api/integrations/meta-lead-ads/google/connect
//
// Starts the dedicated Meta Sheets Google OAuth flow (admin+).
// Creates a hashed one-time state bound to the account, then 302s
// to Google. Separate from the Flow Tables /api/integrations/google
// flow — different scopes, different callback, different storage.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  buildSheetsAuthUrl,
  createSheetsOAuthState,
  metaSheetsOAuthConfigured,
  metaSheetsRedirectUri,
} from "@/lib/meta-lead-sheets/oauth";

export async function GET(request: Request) {
  try {
    const ctx = await requireRole("admin");
    if (!metaSheetsOAuthConfigured()) {
      return NextResponse.json(
        { error: "Google integration is not configured on this server." },
        { status: 501 },
      );
    }
    const rawState = await createSheetsOAuthState(ctx.supabase, {
      accountId: ctx.accountId,
      userId: ctx.userId,
    });
    const redirectUri = metaSheetsRedirectUri(request);
    return NextResponse.redirect(buildSheetsAuthUrl(rawState, redirectUri));
  } catch (err) {
    return toErrorResponse(err);
  }
}
