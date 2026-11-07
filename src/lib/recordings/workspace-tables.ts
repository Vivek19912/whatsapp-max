// ============================================================
// Workspace-table display-name join for call recordings.
//
// A recording links to a lead via `call_recordings.contact_id`.
// A lead belongs to a workspace table via its flow runs:
// `flow_runs.contact_id` → `flow_runs.flow_id` → `flows.name`
// (one contact may own several runs across tables; the most
// recent run's flow wins — the same recency rule as
// `latestByContact`, deterministic and display-only).
//
// Resolved here in TWO batched queries per caller — never N+1.
// Only the flow name crosses to the frontend; no other flow
// columns are selected. Account-scoped throughout, so another
// workspace's table names can never leak in.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Cap for one flow's contact-id prefetch behind the Workspace
 * Table filter. Keeps the `contact_id.in.(...)` list (and the
 * matching RPC array) inside safe URL lengths — the same
 * discipline as the search prefetch cap, only roomier.
 */
export const WORKSPACE_TABLE_CONTACT_LIMIT = 200;

/**
 * Map `contact_id` → workspace table (flow) name for the given
 * contacts. Contacts with no runs, runs whose flow is gone, or
 * flows with a blank name simply have no entry — the call site
 * renders '—'. Never throws (returns {} on failure — the UI
 * falls back to '—' rather than breaking the list).
 */
export async function workspaceTableNamesByContactId(
  supabase: SupabaseClient,
  accountId: string,
  contactIds: string[]
): Promise<Record<string, string>> {
  const unique = [...new Set(contactIds.filter(Boolean))];
  if (unique.length === 0 || !accountId) return {};
  try {
    const { data: runs, error: runsError } = await supabase
      .from('flow_runs')
      .select('contact_id, flow_id, started_at')
      .eq('account_id', accountId)
      .in('contact_id', unique)
      .order('started_at', { ascending: false });
    if (runsError || !runs) return {};
    // Most recent run per contact wins. Sorted client-side by
    // started_at DESC (unparseable → oldest) so the pick never
    // depends on transport ordering alone — the query already
    // orders, this just makes it deterministic.
    const sorted = [...(runs as Array<{
      contact_id: string | null;
      flow_id: string | null;
      started_at: string | null;
    }>)].sort((a, b) => {
      const ta = Date.parse(a.started_at ?? '');
      const tb = Date.parse(b.started_at ?? '');
      const na = Number.isFinite(ta) ? ta : -1;
      const nb = Number.isFinite(tb) ? tb : -1;
      return nb - na;
    });
    // Newest-first: first run seen per contact is its most recent
    // table membership.
    const flowIdByContact = new Map<string, string>();
    const flowIds: string[] = [];
    for (const r of sorted) {
      if (!r.contact_id || !r.flow_id) continue;
      if (flowIdByContact.has(r.contact_id)) continue;
      flowIdByContact.set(r.contact_id, r.flow_id);
      if (!flowIds.includes(r.flow_id)) flowIds.push(r.flow_id);
    }
    if (flowIds.length === 0) return {};
    const { data: flows, error: flowsError } = await supabase
      .from('flows')
      .select('id, name')
      .eq('account_id', accountId)
      .in('id', flowIds);
    if (flowsError || !flows) return {};
    const nameByFlowId = new Map<string, string>();
    for (const f of flows as Array<{ id: string; name: string | null }>) {
      const name = typeof f.name === 'string' ? f.name.trim() : '';
      if (f.id && name) nameByFlowId.set(f.id, name);
    }
    const out: Record<string, string> = {};
    for (const [contactId, flowId] of flowIdByContact) {
      const name = nameByFlowId.get(flowId);
      if (name) out[contactId] = name;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Distinct lead ids holding at least one run in the given flow —
 * the membership set behind the Workspace Table filter. One
 * account-scoped query, never N+1. A foreign or nonexistent flow
 * resolves to [] (no cross-tenant oracle, no leak — the caller
 * short-circuits to an empty result exactly like matchless
 * search). Throws on database failure so the caller surfaces a
 * 500 instead of a silently empty list.
 */
export async function flowContactIds(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string
): Promise<string[]> {
  if (!accountId || !flowId) return [];
  const { data, error } = await supabase
    .from('flow_runs')
    .select('contact_id')
    .eq('account_id', accountId)
    .eq('flow_id', flowId)
    .not('contact_id', 'is', null)
    .limit(WORKSPACE_TABLE_CONTACT_LIMIT);
  if (error) throw error;
  return [
    ...new Set(
      ((data ?? []) as Array<{ contact_id: string | null }>)
        .map((r) => r.contact_id)
        .filter((id): id is string => !!id)
    ),
  ];
}
