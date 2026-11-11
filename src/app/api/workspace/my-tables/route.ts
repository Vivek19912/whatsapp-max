import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAssigneeField } from "@/lib/flows/workspace-assignee";
import { resolveWorkspaceVisibility } from "@/lib/inbox/assignment-access";

/**
 * GET /api/workspace/my-tables — Meta Lead Ads Tables for the caller.
 * Agent+.
 *
 * Table listing follows the View All Conversations permission:
 * agents WITH it see every authorized Meta table (with per-table
 * assigned counts for the empty state); agents WITHOUT it see only
 * tables containing at least one of their own assigned leads, with
 * counts scoped to their own leads (never other agents' counts).
 * Owners/admins/viewers keep using /api/flows.
 */
export async function GET() {
  try {
    const { supabase, accountId, userId, role } = await requireRole("agent");

    const { restricted } = await resolveWorkspaceVisibility(
      supabase,
      accountId,
      userId,
      role,
    );
    const scopeToOwn = role === "agent" && restricted;

    const { data: flows, error: flowsErr } = await supabase
      .from("flows")
      .select("id, name")
      .eq("account_id", accountId)
      .eq("kind", "meta_lead_ads")
      .order("name", { ascending: true });
    if (flowsErr) throw flowsErr;
    const metaFlows = ((flows ?? []) as Array<{
      id: string;
      name: string | null;
    }>).filter((f) => typeof f.id === "string");
    if (metaFlows.length === 0) {
      return NextResponse.json({ tables: [] });
    }
    const flowIds = metaFlows.map((f) => f.id);

    const { data: fields, error: fieldsErr } = await supabase
      .from("workspace_fields")
      .select("id, flow_id, name")
      .eq("account_id", accountId)
      .in("flow_id", flowIds);
    if (fieldsErr) throw fieldsErr;
    const assigneeFields = ((fields ?? []) as Array<{
      id: string;
      flow_id: string;
      name: string;
    }>).filter((f) => isAssigneeField(f));
    if (assigneeFields.length === 0) {
      return NextResponse.json({ tables: [] });
    }
    const fieldToFlow = new Map(assigneeFields.map((f) => [f.id, f.flow_id]));

    const { data: values, error: valuesErr } = await supabase
      .from("workspace_values")
      .select("field_id")
      .eq("account_id", accountId)
      .eq("value_text", userId)
      .in(
        "field_id",
        assigneeFields.map((f) => f.id),
      );
    if (valuesErr) throw valuesErr;
    const counts = new Map<string, number>();
    for (const v of (values ?? []) as Array<{ field_id: string }>) {
      const flowId = fieldToFlow.get(v.field_id);
      if (!flowId) continue;
      counts.set(flowId, (counts.get(flowId) ?? 0) + 1);
    }

    return NextResponse.json({
      tables: metaFlows
        .filter((f) => !scopeToOwn || (counts.get(f.id) ?? 0) > 0)
        .map((f) => ({
          flow_id: f.id,
          name: f.name,
          assigned_count: counts.get(f.id) ?? 0,
        })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
