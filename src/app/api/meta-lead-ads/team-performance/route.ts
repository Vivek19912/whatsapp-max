// ============================================================
// GET /api/meta-lead-ads/team-performance — Team Member Lead
// Performance for the Meta Lead Ads dashboard.
//
// One server-side aggregation per section state (filters +
// optional View Leads page): team-member totals with Stage/Type
// splits, the Unassigned bucket, summary reconciliation, the
// available-form list, and — only when a member (or Unassigned)
// is selected — a paginated lead list. Computed inside Postgres
// via get_meta_leads_team_performance() (see supabase/migrations/
// 156_meta_leads_team_performance.sql). Sources are
// meta_lead_submissions (+ Workspace values for assignment/Stage/
// Type + contacts for lead names/phones). Messages, flow_runs as
// a lead source, and call tables are never consulted.
//
// Security: RLS-scoped SSR client (caller's JWT) and a SECURITY
// INVOKER RPC that derives the account from auth.uid() — no
// account_id param, no service role, no cross-workspace reads.
//
// Query params (all optional except tz default):
//   formId  — Meta form_id, or absent for All Forms
//   from/to — YYYY-MM-DD calendar bounds in tz (both or neither)
//   tz      — IANA timezone for day bucketing (default UTC)
//   member  — user_id | "unassigned" (View Leads selection; absent
//             = aggregates only, no lead rows)
//   stage   — exact Stage value | "__none__" for missing | absent
//   type    — exact Type value | "__none__" for missing | absent
//   search  — lead name/phone substring (detail only)
//   page, pageSize — 1-based pagination (detail only, max 100/req)
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 100;

/** Strict YYYY-MM-DD calendar day; null when absent or invalid. */
function parseDayKey(value: string | null): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, mo, d] = value.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null;
  }
  return value;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return NaN;
  return n;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const url = new URL(request.url);
    const formId = (url.searchParams.get("formId") ?? "").trim() || null;
    const fromRaw = parseDayKey(url.searchParams.get("from"));
    const toRaw = parseDayKey(url.searchParams.get("to"));
    if (
      (url.searchParams.get("from") !== null || url.searchParams.get("to") !== null) &&
      (!fromRaw || !toRaw)
    ) {
      return NextResponse.json(
        { error: "from and to must both be valid YYYY-MM-DD dates" },
        { status: 400 },
      );
    }
    if (fromRaw && toRaw && Date.parse(toRaw) < Date.parse(fromRaw)) {
      return NextResponse.json(
        { error: "to must be on/after from" },
        { status: 400 },
      );
    }
    const tz = (url.searchParams.get("tz") || "UTC").slice(0, 64);

    const member = (url.searchParams.get("member") ?? "").trim() || null;
    const stage = url.searchParams.get("stage");
    const type = url.searchParams.get("type");
    const search = (url.searchParams.get("search") ?? "").trim() || null;
    const page = parsePositiveInt(url.searchParams.get("page"), 1);
    const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 25);
    if (!Number.isInteger(page) || !Number.isInteger(pageSize) || pageSize > MAX_PAGE_SIZE) {
      return NextResponse.json(
        { error: "page and pageSize must be positive integers (pageSize ≤ 100)" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase.rpc("get_meta_leads_team_performance", {
      p_form_id: formId,
      p_from: fromRaw,
      p_to: toRaw,
      p_tz: tz,
      p_member: member,
      p_stage: stage,
      p_type: type,
      p_search: search,
      p_page: page,
      p_page_size: pageSize,
    });

    if (error) {
      console.error("[meta-leads/team-performance] rpc error:", error);
      return NextResponse.json(
        { error: "Failed to load team lead performance" },
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
