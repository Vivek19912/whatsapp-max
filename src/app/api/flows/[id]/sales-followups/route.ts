import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  deriveSequenceState,
  nextActionForState,
  validateScheduledAt,
  type SalesFollowupAttempt,
} from "@/lib/followups/attempts";
import {
  assertAgentMayTouchRun,
  loadAttempts,
  loadClosure,
  loadFlow,
  loadLeadFieldIds,
  loadRun,
  loadWritableField,
  writeLeadCell,
} from "./_lib";

/**
 * GET /api/flows/[id]/sales-followups?flow_run_id=… — the lead's
 * full attempt timeline plus derived sequence state. Agent+.
 *
 * POST /api/flows/[id]/sales-followups — schedule the next attempt.
 * Server-enforced sequencing: 409 when the sequence is closed, when
 * an unresolved attempt exists, or when the latest attempt has no
 * saved result. The next number derives from actual history
 * (MAX()+1); a 23505 race retries once before surfacing 409.
 * Past instants are rejected (422). On success the Workspace
 * Next Follow-up + Next Action cells mirror the new state.
 */

function toAttempt(row: Record<string, unknown>): SalesFollowupAttempt {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    flow_id: String(row.flow_id),
    flow_run_id: String(row.flow_run_id),
    attempt_number: Number(row.attempt_number),
    scheduled_at: String(row.scheduled_at),
    outcome: (row.outcome as string | null) ?? null,
    result_text: (row.result_text as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: String(row.created_at),
    completed_by: (row.completed_by as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    rescheduled_from: (row.rescheduled_from as string | null) ?? null,
    rescheduled_at: (row.rescheduled_at as string | null) ?? null,
    rescheduled_by: (row.rescheduled_by as string | null) ?? null,
    origin: String(row.origin ?? "scheduled"),
  };
}

export async function GET(
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

    const attempts = (await loadAttempts(supabase, accountId, runId)).map(toAttempt);
    const closure = await loadClosure(supabase, accountId, runId);
    const state = deriveSequenceState(attempts, closure !== null);
    return NextResponse.json({
      attempts,
      closure,
      state: { ...state, nextAction: nextActionForState(state) },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId, accountId, role } = await requireRole("agent");
    const { id: flowId } = await params;
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
    const iso = checked.iso;

    const closure = await loadClosure(supabase, accountId, runId);
    if (closure) {
      return NextResponse.json(
        { error: "This follow-up sequence is closed. Reopen it to schedule again." },
        { status: 409 },
      );
    }
    const existing = (await loadAttempts(supabase, accountId, runId)).map(toAttempt);
    const open = existing.find((a) => a.completed_at === null) ?? null;
    if (open) {
      return NextResponse.json(
        {
          error: `Follow-up ${open.attempt_number} still needs its result before the next one can be scheduled.`,
        },
        { status: 409 },
      );
    }
    let nextNumber =
      existing.length === 0
        ? 1
        : Math.max(...existing.map((a) => a.attempt_number)) + 1;

    const insertRow = async (attemptNumber: number) =>
      supabase
        .from("sales_followup_attempts")
        .insert({
          account_id: accountId,
          flow_id: flowId,
          flow_run_id: runId,
          attempt_number: attemptNumber,
          scheduled_at: iso,
          created_by: userId,
          origin: "scheduled",
        })
        .select("*")
        .single();

    let inserted = await insertRow(nextNumber);
    if (inserted.error && inserted.error.code === "23505") {
      // Concurrent scheduler raced us (duplicate number or a fresh
      // open attempt): re-derive once from the winner's rows.
      const fresh = (await loadAttempts(supabase, accountId, runId)).map(toAttempt);
      if (fresh.some((a) => a.completed_at === null)) {
        return NextResponse.json(
          { error: "Another follow-up was just scheduled for this lead." },
          { status: 409 },
        );
      }
      nextNumber = Math.max(...fresh.map((a) => a.attempt_number)) + 1;
      inserted = await insertRow(nextNumber);
    }
    if (inserted.error) throw inserted.error;
    const attempt = toAttempt(
      inserted.data as unknown as Record<string, unknown>,
    );

    // Mirror into the Workspace cells (best-effort; the attempt row
    // is the source of truth — missing/renamed columns skip).
    const fieldIds = await loadLeadFieldIds(supabase, accountId, flowId);
    const followupField = fieldIds.followupFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.followupFieldId)
      : null;
    await writeLeadCell({
      supabase,
      accountId,
      runId,
      field: followupField,
      value: iso,
    });
    const nextActionField = fieldIds.nextActionFieldId
      ? await loadWritableField(supabase, accountId, fieldIds.nextActionFieldId)
      : null;
    await writeLeadCell({
      supabase,
      accountId,
      runId,
      field: nextActionField,
      value: `Follow-up ${attempt.attempt_number} Scheduled`,
    });

    return NextResponse.json({ attempt }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
