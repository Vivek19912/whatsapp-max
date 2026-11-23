import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  parseHolidayDate,
  rangesOverlap,
  todayInZone,
} from "@/lib/lead-assignment/holidays";
import { ASSIGNMENT_TIMEZONE } from "@/lib/lead-assignment/table-validation";

type Ctx = { params: Promise<{ id: string }> };

async function loadOwnedHoliday(
  supabase: SupabaseClient,
  accountId: string,
  id: string,
) {
  const { data, error } = await supabase
    .from("lead_assignment_holidays")
    .select("id, user_id, start_date, end_date, reason, cancelled_at")
    .eq("account_id", accountId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as {
    id: string;
    user_id: string;
    start_date: string;
    end_date: string;
    reason: string | null;
    cancelled_at: string | null;
  } | null;
}

/**
 * PATCH /api/team-availability/holidays/[id] — edit a scheduled or
 * active holiday (dates and/or reason). Owner-only, same account.
 * Cancelled windows are history and cannot be edited. Overlap
 * with the member's other live windows is rejected (409).
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("owner");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    const row = await loadOwnedHoliday(supabase, accountId, id);
    if (!row) {
      return NextResponse.json({ error: "Holiday not found." }, { status: 404 });
    }
    if (row.cancelled_at) {
      return NextResponse.json(
        { error: "This holiday was cancelled and cannot be edited." },
        { status: 400 },
      );
    }

    const hasStart = body !== null && "start_date" in body;
    const hasEnd = body !== null && "end_date" in body;
    const start = hasStart ? parseHolidayDate(body?.start_date) : row.start_date;
    const end = hasEnd ? parseHolidayDate(body?.end_date) : row.end_date;
    if ((hasStart && !start) || (hasEnd && !end)) {
      return NextResponse.json(
        { error: "Holiday start and end dates must be valid calendar dates." },
        { status: 400 },
      );
    }
    const nextStart = start ?? row.start_date;
    const nextEnd = end ?? row.end_date;
    if (nextEnd < nextStart) {
      return NextResponse.json(
        { error: "Holiday end date cannot be earlier than the start date." },
        { status: 400 },
      );
    }
    const reason =
      body !== null && "reason" in body
        ? typeof body.reason === "string" && body.reason.trim() !== ""
          ? body.reason.trim().slice(0, 500)
          : null
        : row.reason;

    const today = todayInZone(ASSIGNMENT_TIMEZONE);
    const { data: existing, error: existingErr } = await supabase
      .from("lead_assignment_holidays")
      .select("id, start_date, end_date, cancelled_at")
      .eq("account_id", accountId)
      .eq("user_id", row.user_id);
    if (existingErr) throw existingErr;
    const conflict = ((existing ?? []) as Array<Record<string, unknown>>).some(
      (r) =>
        r.id !== row.id &&
        (r.cancelled_at === null || r.cancelled_at === undefined) &&
        typeof r.start_date === "string" &&
        typeof r.end_date === "string" &&
        r.end_date >= today &&
        rangesOverlap(nextStart, nextEnd, r.start_date, r.end_date),
    );
    if (conflict) {
      return NextResponse.json(
        {
          error:
            "This change overlaps another holiday for the same team member. Edit or cancel it first.",
        },
        { status: 409 },
      );
    }

    const { data: updated, error: updateErr } = await supabase
      .from("lead_assignment_holidays")
      .update({ start_date: nextStart, end_date: nextEnd, reason })
      .eq("account_id", accountId)
      .eq("id", row.id)
      .select("id, user_id, start_date, end_date, reason, cancelled_at")
      .maybeSingle();
    if (updateErr) throw updateErr;
    return NextResponse.json({ holiday: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
