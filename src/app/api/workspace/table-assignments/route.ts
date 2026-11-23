import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

/**
 * GET /api/workspace/table-assignments — central Table Assignments
 * listing for the account owner. Every Meta Lead Ads Workspace
 * table (flows.kind = 'meta_lead_ads'), including hidden tables
 * and disabled forms' tables, with its saved per-table assignment
 * configuration (or null when never configured).
 *
 * Owner-only: admin/agent/viewer get 403 (hiding the nav entry is
 * not sufficient). Reads are account-scoped. Contact channels
 * (emails/phone numbers) are never exposed in this listing — the
 * Edit wizard loads full details through the existing per-table
 * endpoint. Opening this page never triggers assignment or
 * notifications; writes go through the existing PUT endpoint.
 *
 * Batched reads only (flows → configs → assignees → roster names
 * → form names): constant round trips, never one request per
 * table. Pagination/search/filter stay client-side: the table
 * count is bounded by the account's Meta form count.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole("owner");

    // Authoritative table discovery: every Meta Lead Ads virtual
    // flow for this account. Hidden tables and disabled forms'
    // tables are included (visibility/polling state never deletes
    // the flow); deleted flows simply no longer exist.
    const { data: flowsData, error: flowsErr } = await supabase
      .from("flows")
      .select("id, name, meta_form_id")
      .eq("account_id", accountId)
      .eq("kind", "meta_lead_ads")
      .order("name", { ascending: true });
    if (flowsErr) throw flowsErr;
    const flows = ((flowsData ?? []) as Array<{
      id: string;
      name: string | null;
      meta_form_id: string | null;
    }>).filter((f) => typeof f.id === "string");
    if (flows.length === 0) {
      return NextResponse.json({ tables: [] });
    }
    const flowIds = flows.map((f) => f.id);

    // Saved configs for these tables (at most one row per
    // (account_id, flow_id) by UNIQUE constraint).
    const { data: configsData, error: configsErr } = await supabase
      .from("lead_assignment_table_configs")
      .select(
        "id, flow_id, enabled, mode, whatsapp_template_name, whatsapp_template_language, updated_at",
      )
      .eq("account_id", accountId)
      .in("flow_id", flowIds);
    if (configsErr) throw configsErr;
    const configByFlow = new Map(
      ((configsData ?? []) as Array<Record<string, unknown>>).map((c) => [
        c.flow_id as string,
        c,
      ]),
    );

    // Saved recipients for these configs (position order = engine order).
    // Contact channels are intentionally NOT selected: the listing
    // shows names/initials only (see §10); the Edit wizard loads
    // full details per table through the existing endpoint.
    const configIds = [...configByFlow.values()].map((c) => c.id as string);
    type AssigneeRow = {
      id: string;
      config_id: string;
      user_id: string | null;
      display_name: string;
      weight: number;
      is_active: boolean;
      position: number;
    };
    let assigneeRows: AssigneeRow[] = [];
    if (configIds.length > 0) {
      const { data: assigneesData, error: assigneesErr } = await supabase
        .from("lead_assignment_table_assignees")
        .select(
          "id, config_id, user_id, display_name, weight, is_active, position",
        )
        .in("config_id", configIds)
        .order("position", { ascending: true });
      if (assigneesErr) throw assigneesErr;
      assigneeRows = ((assigneesData ?? []) as Array<Record<string, unknown>>).map(
        (a) => ({
          id: a.id as string,
          config_id: a.config_id as string,
          user_id: (a.user_id as string | null) ?? null,
          display_name: a.display_name as string,
          weight: typeof a.weight === "number" ? a.weight : 0,
          is_active: a.is_active !== false,
          position: typeof a.position === "number" ? a.position : 0,
        }),
      );
    }
    const assigneesByConfig = new Map<string, AssigneeRow[]>();
    for (const a of assigneeRows) {
      const list = assigneesByConfig.get(a.config_id) ?? [];
      list.push(a);
      assigneesByConfig.set(a.config_id, list);
    }

    // Live roster display names for internal members (fallback to
    // the saved display name when the member left/was renamed).
    const memberIds = [
      ...new Set(
        assigneeRows
          .map((a) => a.user_id)
          .filter((v): v is string => typeof v === "string" && v !== ""),
      ),
    ];
    const rosterNameById = new Map<string, string>();
    if (memberIds.length > 0) {
      const { data: rosterData, error: rosterErr } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("account_id", accountId)
        .in("user_id", memberIds);
      if (rosterErr) throw rosterErr;
      for (const p of (rosterData ?? []) as Array<{
        user_id: unknown;
        full_name: unknown;
      }>) {
        if (
          typeof p.user_id === "string" &&
          typeof p.full_name === "string" &&
          p.full_name.trim() !== ""
        ) {
          rosterNameById.set(p.user_id, p.full_name.trim());
        }
      }
    }

    // Original form names for display (fallback: stripped flow name).
    const metaFormIds = [
      ...new Set(
        flows.map((f) => f.meta_form_id).filter((v): v is string => typeof v === "string" && v !== ""),
      ),
    ];
    const formNameById = new Map<string, string | null>();
    if (metaFormIds.length > 0) {
      const { data: formsData, error: formsErr } = await supabase
        .from("meta_lead_forms")
        .select("id, form_name")
        .eq("account_id", accountId)
        .in("id", metaFormIds);
      if (formsErr) throw formsErr;
      for (const f of (formsData ?? []) as Array<{ id: unknown; form_name: unknown }>) {
        if (typeof f.id === "string") {
          formNameById.set(f.id, typeof f.form_name === "string" ? f.form_name : null);
        }
      }
    }

    const tables = flows.map((f) => {
      const configRow = configByFlow.get(f.id) ?? null;
      const formName =
        (f.meta_form_id ? formNameById.get(f.meta_form_id) : undefined) ??
        stripMetaPrefix(f.name);
      const assignees = configRow
        ? (assigneesByConfig.get(configRow.id as string) ?? []).map((a) => ({
            id: a.id,
            user_id: a.user_id,
            display_name:
              (a.user_id ? rosterNameById.get(a.user_id) : undefined) ?? a.display_name,
            weight: a.weight,
            is_active: a.is_active,
          }))
        : [];
      return {
        flow_id: f.id,
        flow_name: f.name,
        table_name: formName,
        form_id: f.meta_form_id,
        config: configRow
          ? {
              id: configRow.id,
              enabled: (configRow.enabled as boolean) === true,
              mode: configRow.mode === "percentage" ? "percentage" : "round_robin",
              whatsapp_template_name:
                (configRow.whatsapp_template_name as string | null) ?? null,
              whatsapp_template_language:
                (configRow.whatsapp_template_language as string) || "en_US",
              updated_at: (configRow.updated_at as string | null) ?? null,
            }
          : null,
        assignees,
      };
    });

    return NextResponse.json({ tables });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Display name for the Workspace table (strips the virtual-flow prefix). */
function stripMetaPrefix(name: string | null): string {
  return (name ?? "").replace(/^Meta Lead Ads\s*·\s*/, "").trim() || "Untitled table";
}
