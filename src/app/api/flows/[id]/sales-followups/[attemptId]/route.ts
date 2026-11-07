import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { validateScheduledAt } from "@/lib/followups/attempts";
import {
  assertAgentMayTouchRun,
  loadFlow,
  loadLeadFieldIds,
  loadRun,
  loadWritableField,
  writeLeadCell,
} from "../_lib";

/**
 * PATCH /api/flows/[id]/sales-followups/[attemptId] — reschedule a
 * pending attempt. Agent+.
 *
 * Only a future (not yet due) unresolved attempt may move, and it
 * updates in place — never a duplicate. The previous timestamp is
 * kept in rescheduled_from for audit. Due attempts (and completed
 * ones) are rejected: record the result first.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; attemptId: string }> },
) {
  try {
    const { supabase, userId, accountId, role } = await requireRole("agent");
    const { id: flowId, attemptId } = await params;
    const body = (await req.json().catch(() => null)) as {
      flow_run_id?: unknown;
      scheduled_for?: unknown;
    } | null;
    const runId = typeof body?.flow_run_id === "string" ? body.flow_run_id : "";
    if (!runId) {
      return NextResponse.json({ error: "flow_run_id is required." }, { status: 400 });
    }
    const flow = await loadFlow(supabase, accountId, flowId);
    if (!flow) return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    const run = await loadRun(supabase, accountId, flowId, runId);
    if (!run) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
    const allowed = await assertAgentMayTouchRun({
      supabase,
      accountId,
      flowId,
      flowKind: flow.kind,
      runId,
      role,
      userId,
    });
    if (!allowed) return NextResponse.json({ error: "Lead not found." }, { status: 404 });

    const checked = validateScheduledAt(body?.scheduled_for);
    if ("error" in checked) {
      return NextResponse.json({ error: checked.error }, { status: 422 });
    }

    const { data: existing, error: readError } = await supabase
      .from("sales_followup_attempts")
      .select("*")
      .eq("account_id", accountId)
      .eq("id", attemptId)
      .eq("flow_run_id", runId)
      .maybeSingle();
    if (readError) throw readError;
    const attempt = (existing ?? null) as Record<string, unknown> | null;
    if (!attempt) {
      return NextResponse.json({ error: "Follow-up not found." }, { status: 404 });
    }
    if (attempt.completed_at !== null) {
      return NextResponse.json(
        { error: "Completed results cannot be changed. Schedule the next follow-up instead." },
        { status: 409 },
      );
    }
    if (new Date(String(attempt.scheduled_at)).getTime() <= Date.now()) {
      return NextResponse.json(
        { error: "This follow-up is due — record its result first." },
        { status: 409 },
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from("sales_followup_attempts")
      .update({
        scheduled_at: checked.iso,
        rescheduled_from: attempt.scheduled_at,
        rescheduled_at: new Date().toISOString(),
        rescheduled_by: userId,
      })
      .eq("account_id", accountId)
      .eq("id", attemptId)
      .select("*")
      .single();
    if (updateError) throw updateError;

    const fieldIds = await loadLeadFieldIds(supabase, accountId, flowId);
    const followupField = fieldIds.followupFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.followupFieldId)
      : null;
    await writeLeadCell({
      supabase,
      accountId,
      runId,
      field: followupField,
      value: checked.iso,
    });

    return NextResponse.json({ attempt: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
