import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getTableConfig } from "@/lib/lead-assignment/table-config";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/flows/[id]/assignment/notifications — recent assignee
 * alert deliveries for this table (email + WhatsApp outbox rows
 * with per-row status, attempts, and the last error). Owner-only:
 * rows carry private recipient addresses.
 *
 * Pure read — polling never restarts work or resends anything.
 */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const ctx = await requireRole("owner");
    const detail = await getTableConfig(ctx.supabase, ctx.accountId, id);
    if (!detail) {
      return NextResponse.json({ notifications: [] });
    }
    const limitParam = new URL(request.url).searchParams.get("limit");
    const limit = Math.max(1, Math.min(Number(limitParam) || 50, 200));
    const { data, error } = await ctx.supabase
      .from("lead_assignment_notifications")
      .select(
        "id, channel, to_email, to_phone, subject, status, attempt, max_attempts, last_error, sent_at, failed_at, created_at, flow_run_id, assignee_id",
      )
      .eq("account_id", ctx.accountId)
      .eq("config_id", detail.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return NextResponse.json({ notifications: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
