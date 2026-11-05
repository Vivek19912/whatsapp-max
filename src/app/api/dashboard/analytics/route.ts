// ============================================================
// GET /api/dashboard/analytics — single-call dashboard data.
//
// Replaces ~89 chunked browser -> PostgREST requests
// (`messages?select=conversation_id...` pages + 200-id
// conversation chunks, each metric re-downloading the same
// rows) with ONE analytics request. All aggregation happens
// inside Postgres via get_dashboard_analytics() (see
// supabase/migrations/074_dashboard_analytics.sql).
//
// Security: uses the RLS-scoped SSR client (caller's JWT) and
// a SECURITY INVOKER RPC that derives the account from
// auth.uid() — no account_id param, no service role, no
// cross-workspace reads.
//
// Query params (all required except tz):
//   start, end, prevStart, prevEnd, yearStart, yearEnd — ISO
//   year — calendar year for the monthly chart
//   tz   — IANA timezone for month bucketing (default UTC)
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { FOLLOWUP_STATUSES } from "@/lib/followups/types";

export const dynamic = "force-dynamic";

function parseISO(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Optional YYYY-MM-DD calendar-day bound for the daily chart's
 * custom window (migration 083). Null when absent; validated
 * strictly (real calendar date) so malformed input is rejected
 * rather than silently shifting the window.
 */
function parseDayKey(value: string | null): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return value;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const url = new URL(request.url);
    const start = parseISO(url.searchParams.get("start"));
    const end = parseISO(url.searchParams.get("end"));
    const prevStart = parseISO(url.searchParams.get("prevStart"));
    const prevEnd = parseISO(url.searchParams.get("prevEnd"));
    const yearStart = parseISO(url.searchParams.get("yearStart"));
    const yearEnd = parseISO(url.searchParams.get("yearEnd"));
    const yearRaw = url.searchParams.get("year");
    const year = yearRaw ? Number(yearRaw) : NaN;
    const tz = (url.searchParams.get("tz") || "UTC").slice(0, 64);
    // Optional custom window for the daily chart only (migration
    // 083). Absent (or both absent) → trailing-30 behavior, exactly
    // as before. Any other dashboard output is unaffected.
    const dailyStartRaw = url.searchParams.get("dailyStart");
    const dailyEndRaw = url.searchParams.get("dailyEnd");
    let dailyStart: string | null = null;
    let dailyEnd: string | null = null;
    if (dailyStartRaw !== null || dailyEndRaw !== null) {
      dailyStart = parseDayKey(dailyStartRaw);
      dailyEnd = parseDayKey(dailyEndRaw);
      if (!dailyStart || !dailyEnd) {
        return NextResponse.json(
          { error: "dailyStart and dailyEnd must both be valid YYYY-MM-DD dates" },
          { status: 400 },
        );
      }
      const spanDays =
        (Date.parse(dailyEnd) - Date.parse(dailyStart)) / 86_400_000;
      if (!Number.isFinite(spanDays) || spanDays < 0 || spanDays > 366) {
        return NextResponse.json(
          { error: "dailyEnd must be on/after dailyStart and within 366 days" },
          { status: 400 },
        );
      }
    }

    if (!start || !end || !prevStart || !prevEnd || !yearStart || !yearEnd) {
      return NextResponse.json(
        { error: "start, end, prevStart, prevEnd, yearStart and yearEnd are required ISO timestamps" },
        { status: 400 },
      );
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return NextResponse.json(
        { error: "year must be an integer between 2000 and 2100" },
        { status: 400 },
      );
    }
    if (Date.parse(end) <= Date.parse(start)) {
      return NextResponse.json(
        { error: "end must be after start" },
        { status: 400 },
      );
    }

    // The daily-window params are only sent when a custom window
    // was requested, so pre-083 backends keep serving the default
    // call shape untouched.
    const { data, error } = await ctx.supabase.rpc("get_dashboard_analytics", {
      p_start: start,
      p_end: end,
      p_prev_start: prevStart,
      p_prev_end: prevEnd,
      p_year_start: yearStart,
      p_year_end: yearEnd,
      p_year: year,
      p_tz: tz,
      ...(dailyStart && dailyEnd
        ? { p_daily_from: dailyStart, p_daily_to: dailyEnd }
        : {}),
    });

    if (error) {
      console.error("[dashboard/analytics] rpc error:", error);
      return NextResponse.json(
        { error: "Failed to load dashboard analytics" },
        { status: 500 },
      );
    }

    // Scheduled-reminder count (dashboard "Scheduled Reminders" card).
    // Statuses come from the shared reminder module's enum — the "pending"
    // set is every status that is NOT a terminal/irrelevant outcome
    // (scheduled + processing), so sent/failed/cancelled rows never count.
    // Best-effort: a count failure must not take the whole dashboard down,
    // so it degrades to 0 with a logged error (the reminder rows themselves
    // are unaffected — this is read-only).
    const pendingReminderStatuses = FOLLOWUP_STATUSES.filter(
      (s) => s !== "sent" && s !== "failed" && s !== "cancelled",
    );
    // Agent isolation: agents count only their OWN reminders —
    // never workspace-wide totals.
    let scheduledQuery = ctx.supabase
      .from("whatsapp_followups")
      .select("id", { count: "exact", head: true })
      .eq("account_id", ctx.accountId)
      .in("status", pendingReminderStatuses);
    if (ctx.role === "agent") {
      scheduledQuery = scheduledQuery.eq("created_by", ctx.userId);
    }
    const { count: scheduledCount, error: scheduledError } = await scheduledQuery;
    if (scheduledError) {
      console.error(
        "[dashboard/analytics] scheduled reminders count error:",
        scheduledError,
      );
    }

    const res = NextResponse.json({
      ...(data as object),
      scheduledReminderCount: scheduledError ? 0 : (scheduledCount ?? 0),
    });
    // Never cache analytics: every dashboard load must show one
    // live request in the Network tab, not a cached response.
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
