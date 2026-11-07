import type { SupabaseClient } from "@supabase/supabase-js";

import { isWorkspaceFollowupFieldName } from "@/lib/followups/workspace-link";
import { validateWorkspaceValue } from "@/lib/flows/workspace-fields";
import { isRunOwnedByUser } from "@/lib/flows/workspace-ownership";
import type { AccountRole } from "@/lib/auth/roles";

/**
 * Shared server helpers for the sequential sales-followups API.
 * Every route authenticates (agent+), scopes the flow + run to the
 * account, and — for agents on Meta tables — requires live lead
 * assignment, mirroring the followup-reminder endpoints.
 */

export interface LeadFieldIds {
  followupFieldId: string | null;
  nextActionFieldId: string | null;
  lastContactFieldId: string | null;
}

export async function loadFlow(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
) {
  const { data, error } = await supabase
    .from("flows")
    .select("id, account_id, kind")
    .eq("id", flowId)
    .maybeSingle();
  if (error) throw error;
  const flow = data as {
    id: string;
    account_id: string;
    kind: string | null;
  } | null;
  if (!flow || flow.account_id !== accountId) return null;
  return flow;
}

export async function loadRun(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
  runId: string,
) {
  const { data, error } = await supabase
    .from("flow_runs")
    .select("id, account_id, flow_id")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  const run = data as {
    id: string;
    account_id: string;
    flow_id: string;
  } | null;
  if (!run || run.account_id !== accountId || run.flow_id !== flowId) {
    return null;
  }
  return run;
}

/** Agents on Meta tables may only touch leads assigned to them. */
export async function assertAgentMayTouchRun(args: {
  supabase: SupabaseClient;
  accountId: string;
  flowId: string;
  flowKind: string | null;
  runId: string;
  role: AccountRole;
  userId: string;
}): Promise<boolean> {
  const { supabase, accountId, flowId, flowKind, runId, role, userId } = args;
  // Owners/admins touch every lead; agents on Meta tables only
  // their assigned leads (mirrors the workspace-values PUT rule —
  // Flow Tables keep their existing behavior).
  if (role !== "agent") return true;
  if (flowKind !== "meta_lead_ads") return true;
  return isRunOwnedByUser(supabase, { accountId, flowId, runId, userId });
}

export async function loadAttempts(
  supabase: SupabaseClient,
  accountId: string,
  runId: string,
) {
  const { data, error } = await supabase
    .from("sales_followup_attempts")
    .select("*")
    .eq("account_id", accountId)
    .eq("flow_run_id", runId)
    .order("attempt_number", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function loadClosure(
  supabase: SupabaseClient,
  accountId: string,
  runId: string,
) {
  const { data, error } = await supabase
    .from("sales_followup_closures")
    .select("id, closed_by, closed_at")
    .eq("account_id", accountId)
    .eq("flow_run_id", runId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as {
    id: string;
    closed_by: string | null;
    closed_at: string;
  } | null;
}

/** Resolve the writable Workspace cell columns by stored name. */
export async function loadLeadFieldIds(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<LeadFieldIds> {
  const { data, error } = await supabase
    .from("workspace_fields")
    .select("id, name, field_type")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (error) throw error;
  const fields = (data ?? []) as Array<{
    id: string;
    name: string;
    field_type: string;
  }>;
  const byName = new Map(
    fields.map((f) => [f.name.trim().toLowerCase(), f] as const),
  );
  const followup = [...byName.values()].find(
    (f) => f.field_type === "datetime" && isWorkspaceFollowupFieldName(f.name),
  );
  return {
    followupFieldId: followup?.id ?? null,
    nextActionFieldId: byName.get("next action")?.id ?? null,
    lastContactFieldId: byName.get("last contact date")?.id ?? null,
  };
}

/**
 * Write one Workspace cell through the same validation the generic
 * cell API applies. Missing columns (renamed/deleted) are skipped,
 * never fatal — the attempt row is the source of truth.
 */
export async function writeLeadCell(args: {
  supabase: SupabaseClient;
  accountId: string;
  runId: string;
  field: { id: string; field_type: string; options: string[] | null } | null;
  value: string | null;
}): Promise<void> {
  const { supabase, accountId, runId, field, value } = args;
  if (!field) return;
  let normalized: string | null;
  try {
    normalized = validateWorkspaceValue(
      field.field_type as "text" | "date" | "datetime",
      field.options,
      value,
    );
  } catch {
    return;
  }
  if (normalized === null) {
    const { error } = await supabase
      .from("workspace_values")
      .delete()
      .eq("account_id", accountId)
      .eq("field_id", field.id)
      .eq("flow_run_id", runId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("workspace_values").upsert(
    {
      account_id: accountId,
      field_id: field.id,
      flow_run_id: runId,
      value_text: normalized,
    },
    { onConflict: "field_id,flow_run_id" },
  );
  if (error) throw error;
}

/** Field metadata needed by writeLeadCell. */
export async function loadWritableField(
  supabase: SupabaseClient,
  accountId: string,
  fieldId: string,
) {
  const { data, error } = await supabase
    .from("workspace_fields")
    .select("id, field_type, options")
    .eq("account_id", accountId)
    .eq("id", fieldId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as {
    id: string;
    field_type: string;
    options: string[] | null;
  } | null;
}
