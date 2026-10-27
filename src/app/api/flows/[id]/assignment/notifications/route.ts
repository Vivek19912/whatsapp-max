import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getTableConfig } from "@/lib/lead-assignment/table-config";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/flows/[id]/assignment/notifications — recent assignee
 * alert deliveries for this table (email + WhatsApp outbox rows
 * with per-row status, attempts, and the last error). Owner-only:
 * rows carry private recipient addresses.
 *
 * Pure read — polling never restarts work or resends anything.
 */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const ctx = await requireRole("owner");
    const detail = await getTableConfig(ctx.supabase, ctx.accountId, id);
    if (!detail) {
      return NextResponse.json({ notifications: [] });
    }
    const limitParam = new URL(request.url).searchParams.get("limit");
    const limit = Math.max(1, Math.min(Number(limitParam) || 50, 200));
    const { data, error } = await ctx.supabase
      .from("lead_assignment_notifications")
      .select(
        "id, channel, to_email, to_phone, subject, status, attempt, max_attempts, last_error, sent_at, failed_at, created_at, flow_run_id, assignee_id",
      )
      .eq("account_id", ctx.accountId)
      .eq("config_id", detail.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    const merged: Array<Record<string, unknown>> = [
      ...((data ?? []) as Array<Record<string, unknown>>),
    ];
    // Meta tables only: the legacy new-lead email outbox
    // (meta_lead_notifications) predates the per-table outbox and
    // is still the sender when the account-level email setting is
    // on. Those attempts are backend history too — surface them
    // here (same shape, never invented) so Recent alert deliveries
    // cannot hide a sent email. Scoped to this table's runs.
    if (detail.form_db_id) {
      try {
        const { data: legacyPage, error: legacyErr } = await ctx.supabase
          .from("meta_lead_notifications")
          .select(
            "id, recipient_email, status, attempt, max_attempts, last_error, sent_at, failed_at, created_at, flow_run_id",
          )
          .eq("account_id", ctx.accountId)
          .order("created_at", { ascending: false })
          .limit(200);
        if (legacyErr) throw legacyErr;
        const legacyRows = (legacyPage ?? []) as Array<Record<string, unknown>>;
        const runIds = [
          ...new Set(
            legacyRows
              .map((r) => r.flow_run_id)
              .filter((v): v is string => typeof v === "string" && v !== ""),
          ),
        ];
        let runFlow = new Map<string, string>();
        if (runIds.length > 0) {
          const { data: runs, error: runsErr } = await ctx.supabase
            .from("flow_runs")
            .select("id, flow_id")
            .eq("account_id", ctx.accountId)
            .in("id", runIds);
          if (runsErr) throw runsErr;
          runFlow = new Map(
            ((runs ?? []) as Array<{ id: string; flow_id: string }>).map((r) => [
              r.id,
              r.flow_id,
            ]),
          );
        }
        for (const r of legacyRows) {
          if (runFlow.get(r.flow_run_id as string) !== detail.flow_id) continue;
          merged.push({
            id: r.id,
            channel: "email",
            to_email: r.recipient_email,
            to_phone: null,
            subject: null,
            status: r.status,
            attempt: r.attempt,
            max_attempts: r.max_attempts,
            last_error: r.last_error,
            sent_at: r.sent_at,
            failed_at: r.failed_at,
            created_at: r.created_at,
            flow_run_id: r.flow_run_id,
            assignee_id: null,
          });
        }
        merged.sort((a, b) =>
          String(b.created_at ?? "") < String(a.created_at ?? "") ? -1 : 1,
        );
      } catch {
        // Best-effort only: the per-table rows above are the source
        // of truth and must still render when the legacy lookup
        // fails (e.g. RLS) — never fail the panel for history.
      }
    }
    return NextResponse.json({ notifications: merged.slice(0, limit) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
