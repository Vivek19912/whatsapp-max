// GET /api/integrations/meta-crm/lead-events?flow_id=&run_id=
//
// Per-lead CRM event delivery states (powers the Lead Quality
// dropdown badges). Read-only: returns the latest ledger row per
// event name for this lead — Sent only after Meta confirms
// delivery, Queued while pending, Failed/Skipped as recorded.
// Never fabricates, never sends, never touches Meta.

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getCrmFeedbackConfig } from "@/lib/meta-crm/feedback";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const flowId = (url.searchParams.get("flow_id") ?? "").trim();
    const runId = (url.searchParams.get("run_id") ?? "").trim();
    if (!flowId || !runId) {
      return NextResponse.json(
        { error: "flow_id and run_id are required." },
        { status: 400 },
      );
    }

    // Tenant isolation, same rule as the preview/save paths: the run
    // must belong to this account and flow.
    const { data: run, error: runErr } = await ctx.supabase
      .from("flow_runs")
      .select("id")
      .eq("id", runId)
      .eq("account_id", ctx.accountId)
      .eq("flow_id", flowId)
      .maybeSingle();
    if (runErr) throw runErr;
    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }

    // Cross-table identity: badges reflect the same Meta lead in ANY
    // Workspace table, not just this run. Resolve the lead, then
    // scope to the configured dataset (independent datasets keep
    // independent badges; without a configured dataset there is no
    // target to compare against, so fall back to this run's rows).
    const { data: sub, error: subErr } = await ctx.supabase
      .from("meta_lead_submissions")
      .select("meta_lead_id")
      .eq("account_id", ctx.accountId)
      .eq("flow_run_id", runId)
      .maybeSingle();
    if (subErr) throw subErr;
    const metaLeadId =
      (sub as { meta_lead_id?: unknown } | null)?.meta_lead_id ?? null;
    const config = await getCrmFeedbackConfig(ctx.supabase, ctx.accountId).catch(() => null);
    const datasetId =
      config && typeof config.dataset_id === "string" && config.dataset_id !== ""
        ? config.dataset_id
        : null;

    let query = ctx.supabase
      .from("meta_crm_events")
      .select("event_name, status, sent_at, updated_at, created_at, meta_lead_id, dataset_id, flow_run_id")
      .eq("account_id", ctx.accountId);
    if (typeof metaLeadId === "string" && metaLeadId !== "") {
      query = query.eq("meta_lead_id", metaLeadId);
      if (datasetId !== null) query = query.eq("dataset_id", datasetId);
    } else {
      // No Meta submission for this run (non-Meta lead): no event
      // could ever exist for it — keep the run-scoped fallback.
      query = query.eq("flow_run_id", runId);
    }
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) {
      // Missing table (migration 175 not applied) → honest empty
      // state, never a bare 500.
      if ((error as { code?: string }).code === "42P01") {
        return NextResponse.json({ ok: true, events: [] });
      }
      throw error;
    }
    const seen = new Set<string>();
    const events: Array<{
      eventName: string;
      status: string;
      sentAt: string | null;
      updatedAt: string;
    }> = [];
    for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
      if (typeof r.event_name !== "string" || r.event_name === "") continue;
      if (seen.has(r.event_name)) continue;
      seen.add(r.event_name);
      events.push({
        eventName: r.event_name,
        status: typeof r.status === "string" ? r.status : "pending",
        sentAt: typeof r.sent_at === "string" ? r.sent_at : null,
        updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
      });
    }
    return NextResponse.json({ ok: true, events });
  } catch (err) {
    return toErrorResponse(err);
  }
}
