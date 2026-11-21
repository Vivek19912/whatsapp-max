// GET /api/integrations/meta-crm/events
//
// Owner/admin-visible CRM event history for this workspace
// (account-scoped, newest first). Read-only monitoring: never
// returns tokens. Enriches rows with lead + table display names
// (batched, never N+1).
//
// This is a NEW, independent integration. It does NOT inspect,
// reuse, or depend on the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { CRM_EVENT_NAMES, isCrmEventName } from "@/lib/meta-crm/lead-quality";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const STATUSES = ["pending", "sent", "failed", "skipped"] as const;
type EventStatus = (typeof STATUSES)[number];
function isStatus(v: unknown): v is EventStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const statusRaw = (url.searchParams.get("status") ?? "").trim() || null;
    const eventRaw = (url.searchParams.get("event_name") ?? "").trim() || null;
    if (statusRaw && !isStatus(statusRaw)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    if (eventRaw && !isCrmEventName(eventRaw)) {
      return NextResponse.json({ error: "Invalid event_name." }, { status: 400 });
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(Math.floor(limitRaw), MAX_LIMIT));

    let query = ctx.supabase
      .from("meta_crm_events")
      .select(
        "id, flow_id, flow_run_id, meta_lead_id, event_name, from_quality, to_quality, event_time, event_uuid, dataset_id, status, attempts, max_attempts, last_error, next_retry_at, sent_at, created_at",
      )
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (statusRaw) query = query.eq("status", statusRaw);
    if (eventRaw) query = query.eq("event_name", eventRaw);
    const { data, error } = await query;
    if (error) {
      // Migration 175 not applied yet → honest empty state, not a lie.
      if ((error as { code?: string }).code === "42P01") {
        return NextResponse.json({
          ok: true,
          events: [],
          counts: { pending: 0, sent: 0, failed: 0, skipped: 0 },
          migrationMissing: true,
        });
      }
      throw error;
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    // Batched enrichment (never N+1): runs → contacts + flows.
    const runIds = [...new Set(rows.map((r) => r.flow_run_id).filter((v): v is string => typeof v === "string" && v !== ""))];
    const flowIds = [...new Set(rows.map((r) => r.flow_id).filter((v): v is string => typeof v === "string" && v !== ""))];
    const contactByRun = new Map<string, string | null>();
    const contactIds: string[] = [];
    if (runIds.length > 0) {
      const { data: runRows } = await ctx.supabase
        .from("flow_runs")
        .select("id, contact_id")
        .eq("account_id", ctx.accountId)
        .in("id", runIds.slice(0, 200));
      for (const r of ((runRows ?? []) as Array<{ id: string; contact_id: string | null }>)) {
        contactByRun.set(r.id, r.contact_id);
        if (r.contact_id) contactIds.push(r.contact_id);
      }
    }
    const nameByContact = new Map<string, string>();
    if (contactIds.length > 0) {
      const { data: cRows } = await ctx.supabase
        .from("contacts")
        .select("id, name")
        .eq("account_id", ctx.accountId)
        .in("id", [...new Set(contactIds)].slice(0, 200));
      for (const c of ((cRows ?? []) as Array<{ id: string; name: string | null }>)) {
        if (c.name?.trim()) nameByContact.set(c.id, c.name.trim());
      }
    }
    const nameByFlow = new Map<string, string>();
    if (flowIds.length > 0) {
      const { data: fRows } = await ctx.supabase
        .from("flows")
        .select("id, name")
        .eq("account_id", ctx.accountId)
        .in("id", flowIds.slice(0, 200));
      for (const f of ((fRows ?? []) as Array<{ id: string; name: string | null }>)) {
        nameByFlow.set(f.id, f.name?.trim() || "Untitled Table");
      }
    }

    const events = rows.map((r) => {
      const runId = typeof r.flow_run_id === "string" ? r.flow_run_id : null;
      const flowId = typeof r.flow_id === "string" ? r.flow_id : null;
      const contactId = runId ? (contactByRun.get(runId) ?? null) : null;
      return {
        id: r.id,
        eventName: r.event_name,
        fromQuality: r.from_quality,
        toQuality: r.to_quality,
        eventTime: r.event_time,
        datasetId: r.dataset_id,
        status: r.status,
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
        lastError: r.last_error ?? null,
        nextRetryAt: r.next_retry_at,
        sentAt: r.sent_at ?? null,
        createdAt: r.created_at,
        leadName: contactId ? (nameByContact.get(contactId) ?? null) : null,
        tableName: flowId ? (nameByFlow.get(flowId) ?? null) : null,
      };
    });

    // Status counts for the monitoring header (bounded single query).
    const { data: countRows } = await ctx.supabase
      .from("meta_crm_events")
      .select("status")
      .eq("account_id", ctx.accountId)
      .limit(1000);
    const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const c of ((countRows ?? []) as Array<{ status: string }>)) {
      if (c.status in counts) counts[c.status as keyof typeof counts] += 1;
    }

    return NextResponse.json({
      ok: true,
      events,
      counts,
      eventNames: [...CRM_EVENT_NAMES],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
