import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isWorkspaceFollowupFieldName } from "@/lib/followups/workspace-link";

type Row = Record<string, unknown>;

function parseInstant(value: string | null): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

/**
 * Read one table's run ids in chunks (ids only — never full rows).
 */
async function runIdsForFlow(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: unknown }>)
    .map((r) => r.id)
    .filter((v): v is string => typeof v === "string" && v !== "");
}

async function followupFieldId(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("workspace_fields")
    .select("id, name, field_type")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (error) throw error;
  const field = ((data ?? []) as Row[]).find(
    (f) => f.field_type === "datetime" && isWorkspaceFollowupFieldName(f.name as string),
  );
  return typeof field?.id === "string" ? (field.id as string) : null;
}

/**
 * GET /api/flows/[id]/followup-counts — read-only KPI aggregates for
 * the Workspace Leads page. Counts DISTINCT leads whose
 * `Next Follow-up Date & Time` cell falls in each viewer-local day
 * bucket. Standalone `/followups` reminders live in a different
 * table and are never read here; delivery status is never
 * consulted (a sent reminder does not clear a scheduled follow-up).
 *
 * Query: todayStart, todayEnd, tomorrowStart, tomorrowEnd (UTC ISO
 * instants computed from the viewer's local calendar, same
 * convention as the scheduling UI). Missing/invalid bounds fall
 * back to the server UTC day.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id: flowId } = await params;

    const { data: flow, error: flowErr } = await supabase
      .from("flows")
      .select("id, account_id")
      .eq("id", flowId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (flowErr) throw flowErr;
    if (!flow) return NextResponse.json({ error: "Not found." }, { status: 404 });

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

    const fieldId = await followupFieldId(supabase, accountId, flowId);
    if (!fieldId) {
      return NextResponse.json({ overdue: 0, today: 0, tomorrow: 0, upcoming: 0 });
    }

    const runIds = await runIdsForFlow(supabase, accountId, flowId);
    if (runIds.length === 0) {
      return NextResponse.json({ overdue: 0, today: 0, tomorrow: 0, upcoming: 0 });
    }

    // One value per lead: dedupe by run (the column is unique per
    // run, but never trust a count to duplicates).
    const byRun = new Map<string, number>();
    const CHUNK = 500;
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("workspace_values")
        .select("flow_run_id, value_text")
        .eq("account_id", accountId)
        .eq("field_id", fieldId)
        .in("flow_run_id", runIds.slice(i, i + CHUNK));
      if (error) throw error;
      for (const row of ((data ?? []) as Row[])) {
        const runId = row.flow_run_id;
        const raw = row.value_text;
        if (typeof runId !== "string" || typeof raw !== "string" || raw.trim() === "") {
          continue;
        }
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
