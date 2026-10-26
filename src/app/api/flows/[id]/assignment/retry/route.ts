import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  getTableConfig,
  resolveTableFlow,
} from "@/lib/lead-assignment/table-config";
import { retryTableAssignRun } from "@/lib/lead-assignment/table-assignment";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/flows/[id]/assignment/retry — retry automatic
 * assignment for one lead row of this table (e.g. after an
 * earlier failure left it unassigned). Agent+.
 *
 * Owned rows (manual or auto) are left alone, so retries can
 * never duplicate or overwrite. Notifications are handled inside
 * the engine (idempotent per lead/assignee/channel) — this route
 * never sends directly. Meta and Flow tables share this path;
 * the table's own config decides.
 *
 * Body: { run_id: string }.
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const ctx = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const runId = body.run_id;
    if (typeof runId !== "string" || runId.trim() === "") {
      return NextResponse.json({ error: "run_id is required." }, { status: 400 });
    }
    const flow = await resolveTableFlow(ctx.supabase, ctx.accountId, id);
    if (!flow) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    // The run must belong to this account and flow.
    const { data: run, error: runErr } = await ctx.supabase
      .from("flow_runs")
      .select("id")
      .eq("id", runId)
      .eq("account_id", ctx.accountId)
      .eq("flow_id", id)
      .maybeSingle();
    if (runErr) throw runErr;
    if (!run) {
      return NextResponse.json({ error: "Lead not found." }, { status: 404 });
    }
    const detail = await getTableConfig(ctx.supabase, ctx.accountId, id);
    if (!detail || !detail.enabled) {
      return NextResponse.json(
        { error: "Automatic assignment is not enabled for this table." },
        { status: 409 },
      );
    }
    // Service role for the assignment write (same pattern as the
    // ingestion path); the (account, flow, run) triple above
    // already scopes the mutation to this table.
    const result = await retryTableAssignRun(supabaseAdmin(), {
      accountId: ctx.accountId,
      flowId: id,
      runId: runId.trim(),
      formId: flow.formDbId,
    });
    return NextResponse.json({ assignment: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
