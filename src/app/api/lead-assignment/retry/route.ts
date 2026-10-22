import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { retryAssignRun } from "@/lib/lead-assignment/service";
import { maybeEnqueueForRun } from "@/lib/meta-lead-ads/notify";
import { supabaseAdmin } from "@/lib/flows/admin-client";

/**
 * POST /api/lead-assignment/retry — retry automatic assignment for
 * one lead row (e.g. after an earlier failure left it unassigned).
 * Agent+.
 *
 * Resolves the Meta table from the flow, then runs the same
 * idempotent assignment: owned rows (manual or auto) are left
 * alone, so retries can never duplicate or overwrite.
 *
 * Body: { flow_id: string, run_id: string }.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { flow_id: flowId, run_id: runId } = body as {
      flow_id?: unknown;
      run_id?: unknown;
    };
    if (typeof flowId !== "string" || !flowId) {
      return NextResponse.json({ error: "flow_id is required." }, { status: 400 });
    }
    if (typeof runId !== "string" || !runId) {
      return NextResponse.json({ error: "run_id is required." }, { status: 400 });
    }
    const { data: flow, error: flowErr } = await supabase
      .from("flows")
      .select("id, kind, meta_form_id")
      .eq("id", flowId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (flowErr) throw flowErr;
    const typed = flow as {
      id: string;
      kind: string | null;
      meta_form_id: string | null;
    } | null;
    if (!typed || typed.kind !== "meta_lead_ads" || !typed.meta_form_id) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const result = await retryAssignRun(supabase, {
      accountId,
      flowId,
      runId,
      formId: typed.meta_form_id,
    });
    // A lead assigned by the retry is notified now (unless already
    // notified). Best-effort: never fails assignment.
    if (result.outcome === "assigned" && result.userId) {
      await maybeEnqueueForRun(supabaseAdmin(), {
        accountId,
        runId,
        assigneeUserId: result.userId,
      });
    }
    return NextResponse.json({ assignment: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
