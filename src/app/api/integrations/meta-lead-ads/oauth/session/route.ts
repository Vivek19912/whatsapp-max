// GET /api/integrations/meta-lead-ads/oauth/session
//
// Returns the caller's pending OAuth Page-selection session. Page metadata
// only; tokens are never returned to the browser.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { getOAuthSession } from "@/lib/meta-lead-ads/store";

export async function GET() {
  try {
    const ctx = await requireRole("admin");
    const session = await getOAuthSession(supabaseAdmin(), ctx.accountId);
    if (!session) {
      return NextResponse.json({ active: false });
    }
    return NextResponse.json({
      active: true,
      expiresAt: session.expires_at,
      userName: session.meta_user_name,
      scopes: session.scopes,
      pages: session.pages.map((page) => ({
        pageId: page.id,
        pageName: page.name,
        tasks: page.tasks,
      })),
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
