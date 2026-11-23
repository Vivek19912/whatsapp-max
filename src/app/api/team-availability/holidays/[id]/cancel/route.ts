import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/team-availability/holidays/[id]/cancel — cancel an
 * upcoming holiday, or end an active holiday early. Owner-only,
 * same account. Sets cancelled_at (history preserved); the
 * employee becomes available for new assignments immediately.
 * Idempotent: cancelling twice returns the row unchanged.
 */
export async function POST(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("owner");

    const { data: row, error: loadErr } = await supabase
      .from("lead_assignment_holidays")
      .select("id, user_id, start_date, end_date, reason, cancelled_at")
      .eq("account_id", accountId)
      .eq("id", id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!row) {
      return NextResponse.json({ error: "Holiday not found." }, { status: 404 });
    }

    const { data: updated, error: updateErr } = await supabase
      .from("lead_assignment_holidays")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("account_id", accountId)
      .eq("id", id)
      .select("id, user_id, start_date, end_date, reason, cancelled_at")
      .maybeSingle();
    if (updateErr) throw updateErr;
    return NextResponse.json({ holiday: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
