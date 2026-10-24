// GET /api/integrations/meta-lead-ads/google/callback
//
// Google redirects here with ?code=&state=. The state is a one-time
// random value whose hash was stored bound to (account, user); it is
// consumed atomically and must match the signed-in admin's account.
// The code is exchanged server-side, tokens stored encrypted, then
// the admin is bounced back to Settings → Meta with a status flag.
// Tokens never reach the browser.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  consumeSheetsOAuthState,
  exchangeSheetsCodeForTokens,
  metaSheetsRedirectUri,
  saveSheetsConnection,
} from "@/lib/meta-lead-sheets/oauth";

function siteOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return `${proto}://${host}`;
}

function backTo(request: Request, status: string, detail?: string) {
  const url = new URL("/settings", siteOrigin(request));
  url.searchParams.set("tab", "meta-lead-ads");
  url.searchParams.set("meta_sheets", status);
  if (detail) url.searchParams.set("reason", detail);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  if (oauthError) return backTo(request, "error", oauthError);
  if (!code || !state) return backTo(request, "error", "missing_code");

  try {
    const ctx = await requireRole("admin");
    // Consume via the service role so the lookup does not depend on
    // RLS timing; binding is enforced by comparing to the session.
    const consumed = await consumeSheetsOAuthState(supabaseAdmin(), state);
    if (!consumed) return backTo(request, "error", "bad_state");
    if (consumed.accountId !== ctx.accountId || consumed.userId !== ctx.userId) {
      return backTo(request, "error", "account_mismatch");
    }
    const redirectUri = metaSheetsRedirectUri(request);
    const grant = await exchangeSheetsCodeForTokens(code, redirectUri);
    await saveSheetsConnection(supabaseAdmin(), ctx.accountId, grant, ctx.userId);
    return backTo(request, "connected");
  } catch (err) {
    console.error("[meta-sheets-oauth] callback failed:", err);
    return backTo(request, "error", "exchange_failed");
  }
}
