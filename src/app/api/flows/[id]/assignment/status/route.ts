import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  getTableConfig,
  resolveTableFlow,
  setTableConfigEnabled,
} from "@/lib/lead-assignment/table-config";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/flows/[id]/assignment/status — pause or resume
 * automatic assignment for THIS table only. Owner-only.
 *
 * Body: { action: "pause" | "resume" }
 *
 * Narrowly scoped: flips only `lead_assignment_table_configs.enabled`.
 * Assignees, mode, templates, and algorithm state are never touched,
 * so pausing/resuming can never overwrite unsaved distribution
 * settings. Only future arrivals are affected — existing lead
 * owners are never rewritten. The response reflects the persisted
 * row; callers must update displayed status only after this
 * confirms.
 *
 * Resume validates the saved configuration is still activatable:
 * at least one active assignee, and percentage shares totalling
 * exactly 100% in percentage mode. Invalid configurations get a
 * 400 and stay paused.
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const ctx = await requireRole("owner");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const action = body.action;
    if (action !== "pause" && action !== "resume") {
      return NextResponse.json(
        { error: 'action must be "pause" or "resume".' },
        { status: 400 },
      );
    }
    const gate = await resolveTableFlow(ctx.supabase, ctx.accountId, id);
    if (!gate) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    const admin = supabaseAdmin();
    const detail = await getTableConfig(admin, ctx.accountId, id);
    if (!detail) {
      return NextResponse.json(
        { error: "No assignment configuration yet." },
        { status: 404 },
      );
    }
    if (action === "resume") {
      const active = detail.assignees.filter((a) => a.is_active);
      if (active.length === 0) {
        return NextResponse.json(
          { error: "Add at least one active assignee before resuming." },
          { status: 400 },
        );
      }
      if (detail.mode === "percentage") {
        const total = active.reduce((sum, a) => sum + a.weight, 0);
        if (total !== 100) {
          return NextResponse.json(
            {
              error: `Active assignees' percentages must total exactly 100% (currently ${total}%).`,
            },
            { status: 400 },
          );
        }
      }
    }
    const updated = await setTableConfigEnabled(admin, {
      accountId: ctx.accountId,
      flowId: id,
      enabled: action === "resume",
    });
    return NextResponse.json({
      ok: true,
      config: {
        id: updated.id,
        flow_id: updated.flow_id,
        enabled: updated.enabled,
        mode: updated.mode,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
