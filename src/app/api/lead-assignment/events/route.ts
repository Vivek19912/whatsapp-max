import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

/**
 * GET /api/lead-assignment/events — assignment audit history.
 * Any member may read (account-scoped). Optional filters:
 * ?rule_id= (that rule's decisions) or ?run_id= (one lead's trail).
 * Newest first, capped at 100 rows.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const params = new URL(request.url).searchParams;
    const ruleId = params.get("rule_id");
    const runId = params.get("run_id");
    let query = supabase
      .from("lead_assignment_events")
      .select(
        "id, rule_id, flow_id, flow_run_id, form_id, assigned_user_id, previous_user_id, kind, reason, created_by, created_at",
      )
      .eq("account_id", accountId);
    if (ruleId) query = query.eq("rule_id", ruleId);
    if (runId) query = query.eq("flow_run_id", runId);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return NextResponse.json({ events: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
