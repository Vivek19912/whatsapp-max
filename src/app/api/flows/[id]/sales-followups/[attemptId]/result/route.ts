import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { validateFollowupResult } from "@/lib/followups/attempts";
import {
  assertAgentMayTouchRun,
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
 * filter and 409s), optional outcome (validated when provided),
 * non-blank result within the limit. Records the authenticated
 * salesperson + completion instant, then mirrors Last Contact Date
 * (completion day) and clears Next Follow-up. Next Action and
 * Customer Response are never written here.
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
    // Outcome is optional: absent/blank stores NULL (never an
    // invented placeholder); a provided value already passed the
    // eight-option check above.
    const rawOutcome = body?.outcome;
    const outcome =
      typeof rawOutcome === "string" && rawOutcome.trim() !== ""
        ? rawOutcome
        : null;
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
    const lastContactField = fieldIds.lastContactFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.lastContactFieldId)
      : null;

    // No next attempt scheduled: clear the pending datetime; the
    // completion day (UTC) becomes Last Contact Date. Customer
    // Response is NEVER written here — results live in
    // sales_followup_attempts and render in their own Follow-up N
    // Result columns; existing Customer Response values stay
    // exactly as the salesperson left them. Next Action is left
    // entirely alone: no "Schedule Follow-up N" status text is
    // generated (scheduling stays available in Follow-up History),
    // and independently entered actions are never overwritten.
    await writeLeadCell({ supabase, accountId, runId, field: followupField, value: null });
    await writeLeadCell({
      supabase,
      accountId,
      runId,
      field: lastContactField,
      value: completedAt.slice(0, 10),
    });

    return NextResponse.json({ attempt: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
