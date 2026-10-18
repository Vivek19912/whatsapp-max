// POST /api/integrations/meta-lead-ads/disconnect
//
// Removes the account's Meta authorization + selected Pages (admin+).
// Every selected Page is unsubscribed from the `leadgen` webhook
// (best-effort — a dead token still lets us clear local state), then
// the local rows are removed and the forms disabled. Historical
// submissions and their Workspace rows/runs are preserved, so no lead
// records are deleted.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { unsubscribePageFromLeadgen } from "@/lib/meta-lead-ads/graph-client";
import { disconnectAccount, getPageToken } from "@/lib/meta-lead-ads/store";

export async function POST() {
  try {
    const ctx = await requireRole("admin");

    const config = metaLeadAdsConfig();
    if (config) {
      const { data: pages } = await ctx.supabase
        .from("meta_lead_pages")
        .select("page_id")
        .eq("account_id", ctx.accountId);
      for (const page of (pages ?? []) as Array<{ page_id: string }>) {
        try {
          const pageToken = await getPageToken(ctx.supabase, ctx.accountId, page.page_id);
          await unsubscribePageFromLeadgen(config, pageToken, page.page_id);
        } catch {
          // Best-effort: a revoked/expired token must not block the
          // local teardown, and no lead rows are touched either way.
        }
      }
    }

    await disconnectAccount(ctx.supabase, ctx.accountId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
