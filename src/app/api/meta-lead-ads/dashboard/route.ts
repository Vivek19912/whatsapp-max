// ============================================================
// GET /api/meta-lead-ads/dashboard — acquisition analytics for the
// standalone Meta Lead Ads dashboard (route /meta-lead-ads/dashboard).
//
// One analytics request per (day, year): KPI counts plus daily and
// monthly submission aggregates, computed inside Postgres via
// get_meta_leads_analytics() (see supabase/migrations/
// 155_meta_leads_dashboard.sql). Source of truth is
// meta_lead_submissions ONLY — messages, flow_runs, and the Inbox
// lead-source filter are never consulted.
//
// Security: RLS-scoped SSR client (caller's JWT) and a SECURITY
// INVOKER RPC that derives the account from auth.uid() — no
// account_id param, no service role, no cross-workspace reads.
//
// Query params (all required except tz):
//   start, end, prevStart, prevEnd — ISO (today / yesterday local
//   bounds, same convention as /api/dashboard/analytics)
//   year — calendar year for the monthly chart
//   tz   — IANA timezone for day/month bucketing (default UTC)
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

function parseISO(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const url = new URL(request.url);
    const start = parseISO(url.searchParams.get("start"));
    const end = parseISO(url.searchParams.get("end"));
    const prevStart = parseISO(url.searchParams.get("prevStart"));
    const prevEnd = parseISO(url.searchParams.get("prevEnd"));
    const yearRaw = url.searchParams.get("year");
    const year = yearRaw ? Number(yearRaw) : NaN;
    const tz = (url.searchParams.get("tz") || "UTC").slice(0, 64);

    if (!start || !end || !prevStart || !prevEnd) {
      return NextResponse.json(
        { error: "start, end, prevStart and prevEnd are required ISO timestamps" },
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

    const { data, error } = await ctx.supabase.rpc("get_meta_leads_analytics", {
      p_today_start: start,
      p_today_end: end,
      p_yest_start: prevStart,
      p_yest_end: prevEnd,
      p_year: year,
      p_tz: tz,
    });

    if (error) {
      console.error("[meta-leads/dashboard] rpc error:", error);
      return NextResponse.json(
        { error: "Failed to load Meta Lead Ads analytics" },
        { status: 500 },
      );
    }

    const res = NextResponse.json((data as object) ?? {});
    // Never cache analytics: every dashboard load must show one
    // live request in the Network tab, not a cached response.
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
