import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { manualAssign } from "@/lib/lead-assignment/service";
import { ASSIGNED_TO_UNASSIGNED } from "@/lib/flows/workspace-assignee";
import { maybeEnqueueForRun } from "@/lib/meta-lead-ads/notify";
import { supabaseAdmin } from "@/lib/flows/admin-client";

/**
 * POST /api/flows/[id]/leads/[runId]/assign — manually assign (or
 * clear) one Meta lead. Admin+.
 *
 * Reassignment is an admin-only operation: agents work their own
 * assigned leads but cannot move leads between members (that would
 * bypass per-agent ownership). Meta-gated: the service rejects
 * non-Meta flows outright, so Flow Tables can never reach this
 * path. Writes the same Assigned To workspace cell the table
 * displays, and records an audit event (actor, previous, new).
 * Never touches algorithm state, and later Meta updates won't
 * overwrite the manual owner (auto-assign skips owned rows).
 *
 * Body: { user_id: string | "Unassigned" | null }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  try {
    const { id, runId } = await params;
    const { supabase, accountId, userId } = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!("user_id" in body)) {
      return NextResponse.json({ error: "user_id is required." }, { status: 400 });
    }
    const user_id = body.user_id as string | null;

    // The flow's form links the audit event to its Meta table.
    const { data: flow, error: flowErr } = await supabase
      .from("flows")
      .select("meta_form_id")
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (flowErr) throw flowErr;
    const formId = (flow as { meta_form_id: string | null } | null)?.meta_form_id ?? null;

    try {
      const result = await manualAssign(supabase, {
        accountId,
        flowId: id,
        runId,
        formId,
        newUserId: user_id,
        actorUserId: userId,
      });
      // A lead assigned after insertion is notified now (unless it
      // was already notified). Clearing/Unassigning never notifies.
      // Best-effort: never fails assignment.
      if (result.current && result.current !== ASSIGNED_TO_UNASSIGNED) {
        await maybeEnqueueForRun(supabaseAdmin(), {
          accountId,
          runId,
          assigneeUserId: result.current,
        });
      }
      return NextResponse.json({ assignment: result });
    } catch (err) {
      const raw =
        err instanceof Error
          ? (err as unknown as { status?: unknown }).status
          : undefined;
      const status = typeof raw === "number" && raw !== 500 ? raw : 400;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid assignment." },
        { status },
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
