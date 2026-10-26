// POST /api/integrations/meta-lead-ads/sheets/retry
//
// Owner-only. Manual sync-now: drains this account's due Meta Sheets queue
// rows (force includes auto_sync=false configs). Body optionally
// narrows to one submission: { submission_id }. Google API failures
// stay queued with backoff — never silently marked successful.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { drainSheetsQueue } from "@/lib/meta-lead-sheets/queue";

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("owner");
    const admin = supabaseAdmin();
    const body = (await request.json().catch(() => null)) as {
      submission_id?: unknown;
    } | null;
    const submissionId =
      typeof body?.submission_id === "string" && body.submission_id.trim() !== ""
        ? body.submission_id.trim()
        : null;

    // Consistent with the per-table retry route: reviving an
    // exhausted row resets the FULL retry state (fresh attempt
    // budget, due immediately). Only `failed` rows are ever
    // revived — `sent` rows are never touched, so synced
    // spreadsheet rows cannot duplicate, and other accounts'
    // rows are excluded by the account_id scope.
    let revived = 0;
    if (submissionId) {
      // Verify ownership (tenant isolation) before touching the queue.
      const { data } = await admin
        .from("meta_lead_submissions")
        .select("id")
        .eq("id", submissionId)
        .eq("account_id", ctx.accountId)
        .maybeSingle();
      if (!data) {
        return NextResponse.json({ error: "Submission not found." }, { status: 404 });
      }
      // Reset this row to due-now with a fresh attempt budget so an
      // exhausted failure can actually deliver on the drain below.
      // Only failed rows are reset — sent rows are never touched.
      const { data: reset } = await admin
        .from("meta_lead_sheets_queue")
        .update({
          status: "queued",
          attempts: 0,
          last_error: null,
          next_retry_at: new Date().toISOString(),
          claimed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("account_id", ctx.accountId)
        .eq("submission_id", submissionId)
        .eq("status", "failed")
        .select("id");
      revived = ((reset ?? []) as unknown[]).length;
    }

    const result = await drainSheetsQueue(admin, {
      onlyAccountId: ctx.accountId,
      force: true,
      limit: 20,
    });
    return NextResponse.json({ ok: true, revived, ...result });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
