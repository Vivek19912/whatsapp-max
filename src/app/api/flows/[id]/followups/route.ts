import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  classifyFollowup,
  deriveTomorrowWindow,
  isInTomorrow,
  localDayBounds,
  type DayWindow,
  type FollowupBucket,
} from "@/lib/followups/followup-view";
import { WORKSPACE_FOLLOWUP_SOURCE_KIND } from "@/lib/followups/workspace-link";
import { isAssigneeField } from "@/lib/flows/workspace-assignee";
import { standardContactFromAnswers } from "@/lib/meta-lead-ads/normalize";

type Row = Record<string, unknown>;

const VALID_BUCKETS = ["all", "pending", "overdue", "today", "tomorrow", "upcoming", "completed"] as const;
type BucketParam = (typeof VALID_BUCKETS)[number];

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function parseInstant(value: string | null): number {
  if (!value) return NaN;
  const t = new Date(value).getTime();
  return t;
}

async function selectInBatches<T>(
  db: SupabaseClient,
  table: string,
  columns: string,
  col: string,
  ids: string[],
): Promise<T[]> {
  const out: T[] = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const qb = db.from(table).select(columns).in(col, ids.slice(i, i + CHUNK));
    const { data, error } = (await qb) as unknown as { data: T[] | null; error: unknown };
    if (error) throw error;
    out.push(...(data ?? []));
  }
  return out;
}

/**
 * GET /api/flows/[id]/followups — Workspace Follow-ups view data.
 *
 * Table-scoped, server-filtered list of Workspace-linked follow-up
 * rows (`source_kind='meta_workspace_followup'`) for one flow, plus
 * bucket counts. Any member may read (same rule as GET /api/followups);
 * completion/reopen stay behind their own authorized endpoints.
 *
 * Query params:
 *   bucket=all|pending|overdue|today|upcoming|completed (default all)
 *   assignee=<user_id>|unassigned|all (default all)
 *   q=<lead name/phone substring>
 *   from=<ISO> to=<ISO> (scheduled_for range)
 *   todayStart=<ISO> todayEnd=<ISO> (viewer-local day bounds; the
 *     scheduling UI's timezone convention — UTC day when omitted)
 *   page=<n> pageSize=<n> (default 0/20, max 100)
 *
 * Completion is NEVER derived: `completed` means
 * followup_completed_at IS NOT NULL. A sent reminder with NULL
 * completion metadata stays actionable.
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
    if (!flow) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const url = new URL(request.url);
    const bucket = (url.searchParams.get("bucket") ?? "all") as BucketParam;
    if (!VALID_BUCKETS.includes(bucket)) {
      return NextResponse.json({ error: "Invalid bucket." }, { status: 400 });
    }
    const assignee = url.searchParams.get("assignee") ?? "all";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const from = parseInstant(url.searchParams.get("from"));
    const to = parseInstant(url.searchParams.get("to"));
    const page = parsePositiveInt(url.searchParams.get("page"), 0, 10000);
    const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 20, 100);

    let todayStart = url.searchParams.get("todayStart");
    let todayEnd = url.searchParams.get("todayEnd");
    if (!todayStart || !todayEnd || Number.isNaN(parseInstant(todayStart)) || Number.isNaN(parseInstant(todayEnd))) {
      const fallback = localDayBounds(new Date());
      todayStart = fallback.start;
      todayEnd = fallback.end;
    }
    const window = { start: todayStart, end: todayEnd };
    // Tomorrow uses the same viewer-local convention: explicit
    // bounds when the client sends them, otherwise the 24h right
    // after today ends.
    let tomorrow: DayWindow = deriveTomorrowWindow(window);
    const tomorrowStart = url.searchParams.get("tomorrowStart");
    const tomorrowEnd = url.searchParams.get("tomorrowEnd");
    if (
      tomorrowStart &&
      tomorrowEnd &&
      !Number.isNaN(parseInstant(tomorrowStart)) &&
      !Number.isNaN(parseInstant(tomorrowEnd))
    ) {
      tomorrow = { start: tomorrowStart, end: tomorrowEnd };
    }

    // Candidate runs of this table (ids only).
    const { data: runRows, error: runsErr } = await supabase
      .from("flow_runs")
      .select("id")
      .eq("account_id", accountId)
      .eq("flow_id", flowId);
    if (runsErr) throw runsErr;
    const runIds = ((runRows ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (runIds.length === 0) {
      return NextResponse.json({
        items: [],
        counts: { all: 0, pending: 0, overdue: 0, today: 0, tomorrow: 0, upcoming: 0, completed: 0 },
        page,
        pageSize,
        total: 0,
      });
    }

    // Linked follow-ups (any delivery status; completion is separate).
    const { data: fuRows, error: fuErr } = await supabase
      .from("whatsapp_followups")
      .select("*")
      .eq("account_id", accountId)
      .eq("source_kind", WORKSPACE_FOLLOWUP_SOURCE_KIND)
      .in("source_run_id", runIds);
    if (fuErr) throw fuErr;
    let followups = ((fuRows ?? []) as Row[]).filter(
      (r) => typeof r.source_run_id === "string",
    );

    // Batch context (never N+1): runs, contacts, conversations,
    // assignee cell, member names.
    const involvedRunIds = [...new Set(followups.map((r) => r.source_run_id as string))];
    const runs = await selectInBatches<Row>(supabase, "flow_runs", "id, contact_id, vars", "id", involvedRunIds);
    const runById = new Map(runs.map((r) => [r.id as string, r]));

    const contactIds = [...new Set(runs.map((r) => r.contact_id).filter((v): v is string => typeof v === "string" && v !== ""))];
    const contacts = contactIds.length > 0
      ? await selectInBatches<Row>(supabase, "contacts", "id, name, phone", "id", contactIds)
      : [];
    const contactById = new Map(contacts.map((c) => [c.id as string, c]));
    const convs = contactIds.length > 0
      ? await selectInBatches<Row>(supabase, "conversations", "id, contact_id", "contact_id", contactIds)
      : [];
    const convByContact = new Map(convs.map((c) => [c.contact_id as string, c.id as string]));

    const { data: fields } = await supabase
      .from("workspace_fields")
      .select("id, name, field_type")
      .eq("account_id", accountId)
      .eq("flow_id", flowId);
    const assigneeField = ((fields ?? []) as Row[]).find((f) =>
      isAssigneeField({ name: String(f.name ?? "") }),
    );
    const assigneeByRun = new Map<string, string | null>();
    if (assigneeField) {
      const { data: values } = await supabase
        .from("workspace_values")
        .select("flow_run_id, value_text")
        .eq("account_id", accountId)
        .eq("field_id", assigneeField.id as string)
        .in("flow_run_id", involvedRunIds);
      for (const v of ((values ?? []) as Row[])) {
        assigneeByRun.set(v.flow_run_id as string, (v.value_text as string | null) ?? null);
      }
    }

    const rosterIds = [...new Set([...assigneeByRun.values()].filter(
      (v): v is string => typeof v === "string" && v !== "" && v !== "Unassigned",
    ))];
    let nameByUser = new Map<string, string>();
    if (rosterIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("account_id", accountId)
        .in("user_id", rosterIds);
      nameByUser = new Map(
        ((profiles ?? []) as Row[]).map((p) => [p.user_id as string, (p.full_name as string) ?? (p.user_id as string)]),
      );
    }

    const toAssignee = (runId: string) => {
      const stored = assigneeByRun.get(runId) ?? null;
      if (!stored || stored === "Unassigned") return null;
      return { userId: stored, display: nameByUser.get(stored) ?? stored };
    };
    const toLead = (runId: string) => {
      const run = runById.get(runId);
      const contactId = (run?.contact_id as string | null) ?? null;
      const contact = contactId ? contactById.get(contactId) : undefined;
      let name = (contact?.name as string | null) ?? null;
      let phone = (contact?.phone as string | null) ?? null;
      if (!name || !phone) {
        const fallback = standardContactFromAnswers(
          (run?.vars as Record<string, string | null | undefined> | null) ?? null,
        );
        if (!name) name = fallback.name;
        if (!phone) phone = fallback.phone;
      }
      return {
        runId,
        name,
        phone,
        contactId,
        conversationId: contactId ? (convByContact.get(contactId) ?? null) : null,
      };
    };

    // Filters (server-side): date range, assignee, text search.
    if (!Number.isNaN(from)) {
      followups = followups.filter((r) => new Date(r.scheduled_for as string).getTime() >= from);
    }
    if (!Number.isNaN(to)) {
      followups = followups.filter((r) => new Date(r.scheduled_for as string).getTime() <= to);
    }
    if (assignee !== "all") {
      followups = followups.filter((r) => {
        const a = toAssignee(r.source_run_id as string);
        return assignee === "unassigned" ? a === null : a?.userId === assignee;
      });
    }
    if (q !== "") {
      followups = followups.filter((r) => {
        const lead = toLead(r.source_run_id as string);
        return (
          (lead.name ?? "").toLowerCase().includes(q) ||
          (lead.phone ?? "").toLowerCase().includes(q)
        );
      });
    }

    // Counts over the filtered set (before bucket slicing).
    // Tomorrow is a subset of Upcoming: completed rows and the
    // Upcoming total are unaffected by it.
    const counts = { all: 0, pending: 0, overdue: 0, today: 0, tomorrow: 0, upcoming: 0, completed: 0 };
    const withBucket = followups.map((r) => ({
      row: r,
      bucket: classifyFollowup(
        {
          scheduled_for: r.scheduled_for as string,
          followup_completed_at: (r.followup_completed_at as string | null) ?? null,
        },
        window,
      ) as FollowupBucket,
    }));
    for (const { bucket: b, row } of withBucket) {
      counts.all += 1;
      if (b === "completed") {
        counts.completed += 1;
      } else {
        counts.pending += 1;
        counts[b] += 1;
        if (
          isInTomorrow(
            {
              scheduled_for: row.scheduled_for as string,
              followup_completed_at: (row.followup_completed_at as string | null) ?? null,
            },
            tomorrow,
          )
        ) {
          counts.tomorrow += 1;
        }
      }
    }

    // Bucket slice + actionable ordering.
    const rank: Record<FollowupBucket | "pending", number> = {
      overdue: 0,
      today: 1,
      upcoming: 2,
      completed: 3,
      pending: -1,
    };
    let visible = withBucket;
    if (bucket === "pending") {
      visible = withBucket.filter(({ bucket: b }) => b !== "completed");
    } else if (bucket === "tomorrow") {
      visible = withBucket.filter(({ bucket: b, row }) => {
        if (b === "completed") return false;
        return isInTomorrow(
          {
            scheduled_for: row.scheduled_for as string,
            followup_completed_at: (row.followup_completed_at as string | null) ?? null,
          },
          tomorrow,
        );
      });
    } else if (bucket !== "all") {
      visible = withBucket.filter(({ bucket: b }) => b === bucket);
    }
    visible.sort((x, y) => {
      const rx = bucket === "all" || bucket === "pending" ? rank[x.bucket] : 0;
      const ry = bucket === "all" || bucket === "pending" ? rank[y.bucket] : 0;
      if (rx !== ry) return rx - ry;
      if (x.bucket === "completed" && y.bucket === "completed") {
        return (
          new Date(y.row.followup_completed_at as string).getTime() -
          new Date(x.row.followup_completed_at as string).getTime()
        );
      }
      return (
        new Date(x.row.scheduled_for as string).getTime() -
        new Date(y.row.scheduled_for as string).getTime()
      );
    });

    const total = visible.length;
    const pageItems = visible.slice(page * pageSize, page * pageSize + pageSize);
    const items = pageItems.map(({ row: r, bucket: b }) => ({
      id: r.id,
      status: r.status,
      scheduled_for: r.scheduled_for,
      message_text: r.message_text,
      template_name: (r.template_name as string | null) ?? null,
      followup_completed_at: (r.followup_completed_at as string | null) ?? null,
      followup_completed_by: (r.followup_completed_by as string | null) ?? null,
      sent_at: (r.sent_at as string | null) ?? null,
      failed_at: (r.failed_at as string | null) ?? null,
      cancelled_at: (r.cancelled_at as string | null) ?? null,
      failure_reason: (r.failure_reason as string | null) ?? null,
      bucket: b,
      lead: toLead(r.source_run_id as string),
      assignee: toAssignee(r.source_run_id as string),
    }));

    // Distinct assignees present (for the filter control).
    const assignees = [...new Map(
      withBucket.map(({ row: r }) => {
        const a = toAssignee(r.source_run_id as string);
        return [a ? a.userId : "__unassigned__", a] as const;
      }),
    ).values()].filter(Boolean) as Array<{ userId: string; display: string } | null>;

    return NextResponse.json({ items, counts, page, pageSize, total, assignees });
  } catch (err) {
    return toErrorResponse(err);
  }
}
