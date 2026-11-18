// ============================================================
// GET /api/meta-lead-ads/agent-dashboard — personal (self-scoped)
// Meta Lead Ads analytics for the agent dashboard
// (route /meta-lead-ads/dashboard, non-owner view).
//
// One analytics request per (day, year): the caller's CURRENTLY
// assigned leads only (KPIs, daily + monthly submission
// aggregates with per-form splits, and a Stage overview),
// computed inside Postgres via get_meta_leads_agent_analytics()
// (see supabase/migrations/169_meta_leads_agent_dashboard.sql).
//
// Security: the member is derived inside the RPC from auth.uid()
// — no member/account_id param exists, so an agent cannot spoof
// another member's id. Any authenticated account member may call
// this (it only ever returns their own assigned leads); the
// account-wide /api/meta-lead-ads/dashboard stays owner-only.
// Tenant isolation and RLS posture mirror the owner dashboard
// (SECURITY INVOKER RPC, account derived from auth.uid()).
//
// Query params (all required except tz): same convention as the
// owner dashboard.
//   start, end, prevStart, prevEnd — ISO (today / yesterday local
//   bounds)
//   year — calendar year for the monthly chart
//   tz   — IANA timezone for day/month bucketing (default UTC)
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { rollupTrailingKpis } from "@/lib/meta-leads-dashboard/analytics-client";

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

    const { data, error } = await ctx.supabase.rpc("get_meta_leads_agent_analytics", {
      p_today_start: start,
      p_today_end: end,
      p_yest_start: prevStart,
      p_yest_end: prevEnd,
      p_year: year,
      p_tz: tz,
    });

    if (error) {
      console.error("[meta-leads/agent-dashboard] rpc error:", error);
      return NextResponse.json(
        { error: "Failed to load Meta Lead Ads analytics" },
        { status: 500 },
      );
    }

    const res = NextResponse.json(
      withRollingKpis((data as Record<string, unknown> | null) ?? {}),
    );
    // Never cache analytics: every dashboard load must show one
    // live request in the Network tab, not a cached response.
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Rolling Last-7 / Last-30 KPIs, derived server-side from the
 * RPC's own trailing-30 daily buckets (same helper as the owner
 * dashboard). Same request, same buckets, no extra query.
 */
function withRollingKpis(payload: Record<string, unknown>): Record<string, unknown> {
  const { last7Leads, last30Leads } = rollupTrailingKpis(
    (payload as { daily?: unknown }).daily ?? null,
  );
  return { ...payload, last7Leads, last30Leads };
}
