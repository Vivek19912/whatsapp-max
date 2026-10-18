// GET /api/all-sheets/flows
//
// Flow list for the All Sheets UI, dynamically from the DB (never
// hardcoded). Joins ONLY all_sheet_collections / all_sheet_flow_tabs
// (never flow_sheet_configs / flow_incomplete_sheet_configs).

import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import type { AllSheetCollectionRow, AllSheetFlowTabRow } from "@/lib/all-sheets/types";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data: flows, error: flowsError } = await ctx.supabase
      .from("flows")
      .select("id, name")
      .eq("account_id", ctx.accountId)
      // Meta Lead Ads virtual flows have no Google Sheets tab concept;
      // keep this surface scoped to real conversational flows.
      .eq("kind", "whatsapp_flow")
      .order("name", { ascending: true });
    if (flowsError) throw flowsError;
    if (!flows || flows.length === 0) return NextResponse.json({ flows: [] });

    const { data: collections } = await ctx.supabase
      .from("all_sheet_collections")
      .select("id, kind, spreadsheet_url, spreadsheet_name")
      .eq("account_id", ctx.accountId);
    const cols = (collections ?? []) as AllSheetCollectionRow[];
    const colByKind = new Map(cols.map((c) => [c.kind, c]));

    let tabs: AllSheetFlowTabRow[] = [];
    if (cols.length > 0) {
      const { data: tabRows } = await ctx.supabase
        .from("all_sheet_flow_tabs")
        .select("id, collection_id, flow_id, worksheet_id, worksheet_title, header_written")
        .in(
          "collection_id",
          cols.map((c) => c.id),
        );
      tabs = (tabRows ?? []) as AllSheetFlowTabRow[];
    }
    const tabByFlowKind = new Map(tabs.map((t) => {
      const col = cols.find((c) => c.id === t.collection_id);
      return [`${t.flow_id}:${col?.kind ?? "?"}`, t];
    }));

    const flowsWithCounts = await Promise.all(
      (flows as Array<{ id: string; name: string }>).map(async (flow) => {
        const { count: completedCount } = await ctx.supabase
          .from("flow_runs")
          .select("id", { count: "exact", head: true })
          .eq("flow_id", flow.id)
          .eq("status", "completed");
        const { count: incompleteCount } = await ctx.supabase
          .from("flow_runs")
          .select("id", { count: "exact", head: true })
          .eq("flow_id", flow.id)
          .neq("status", "completed");
        return {
          flow_id: flow.id,
          flow_name: flow.name,
          completedCount: completedCount ?? 0,
          incompleteCount: incompleteCount ?? 0,
          completedCollection: colByKind.get("completed") ?? null,
          incompleteCollection: colByKind.get("incomplete") ?? null,
          completedTab: tabByFlowKind.get(`${flow.id}:completed`) ?? null,
          incompleteTab: tabByFlowKind.get(`${flow.id}:incomplete`) ?? null,
        };
      }),
    );

    return NextResponse.json({ flows: flowsWithCounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
