import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import type { AccountRole } from "@/lib/auth/roles";
import { isRunOwnedByUser } from "@/lib/flows/workspace-ownership";
import { canManageReminder } from "@/lib/followups/ownership";
import {
  decideCompletionUpdate,
  shouldClearWorkspaceCell,
} from "@/lib/followups/followup-view";
import { isWorkspaceFollowupFieldName } from "@/lib/followups/workspace-link";
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

async function loadRunFlowId(
  supabase: SupabaseClient,
  accountId: string,
  runId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("flow_runs")
    .select("id, flow_id")
    .eq("id", runId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { flow_id?: unknown } | null;
  return typeof row?.flow_id === "string" ? row.flow_id : null;
}

/**
 * Authorized when the caller created the reminder, is an admin, or
 * (for Workspace-linked rows) owns the lead. Agents never manage
 * another user's restricted follow-up.
 */
async function isAuthorized(
  supabase: SupabaseClient,
  opts: {
    role: AccountRole;
    userId: string;
    accountId: string;
    row: Record<string, unknown>;
  },
): Promise<boolean> {
  if (
    canManageReminder(opts.role, opts.row as { created_by?: unknown }, opts.userId)
  ) {
    return true;
  }
  const sourceKind = opts.row.source_kind as string | null;
  const sourceRunId = opts.row.source_run_id as string | null;
  if (sourceKind !== WORKSPACE_FOLLOWUP_SOURCE_KIND || !sourceRunId) {
    return false;
  }
  const flowId = await loadRunFlowId(supabase, opts.accountId, sourceRunId);
  if (!flowId) return false;
  return isRunOwnedByUser(supabase, {
    accountId: opts.accountId,
    flowId,
    runId: sourceRunId,
    userId: opts.userId,
  });
}

/**
 * Clear the Workspace follow-up cell ONLY when it still holds this
 * row's own scheduled instant. A newer re-schedule is never touched.
 * Returns true when a cell was cleared.
 */
async function syncWorkspaceCell(
  supabase: SupabaseClient,
  accountId: string,
  row: Record<string, unknown>,
): Promise<boolean> {
  const sourceKind = row.source_kind as string | null;
  const sourceRunId = row.source_run_id as string | null;
  const scheduledFor = row.scheduled_for as string | null;
  if (sourceKind !== WORKSPACE_FOLLOWUP_SOURCE_KIND || !sourceRunId) {
    return false;
  }
  const flowId = await loadRunFlowId(supabase, accountId, sourceRunId);
  if (!flowId) return false;
  const { data: fields, error: fieldsErr } = await supabase
    .from("workspace_fields")
    .select("id, name, field_type")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (fieldsErr) throw fieldsErr;
  const field = ((fields ?? []) as Array<Record<string, unknown>>).find(
    (f) =>
      f.field_type === "datetime" &&
      isWorkspaceFollowupFieldName(f.name as string),
  );
  if (!field) return false;
  const fieldId = field.id as string;
  const { data: cell, error: cellErr } = await supabase
    .from("workspace_values")
    .select("value_text")
    .eq("account_id", accountId)
    .eq("field_id", fieldId)
    .eq("flow_run_id", sourceRunId)
    .maybeSingle();
  if (cellErr) throw cellErr;
  const cellValue = (cell as { value_text?: unknown } | null)?.value_text as
    | string
    | null
    | undefined;
  if (!shouldClearWorkspaceCell(cellValue, scheduledFor)) return false;
  const { error: delErr } = await supabase
    .from("workspace_values")
    .delete()
    .eq("account_id", accountId)
    .eq("field_id", fieldId)
    .eq("flow_run_id", sourceRunId);
  if (delErr) throw delErr;
  return true;
}

/**
 * POST /api/followups/[id]/complete — Agent+, creator/admin/lead-owner.
 *
 * Records manual sales-work completion on the Workspace follow-up
 * instance. A still-scheduled/processing reminder is cancelled via
 * the normal guarded transition (delivery history preserved);
 * sent/failed/cancelled rows keep their delivery state untouched.
 * The linked Workspace cell is cleared only when it still refers to
 * this follow-up's own scheduled instant.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const { id } = await params;

    let row = await loadFollowup(supabase, accountId, id);
    if (!row) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!(await isAuthorized(supabase, { role, userId, accountId, row }))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const now = new Date().toISOString();
    const decision = decideCompletionUpdate({
      status: row.status as string,
      followup_completed_at: (row.followup_completed_at as string | null) ?? null,
    });

    if (decision.kind === "already-completed") {
      return NextResponse.json({
        completed: true,
        already: true,
        id: row.id,
        status: row.status,
        followup_completed_at: row.followup_completed_at,
      });
    }

    if (decision.kind === "cancel-and-complete") {
      const { data: claimed, error: claimErr } = await supabase
        .from("whatsapp_followups")
        .update({
          status: "cancelled",
          cancelled_at: now,
          followup_completed_at: now,
          followup_completed_by: userId,
          updated_at: now,
        })
        .eq("id", id)
        .eq("account_id", accountId)
        .in("status", ["scheduled", "processing"])
        .select("id, status, followup_completed_at")
        .maybeSingle();
      if (claimErr) throw claimErr;
      if (!claimed) {
        // Lost a race: re-read and fall through to completion-only
        // when the row has since reached a terminal state.
        row = await loadFollowup(supabase, accountId, id);
        if (!row) {
          return NextResponse.json({ error: "Not found." }, { status: 404 });
        }
        const retry = decideCompletionUpdate({
          status: row.status as string,
          followup_completed_at:
            (row.followup_completed_at as string | null) ?? null,
        });
        if (retry.kind !== "complete-only") {
          return NextResponse.json(
            { error: "The follow-up changed. Please retry." },
            { status: 409 },
          );
        }
      } else {
        row = { ...row, ...(claimed as Record<string, unknown>) };
        const cellCleared = await syncWorkspaceCell(supabase, accountId, row);
        return NextResponse.json({
          completed: true,
          already: false,
          id,
          status: "cancelled",
          followup_completed_at: now,
          cellCleared,
        });
      }
    }

    // complete-only: delivery history untouched (never marked sent).
    const { error: updErr } = await supabase
      .from("whatsapp_followups")
      .update({
        followup_completed_at: now,
        followup_completed_by: userId,
        updated_at: now,
      })
      .eq("id", id)
      .eq("account_id", accountId)
      .is("followup_completed_at", null);
    if (updErr) throw updErr;
    const cellCleared = await syncWorkspaceCell(supabase, accountId, {
      ...row,
      followup_completed_at: now,
    });
    return NextResponse.json({
      completed: true,
      already: false,
      id,
      status: row.status,
      followup_completed_at: now,
      cellCleared,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
