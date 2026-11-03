/**
 * Flow association for the Inbox contact panel.
 *
 * The panel shows the name of the flow associated with the selected
 * contact. There is no dedicated association column — the product links
 * contacts to flows through `flow_runs` (see `supabase/migrations/
 * 010_flows.sql`), with `flows.name` joined at read time, exactly like
 * the engine (`loadActiveRunForContact`), sheets sync and email queue do.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Minimal shape of a flow_run row joined with its flow's id + name.
 * Supabase may return `flow` as object or single-element array depending on
 * PostgREST inference; handle both. `kind` is present when the caller
 * selects it (flows.kind: 'whatsapp_flow' | 'meta_lead_ads').
 */
export interface ContactFlowRun {
  id: string;
  status: string;
  started_at: string;
  flow:
    | { id: string; name: string; kind?: string | null }
    | { id: string; name: string; kind?: string | null }[]
    | null;
}

/**
 * Pick the flow run to display/filter by for a contact from its recent
 * flow runs.
 *
 * Selection rule (mirrors engine semantics — a new run can only start
 * when no run is active, so the newest run IS the active one when one
 * exists):
 *
 * 1. If any run is `active`, show the newest active run's flow.
 *    (At most one active run per contact can exist — partial unique
 *    index `idx_one_active_run_per_contact`.)
 * 2. Otherwise show the most recent run of any terminal status — the
 *    flow the contact last went through.
 *
 * Runs whose embedded flow is missing (e.g. blocked by RLS) are skipped.
 * Returns null when there is nothing to show ("No flow" empty state).
 */
export function pickContactFlowRun(
  runs: ContactFlowRun[],
): ContactFlowRun | null {
  const getFlowName = (run: ContactFlowRun): string | undefined => {
    const f = run.flow;
    if (!f) return undefined;
    if (Array.isArray(f)) return f[0]?.name;
    return f.name;
  };
  const withFlow = runs.filter((run) => getFlowName(run));
  if (withFlow.length === 0) return null;

  const newest = (a: ContactFlowRun, b: ContactFlowRun) =>
    a.started_at >= b.started_at ? a : b;

  const active = withFlow.filter((run) => run.status === "active");
  return active.length > 0 ? active.reduce(newest) : withFlow.reduce(newest);
}

/** Flow name variant of {@link pickContactFlowRun} for display. */
export function pickContactFlow(runs: ContactFlowRun[]): string | null {
  const run = pickContactFlowRun(runs);
  if (!run?.flow) return null;
  const f = run.flow;
  if (Array.isArray(f)) return f[0]?.name ?? null;
  return f.name ?? null;
}

/**
 * Whether the picked run represents a genuine Meta Instant Form
 * submission. Virtual Meta flows carry kind = 'meta_lead_ads'
 * (migration 119) and are created only by the Lead Ads ingestion
 * (`process-lead.ts` → `ensureVirtualFlow`), so the kind marker on
 * the DISPLAYED run is the authoritative signal — no extra query,
 * no name-prefix guessing. Regular Flow Tables keep kind
 * 'whatsapp_flow' (or an absent kind on older selects) and are
 * never relabeled.
 */
export function isMetaLeadFlowRun(run: ContactFlowRun | null): boolean {
  const f = run?.flow;
  if (!f) return false;
  const kind = Array.isArray(f) ? f[0]?.kind : f.kind;
  return kind === "meta_lead_ads";
}

/**
 * Query for the contact's recent flow runs with the flow name embedded.
 * One bounded query — no per-message round-trips. Account-scoped both
 * by the explicit `account_id` filter and by RLS (`is_account_member`),
 * so a contact from Account A can never surface Account B's flows.
 */
export function contactFlowRunsQuery(
  supabase: SupabaseClient,
  accountId: string | null | undefined,
  contactId: string
) {
  let query = supabase
    .from("flow_runs")
    .select("id, status, started_at, flow:flows(id, name, kind)")
    .eq("contact_id", contactId)
    .order("started_at", { ascending: false })
    .limit(5);

  if (accountId) {
    query = query.eq("account_id", accountId);
  }

  return query;
}
