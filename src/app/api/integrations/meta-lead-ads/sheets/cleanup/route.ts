// POST /api/integrations/meta-lead-ads/sheets/cleanup
//
// Admin+. EXPLICIT, confirmed removal of spreadsheet rows belonging
// to DESELECTED Meta forms. Only rows with a verified queue mapping
// (account + submission + recorded sheet_row_number) are deleted,
// bottom-to-top in one request; surviving managed row numbers are
// repaired and the removed queue rows are dropped so the leads do
// not re-sync. Sent rows without a recorded number and all user
// content are never touched. Requires { confirmed: true } —
// otherwise 400. Meta-only: never touches Flow Tables.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { cleanupDeselectedRows } from "@/lib/meta-lead-sheets/queue";
import { getSheetsAccessToken, SheetsAuthError } from "@/lib/meta-lead-sheets/oauth";

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as {
      confirmed?: unknown;
    } | null;
    if (body?.confirmed !== true) {
      return NextResponse.json(
        { error: "Confirm explicitly with { confirmed: true }. This deletes spreadsheet rows." },
        { status: 400 },
      );
    }
    const admin = supabaseAdmin();
    let accessToken: string;
    try {
      accessToken = await getSheetsAccessToken(ctx.supabase, ctx.accountId);
    } catch (err) {
      if (err instanceof SheetsAuthError) {
        return NextResponse.json(
          { error: "Connect a Google account first." },
          { status: 409 },
        );
      }
      throw err;
    }
    const result = await cleanupDeselectedRows(admin, accessToken, ctx.accountId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof Error && /explicit form selection/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return metaErrorResponse(err);
  }
}
