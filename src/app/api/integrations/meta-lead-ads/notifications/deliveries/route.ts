// GET /api/integrations/meta-lead-ads/notifications/deliveries
//
// Recent notification delivery states for this account (any member).
// Observable send/failed/pending states for troubleshooting — never
// exposes SMTP credentials (those live only in server env vars).

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const MAX_LIMIT = 50;

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = Math.max(
      1,
      Math.min(
        MAX_LIMIT,
        Number(new URL(request.url).searchParams.get("limit") ?? "25") || 25,
      ),
    );
    const { data, error } = await ctx.supabase
      .from("meta_lead_notifications")
      .select(
        "id, submission_id, flow_run_id, recipient_email, assignee_name, lead_name, lead_phone, form_name, campaign_name, status, attempt, max_attempts, last_error, queued_at, sent_at, sent_message_id, failed_at, created_at",
      )
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return NextResponse.json({ deliveries: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
