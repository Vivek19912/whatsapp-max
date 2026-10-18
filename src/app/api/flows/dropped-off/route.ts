import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // Get all conversational flows for this account (Meta Lead Ads
    // virtual flows are Workspace-only and have no dropped-off concept).
    const { data: flows } = await ctx.supabase
      .from("flows")
      .select("id, name")
      .eq("account_id", ctx.accountId)
      .eq("kind", "whatsapp_flow");

    if (!flows || flows.length === 0) {
      return NextResponse.json({ flows: [] });
    }

    // Live incomplete-runs sheets already enabled for these flows.
    const { data: liveConfigs } = await ctx.supabase
      .from("flow_incomplete_sheet_configs")
      .select("flow_id, spreadsheet_url, spreadsheet_name")
      .eq("account_id", ctx.accountId);
    const liveByFlow = new Map(
      (liveConfigs ?? []).map((c) => [c.flow_id, c]),
    );

    // For each flow, count incomplete runs
    const flowsWithCounts = await Promise.all(
      flows.map(async (flow) => {
        const { count } = await ctx.supabase
          .from("flow_runs")
          .select("id", { count: "exact", head: true })
          .eq("flow_id", flow.id)
          .neq("status", "completed");

        const live = liveByFlow.get(flow.id);
        return {
          flow_id: flow.id,
          flow_name: flow.name,
          droppedCount: count || 0,
          liveSheetUrl: live?.spreadsheet_url ?? null,
          liveSheetName: live?.spreadsheet_name ?? null,
        };
      }),
    );

    return NextResponse.json({ flows: flowsWithCounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
