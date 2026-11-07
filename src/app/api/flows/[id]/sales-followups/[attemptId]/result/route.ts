import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  nextActionForState,
  responseSummaryForResult,
  validateFollowupResult,
} from "@/lib/followups/attempts";
import {
  assertAgentMayTouchRun,
  loadAttempts,
  loadFlow,
  loadLeadFieldIds,
  loadRun,
  loadWritableField,
  writeLeadCell,
} from "../../_lib";

/**
 * POST /api/flows/[id]/sales-followups/[attemptId]/result — record
 * the mandatory result for the active unresolved attempt. Agent+.
 *
 * Guards: attempt exists for this lead, still unresolved, no result
 * yet (completed_at IS NULL — a second POST collides on the update
 * filter and 409s), valid outcome, non-blank result within the
 * limit. Records the authenticated salesperson + completion
 * instant, then mirrors Last Contact Date (completion day),
 * Customer Response (outcome + summary), clears Next Follow-up,
 * and advances Next Action to Schedule Follow-up N+1.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; attemptId: string }> },
) {
  try {
    const { supabase, userId, accountId, role } = await requireRole("agent");
    const { id: flowId, attemptId } = await params;
    const body = (await req.json().catch(() => null)) as {
      flow_run_id?: unknown;
      outcome?: unknown;
      result_text?: unknown;
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

    const validationError = validateFollowupResult(body?.outcome, body?.result_text);
    if (validationError !== null) {
      return NextResponse.json({ error: validationError }, { status: 422 });
    }
    const outcome = String(body?.outcome);
    const resultText = String(body?.result_text).trim();

    // Claim exactly the unresolved row: a duplicate submission finds
    // zero rows here (completed_at already set) and 409s instead of
    // overwriting history.
    const completedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("sales_followup_attempts")
      .update({
        outcome,
        result_text: resultText,
        completed_by: userId,
        completed_at: completedAt,
      })
      .eq("account_id", accountId)
      .eq("id", attemptId)
      .eq("flow_run_id", runId)
      .is("completed_at", null)
      .select("*")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) {
      return NextResponse.json(
        { error: "This follow-up already has a saved result." },
        { status: 409 },
      );
    }
    const fieldIds = await loadLeadFieldIds(supabase, accountId, flowId);
    const followupField = fieldIds.followupFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.followupFieldId)
      : null;
    const nextActionField = fieldIds.nextActionFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.nextActionFieldId)
      : null;
    const lastContactField = fieldIds.lastContactFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.lastContactFieldId)
      : null;
    const customerResponseField = fieldIds.customerResponseFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.customerResponseFieldId)
      : null;

    // No next attempt scheduled: clear the pending datetime; the
    // completion day (UTC) becomes Last Contact Date.
    await writeLeadCell({ supabase, accountId, runId, field: followupField, value: null });
    await writeLeadCell({
      supabase,
      accountId,
      runId,
      field: lastContactField,
      value: completedAt.slice(0, 10),
    });
    await writeLeadCell({
      supabase,
      accountId,
      runId,
      field: customerResponseField,
      value: responseSummaryForResult(outcome, resultText),
    });
    const attempts = await loadAttempts(supabase, accountId, runId);
    const maxNumber = Math.max(...attempts.map((a) => Number(a.attempt_number)));
    await writeLeadCell({
      supabase,
      accountId,
      runId,
      field: nextActionField,
      value: nextActionForState({
        kind: "completed",
        activeAttempt: null,
        nextAttemptNumber: maxNumber + 1,
      }),
    });

    return NextResponse.json({ attempt: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
