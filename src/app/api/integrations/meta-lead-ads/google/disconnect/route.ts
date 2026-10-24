// POST /api/integrations/meta-lead-ads/google/disconnect
//
// Admin+. Removes the account's Meta Sheets Google connection and
// disables auto_sync so no future writes happen. Existing
// spreadsheet contents are left untouched; queued rows are kept
// (they resume after a reconnect) but never processed while
// disconnected. Flow Tables connections are untouched.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { deleteSheetsConnection } from "@/lib/meta-lead-sheets/oauth";

export async function POST() {
  try {
    const ctx = await requireRole("admin");
    await deleteSheetsConnection(ctx.supabase, ctx.accountId);
    await ctx.supabase
      .from("meta_lead_sheets_configs")
      .update({
        auto_sync: false,
        last_error: "Disconnected by admin. Reconnect Google Sheets to resume.",
        updated_at: new Date().toISOString(),
      })
      .eq("account_id", ctx.accountId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
