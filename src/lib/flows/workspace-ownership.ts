// ============================================================
// Workspace lead ownership checks (agent scoping).
//
// A Meta Lead Ads lead is "owned" by a team member when the flow's
// Assigned To workspace cell stores that member's stable user_id.
// Agents may only read or mutate their own assigned leads on Meta
// tables; owners/admins/viewers and every Flow Table keep existing
// behavior.
//
// This lives under lib/flows (not lib/lead-assignment) on purpose:
// shared Workspace write paths must stay decoupled from the Lead
// Assignment module. The logic mirrors the assignment store's
// resolution without importing it.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isAssigneeField } from "./workspace-assignee";

/** Whether a flow in this account is a Meta Lead Ads Table. */
export async function isMetaFlow(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("account_id", accountId)
    .eq("kind", "meta_lead_ads")
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

async function findAssigneeFieldId(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("workspace_fields")
    .select("id, name")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (error) throw error;
  const field = ((data ?? []) as Array<{ id: string; name: string }>).find((f) =>
    isAssigneeField(f),
  );
  return field ? field.id : null;
}

/**
 * Whether the run's Assigned To cell holds exactly this user id.
 * Missing/renamed assignee columns, cleared cells, and
 * "Unassigned" all count as NOT owned — never default-allow.
 */
export async function isRunOwnedByUser(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    runId: string;
    userId: string;
  },
): Promise<boolean> {
  const { accountId, flowId, runId, userId } = args;
  const fieldId = await findAssigneeFieldId(db, accountId, flowId);
  if (!fieldId) return false;
  const { data, error } = await db
    .from("workspace_values")
    .select("value_text")
    .eq("account_id", accountId)
    .eq("field_id", fieldId)
    .eq("flow_run_id", runId)
    .maybeSingle();
  if (error) throw error;
  const current = (data as { value_text: string | null } | null)?.value_text ?? null;
  return current !== null && current === userId;
}
