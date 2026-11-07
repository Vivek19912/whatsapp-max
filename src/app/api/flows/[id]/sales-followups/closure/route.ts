import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  assertAgentMayTouchRun,
  loadAttempts,
  loadClosure,
  loadFlow,
  loadLeadFieldIds,
  loadRun,
  loadWritableField,
  writeLeadCell,
} from "../_lib";

/**
 * POST /api/flows/[id]/sales-followups/closure — close the lead's
 * sequence when no further follow-up is required. Agent+.
 *
 * Refused while ANY unresolved attempt exists (a due attempt must
 * have its result recorded first — closure never bypasses it).
 * History is preserved; no further attempt may be scheduled until
 * reopened. DELETE reopens by removing the closure row.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId, accountId, role } = await requireRole("agent");
    const { id: flowId } = await params;
    const body = (await req.json().catch(() => null)) as {
      flow_run_id?: unknown;
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

    const attempts = await loadAttempts(supabase, accountId, runId);
    const open = attempts.find((a) => a.completed_at === null) ?? null;
    if (open) {
      return NextResponse.json(
        {
          error: `Follow-up ${Number(open.attempt_number)} is still open — record its result or wait for it before closing.`,
        },
        { status: 409 },
      );
    }
    if (await loadClosure(supabase, accountId, runId)) {
      return NextResponse.json({ error: "This sequence is already closed." }, { status: 409 });
    }

    const { data: closure, error: closeError } = await supabase
      .from("sales_followup_closures")
      .insert({
        account_id: accountId,
        flow_id: flowId,
        flow_run_id: runId,
        closed_by: userId,
      })
      .select("id, closed_by, closed_at")
      .single();
    if (closeError) throw closeError;

    const fieldIds = await loadLeadFieldIds(supabase, accountId, flowId);
    const followupField = fieldIds.followupFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.followupFieldId)
      : null;
    const nextActionField = fieldIds.nextActionFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.nextActionFieldId)
      : null;
    await writeLeadCell({ supabase, accountId, runId, field: followupField, value: null });
    await writeLeadCell({
      supabase,
      accountId,
      runId,
      field: nextActionField,
      value: "View Follow-up History",
    });

    return NextResponse.json({ closure }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId, accountId, role } = await requireRole("agent");
    const { id: flowId } = await params;
    const runId = new URL(req.url).searchParams.get("flow_run_id");
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

    const { error: reopenError } = await supabase
      .from("sales_followup_closures")
      .delete()
      .eq("account_id", accountId)
      .eq("flow_run_id", runId);
    if (reopenError) throw reopenError;
    return NextResponse.json({ reopened: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
