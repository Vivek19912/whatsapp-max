import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  parseHolidayDate,
  rangesOverlap,
  todayInZone,
} from "@/lib/lead-assignment/holidays";
import { isAssignableRole } from "@/lib/lead-assignment/members";
import { ASSIGNMENT_TIMEZONE } from "@/lib/lead-assignment/table-validation";

/**
 * POST /api/team-availability/holidays — record a holiday/leave
 * window for one eligible internal team member. Owner-only.
 *
 * The window is account-wide: while active (start <= today <=
 * end in the assignment zone, not cancelled) the engine excludes
 * the employee from new automatic assignments on every table.
 * Saved configurations and existing lead ownership are never
 * touched. Overlapping live windows for the same employee are
 * rejected (409) so duplicate/conflicting records cannot exist.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("owner");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    const memberId = typeof body?.user_id === "string" ? body.user_id : "";
    const start = parseHolidayDate(body?.start_date);
    const end = parseHolidayDate(body?.end_date);
    const reason =
      typeof body?.reason === "string" && body.reason.trim() !== ""
        ? body.reason.trim().slice(0, 500)
        : null;

    if (memberId === "") {
      return NextResponse.json({ error: "Select a team member." }, { status: 400 });
    }
    if (!start || !end) {
      return NextResponse.json(
        { error: "Holiday start and end dates must be valid calendar dates." },
        { status: 400 },
      );
    }
    if (end < start) {
      return NextResponse.json(
        { error: "Holiday end date cannot be earlier than the start date." },
        { status: 400 },
      );
    }

    // Roster gate: internal, assignable role, same account. External
    // contacts (no profile) can never hold holidays.
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("user_id, account_role")
      .eq("account_id", accountId)
      .eq("user_id", memberId)
      .maybeSingle();
    if (profileErr) throw profileErr;
    const role = (profile as { account_role?: unknown } | null)?.account_role;
    if (!profile || !isAssignableRole(role)) {
      return NextResponse.json(
        { error: "Select an eligible team member from this account." },
        { status: 400 },
      );
    }

    // Overlap guard: only live windows (not cancelled, not fully
    // past) can conflict — completed history never blocks.
    const today = todayInZone(ASSIGNMENT_TIMEZONE);
    const { data: existing, error: existingErr } = await supabase
      .from("lead_assignment_holidays")
      .select("id, start_date, end_date, cancelled_at")
      .eq("account_id", accountId)
      .eq("user_id", memberId);
    if (existingErr) throw existingErr;
    const conflict = ((existing ?? []) as Array<Record<string, unknown>>).some(
      (r) =>
        (r.cancelled_at === null || r.cancelled_at === undefined) &&
        typeof r.start_date === "string" &&
        typeof r.end_date === "string" &&
        r.end_date >= today &&
        rangesOverlap(start, end, r.start_date, r.end_date),
    );
    if (conflict) {
      return NextResponse.json(
        {
          error:
            "This team member already has a holiday covering part of this period. Edit or cancel it first.",
        },
        { status: 409 },
      );
    }

    const { data: created, error: insertErr } = await supabase
      .from("lead_assignment_holidays")
      .insert({
        account_id: accountId,
        user_id: memberId,
        start_date: start,
        end_date: end,
        reason,
        created_by: userId,
      })
      .select("id, user_id, start_date, end_date, reason, cancelled_at")
      .single();
    if (insertErr) throw insertErr;
    return NextResponse.json({ holiday: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
