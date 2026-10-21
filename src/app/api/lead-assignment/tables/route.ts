import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getCoverage, listRules } from "@/lib/lead-assignment/rules";

/**
 * GET /api/lead-assignment/tables — eligible Meta Lead Ads Tables
 * for rule targeting, each with its governing active rule (or
 * null when uncovered). Admin+.
 *
 * Tables are account Meta forms joined to their virtual Workspace
 * flow (label follows the "Meta Lead Ads · <name>" convention).
 * Uncovered tables fall back to the All-Tables rule, if any.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { data: forms, error: formsErr } = await supabase
      .from("meta_lead_forms")
      .select("id, form_id, form_name")
      .eq("account_id", accountId)
      .order("form_name", { ascending: true });
    if (formsErr) throw formsErr;
    const { data: flows, error: flowsErr } = await supabase
      .from("flows")
      .select("id, name, meta_form_id")
      .eq("account_id", accountId)
      .eq("kind", "meta_lead_ads");
    if (flowsErr) throw flowsErr;
    const flowByForm = new Map(
      ((flows ?? []) as Array<{
        id: string;
        name: string | null;
        meta_form_id: string | null;
      }>).map((f) => [f.meta_form_id, f]),
    );
    const rules = await listRules(supabase, accountId);
    const ruleById = new Map(rules.map((r) => [r.id, r]));
    const tables: Array<Record<string, unknown>> = [];
    for (const form of (forms ?? []) as Array<{
      id: string;
      form_id: string;
      form_name: string | null;
    }>) {
      const flow = flowByForm.get(form.id) ?? null;
      // Reuse the single resolution source of truth per table.
      const { resolveAssignmentRule } = await import(
        "@/lib/lead-assignment/service"
      );
      const resolved = await resolveAssignmentRule(supabase, accountId, form.id);
      const governing = resolved ? ruleById.get(resolved.rule.id) ?? null : null;
      tables.push({
        form_id: form.id,
        meta_form_id: form.form_id,
        form_name: form.form_name,
        flow_id: flow?.id ?? null,
        label: `Meta Lead Ads · ${form.form_name ?? form.form_id}`,
        governing_rule: governing
          ? {
              id: governing.id,
              name: governing.name,
              mode: governing.mode,
              status: governing.status,
            }
          : null,
      });
    }
    return NextResponse.json({ tables });
  } catch (err) {
    return toErrorResponse(err);
  }
}
