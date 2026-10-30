import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isRunOwnedByUser } from "@/lib/flows/workspace-ownership";
import { canManageReminder } from "@/lib/followups/ownership";
import { WORKSPACE_FOLLOWUP_SOURCE_KIND } from "@/lib/followups/workspace-link";

async function loadFollowup(
  supabase: SupabaseClient,
  accountId: string,
  id: string,
) {
  const { data, error } = await supabase
    .from("whatsapp_followups")
    .select("*")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

/**
 * POST /api/followups/[id]/reopen — Agent+, creator/admin/lead-owner.
 *
 * Clears ONLY the manual completion metadata, returning the row to
 * Pending. Delivery status is untouched and no reminder is created —
 * a fresh schedule still goes through the existing Schedule
 * Follow-up dialog (which updates/creates the open link itself).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const { id } = await params;

    const row = await loadFollowup(supabase, accountId, id);
    if (!row) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    let authorized = canManageReminder(
      role,
      row as { created_by?: unknown },
      userId,
    );
    if (!authorized) {
      const sourceRunId = row.source_run_id as string | null;
      if (
        row.source_kind === WORKSPACE_FOLLOWUP_SOURCE_KIND &&
        sourceRunId
      ) {
        const { data: run, error: runErr } = await supabase
          .from("flow_runs")
          .select("id, flow_id")
          .eq("id", sourceRunId)
          .eq("account_id", accountId)
          .maybeSingle();
        if (runErr) throw runErr;
        const flowId = (run as { flow_id?: unknown } | null)?.flow_id;
        authorized =
          typeof flowId === "string" &&
          (await isRunOwnedByUser(supabase, {
            accountId,
            flowId,
            runId: sourceRunId,
            userId,
          }));
      }
    }
    if (!authorized) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    if (!row.followup_completed_at) {
      return NextResponse.json({ reopened: false, already: true, id });
    }

    const { error: updErr } = await supabase
      .from("whatsapp_followups")
      .update({
        followup_completed_at: null,
        followup_completed_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("account_id", accountId)
      .not("followup_completed_at", "is", null);
    if (updErr) throw updErr;
    return NextResponse.json({ reopened: true, already: false, id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
