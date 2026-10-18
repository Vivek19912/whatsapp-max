// POST /api/integrations/meta-lead-ads/retry
//
// Re-runs failed lead processing for this account (admin+). With a
// `submission_id`, retries exactly that submission; otherwise sweeps
// every failed submission whose backoff window has elapsed.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { processSubmissionById, runDueRetries } from "@/lib/meta-lead-ads/process-lead";

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const config = metaLeadAdsConfig();
    if (!config) {
      return NextResponse.json(
        { error: "Meta Lead Ads is not configured on this server." },
        { status: 501 },
      );
    }

    const admin = supabaseAdmin();
    const body = (await request.json().catch(() => null)) as
      | { submission_id?: string }
      | null;
    const submissionId = body?.submission_id?.trim();

    if (submissionId) {
      const { data } = await admin
        .from("meta_lead_submissions")
        .select("id")
        .eq("id", submissionId)
        .eq("account_id", ctx.accountId)
        .maybeSingle();
      if (!data) {
        return NextResponse.json({ error: "Submission not found." }, { status: 404 });
      }
      const result = await processSubmissionById(admin, config, submissionId);
      return NextResponse.json({ ok: true, ...result });
    }

    const result = await runDueRetries(admin, config, 20, ctx.accountId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
