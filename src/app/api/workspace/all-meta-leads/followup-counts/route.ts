import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isWorkspaceFollowupFieldName } from "@/lib/followups/workspace-link";
import { isAssigneeField } from "@/lib/flows/workspace-assignee";

type Row = Record<string, unknown>;

function parseInstant(value: string | null): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

/**
 * GET /api/workspace/all-meta-leads/followup-counts — read-only KPI
 * aggregates for the All Meta Leads combined view.
 *
 * Counts DISTINCT leads (by flow_run_id, one row per lead) whose
 * `Next Follow-up Date & Time` cell falls in each viewer-local day
 * bucket, summed across EVERY Meta Lead Ads table in the account
 * (hidden + disabled included — same lead set as the combined
 * table). Standalone `/followups` reminders live in a different
 * table and are never read here; delivery status is never
 * consulted (a sent reminder does not clear a scheduled follow-up).
 *
 * Query: todayStart, todayEnd, tomorrowStart, tomorrowEnd (UTC ISO
 * instants computed from the viewer's local calendar, same
 * convention as the scheduling UI and the per-table counts
 * endpoint). Missing/invalid bounds fall back to the server UTC day.
 *
 * Batched, never N+1: one flows query, one fields query, one
 * assignee-values query (restricted agents only), one follow-up
 * values query in chunks — a constant number of round trips no
 * matter how many leads or tables the account holds.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();

    const url = new URL(request.url);
    const q = (k: string) => url.searchParams.get(k);
    let todayStart = parseInstant(q("todayStart"));
    let todayEnd = parseInstant(q("todayEnd"));
    let tomorrowStart = parseInstant(q("tomorrowStart"));
    let tomorrowEnd = parseInstant(q("tomorrowEnd"));
    if ([todayStart, todayEnd, tomorrowStart, tomorrowEnd].some((t) => Number.isNaN(t))) {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
      const tStart = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const tEnd = new Date(tStart.getTime() + 24 * 60 * 60 * 1000 - 1);
      todayStart = start.getTime();
      todayEnd = end.getTime();
      tomorrowStart = tStart.getTime();
      tomorrowEnd = tEnd.getTime();
    }

    // Every Meta Lead Ads virtual flow for the account (hidden +
    // disabled included — the same lead set as the combined table).
    const { data: flowsData, error: flowsErr } = await supabase
      .from("flows")
      .select("id")
      .eq("account_id", accountId)
      .eq("kind", "meta_lead_ads");
    if (flowsErr) throw flowsErr;
    const flowIds = ((flowsData ?? []) as Array<{ id: unknown }>)
      .map((f) => f.id)
      .filter((v): v is string => typeof v === "string" && v !== "");
    if (flowIds.length === 0) {
      return NextResponse.json({ overdue: 0, today: 0, tomorrow: 0, upcoming: 0 });
    }

    // Follow-up + assignee field ids per flow (one batched read for
    // every table — never per-flow round trips in a loop).
    const { data: fieldsData, error: fieldsErr } = await supabase
      .from("workspace_fields")
      .select("id, flow_id, name, field_type")
      .eq("account_id", accountId)
      .in("flow_id", flowIds);
    if (fieldsErr) throw fieldsErr;
    const followupFieldByFlow = new Map<string, string>();
    const assigneeFieldByFlow = new Map<string, string>();
    for (const f of ((fieldsData ?? []) as Row[])) {
      if (typeof f.id !== "string" || typeof f.flow_id !== "string") continue;
      if (f.field_type === "datetime" && isWorkspaceFollowupFieldName(f.name)) {
        if (!followupFieldByFlow.has(f.flow_id)) {
          followupFieldByFlow.set(f.flow_id, f.id);
        }
      }
      if (isAssigneeField({ name: (f.name as string) ?? "" })) {
        if (!assigneeFieldByFlow.has(f.flow_id)) {
          assigneeFieldByFlow.set(f.flow_id, f.id);
        }
      }
    }
    const followupFieldIds = [...followupFieldByFlow.values()];
    if (followupFieldIds.length === 0) {
      return NextResponse.json({ overdue: 0, today: 0, tomorrow: 0, upcoming: 0 });
    }

    // Agent isolation (same rule as the combined table route):
    // agents WITHOUT View All Conversations count only their OWN
    // assigned leads. The assignment id is derived server-side from
    // the session — never a client-supplied value.
    let assigneeByRun: Map<string, true> | null = null;
    if (role === "agent") {
      const { resolveWorkspaceVisibility } = await import(
        "@/lib/inbox/assignment-access"
      );
      const { restricted } = await resolveWorkspaceVisibility(
        supabase,
        accountId,
        userId,
        role,
      );
      if (restricted) {
        const assigneeIds = [...assigneeFieldByFlow.values()];
        assigneeByRun = new Map();
        if (assigneeIds.length > 0) {
          const OWNED_CHUNK = 500;
          for (let i = 0; i < assigneeIds.length; i += OWNED_CHUNK) {
            const { data, error } = await supabase
              .from("workspace_values")
              .select("flow_run_id")
              .eq("account_id", accountId)
              .in("field_id", assigneeIds.slice(i, i + OWNED_CHUNK))
              .eq("value_text", userId);
            if (error) throw error;
            for (const row of ((data ?? []) as Row[])) {
              if (typeof row.flow_run_id === "string") {
                assigneeByRun.set(row.flow_run_id, true);
              }
            }
          }
        }
      }
    }

    // One value per lead: dedupe by run (the column is unique per
    // run, but never trust a count to duplicates). Values are read
    // in chunks across all follow-up fields at once.
    const byRun = new Map<string, number>();
    const CHUNK = 500;
    for (let i = 0; i < followupFieldIds.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("workspace_values")
        .select("flow_run_id, value_text")
        .eq("account_id", accountId)
        .in("field_id", followupFieldIds.slice(i, i + CHUNK));
      if (error) throw error;
      for (const row of ((data ?? []) as Row[])) {
        const runId = row.flow_run_id;
        const raw = row.value_text;
        if (typeof runId !== "string" || typeof raw !== "string" || raw.trim() === "") {
          continue;
        }
        if (assigneeByRun !== null && !assigneeByRun.has(runId)) continue;
        const at = new Date(raw).getTime();
        if (Number.isNaN(at)) continue;
        byRun.set(runId, at);
      }
    }

    let overdue = 0;
    let today = 0;
    let tomorrow = 0;
    let upcoming = 0;
    for (const at of byRun.values()) {
      if (at < todayStart) {
        overdue += 1;
      } else if (at <= todayEnd) {
        today += 1;
      } else {
        upcoming += 1;
        if (at >= tomorrowStart && at <= tomorrowEnd) tomorrow += 1;
      }
    }
    return NextResponse.json({ overdue, today, tomorrow, upcoming });
  } catch (err) {
    return toErrorResponse(err);
  }
}
