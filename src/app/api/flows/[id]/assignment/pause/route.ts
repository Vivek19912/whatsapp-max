import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { pauseTableAssignee } from "@/lib/lead-assignment/table-config";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/flows/[id]/assignment/pause — pause or resume one
 * assignee of this table. Owner-only.
 *
 * Body:
 *   { assignee_id: string,
 *     mode: "today" | "days" | "until" | "resume",
 *     days?: number,            // mode "days": 1–365
 *     until?: string,            // mode "until": IST wall time or absolute ISO instant
 *     reason?: string,           // optional, ≤280 chars
 *     scope?: "table" | "account", // default "table"
 *     timezone?: string }        // legacy, ignored: always Asia/Kolkata
 *
 * "today" ends at midnight IST. A zone-less "until" wall reading is
 * interpreted as IST; explicit instants (Z/offset) stay absolute.
 * Expiry is automatic (evaluated at assignment time); "resume"
 * clears the window immediately. The assignee id is resolved
 * strictly under this table's config — foreign ids 404 and can
 * never pause another table's roster.
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
    const assigneeId = body.assignee_id;
    if (typeof assigneeId !== "string" || assigneeId.trim() === "") {
      return NextResponse.json({ error: "assignee_id is required." }, { status: 400 });
    }
    const assignee = await pauseTableAssignee(ctx.supabase, {
      accountId: ctx.accountId,
      flowId: id,
      assigneeId: assigneeId.trim(),
      input: {
        mode: body.mode,
        days: body.days,
        until: body.until,
        reason: body.reason,
        scope: body.scope,
        timezone: body.timezone,
      },
    });
    return NextResponse.json({ ok: true, assignee });
  } catch (err) {
    return toErrorResponse(err);
  }
}
