// GET /api/integrations/meta-lead-ads/google/status
//
// Lightweight probe for the Meta Sheets settings card: is the server
// configured, is a Google account connected (email only), and is the
// sync status healthy. Tokens are NEVER returned. Meta-only — does
// not read `google_connections` (Flow Tables).

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getSheetsSyncStatus } from "@/lib/meta-lead-sheets/queue";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const status = await getSheetsSyncStatus(ctx.supabase, ctx.accountId);
    return NextResponse.json(status);
  } catch (err) {
    return toErrorResponse(err);
  }
}
