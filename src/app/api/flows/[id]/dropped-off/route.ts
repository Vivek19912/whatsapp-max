import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import {
  createSpreadsheet,
  appendRows,
  formatSubmissionTimeIST,
  STANDARD_COLUMNS_V3,
} from "@/lib/google/sheets";
import { stringifySheetCell, partitionSheetKeys } from "@/lib/flows/sheet-layout";
import {
  headerByKey,
  orderNodesForSheets,
  sortKeysByFlowOrder,
  type FlowNodeLite,
} from "@/lib/flows/sheet-columns";
import { NextResponse } from "next/server";

/** Minimal shape of the flow_runs rows this route reads. */
type FlowRunRow = {
  id?: string;
  contact_id?: string | null;
  vars?: unknown;
  started_at?: string | null;
  ended_at?: string | null;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: flowId } = await context.params;
    const ctx = await getCurrentAccount();

    // Verify flow ownership
    const { data: flow } = await ctx.supabase
      .from("flows")
      .select("id, name, entry_node_id")
      .eq("id", flowId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    if (!flow) {
      return NextResponse.json({ error: "Flow not found" }, { status: 404 });
    }

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "Connect a Google account first." },
        { status: 400 },
      );
    }

    // Get all incomplete/abandoned runs for THIS FLOW
    const { data: droppedRuns } = await ctx.supabase
      .from("flow_runs")
      .select("id, contact_id, vars, started_at, ended_at")
      .eq("flow_id", flowId)
      .neq("status", "completed")
      .order("started_at", { ascending: true });

    if (!droppedRuns || droppedRuns.length === 0) {
      return NextResponse.json({ rowCount: 0, sheetUrl: "" });
    }

    // Get unique contacts
    const contactIds = [
      ...new Set(
        droppedRuns
          .map((r: FlowRunRow) => r.contact_id)
          .filter(Boolean),
      ),
    ];
    const contactMap = new Map<
      string,
      { name?: string; phone?: string }
    >();
    if (contactIds.length > 0) {
      const { data: contacts } = await ctx.supabase
        .from("contacts")
        .select("id, name, phone")
        .in("id", contactIds as string[]);
      for (const c of contacts ?? []) {
        contactMap.set(c.id, { name: c.name, phone: c.phone });
      }
    }

    // Create a new spreadsheet
    const title = `${flow.name} — Dropped Off Users`;
    const meta = await createSpreadsheet(token, title);

    // Build rows with the V3 headers (Name + Phone + Time + answer vars).
    // Honor "Include in Google Sheet" like every other writer: keys whose
    // nodes are switched off never become columns here. Answer columns
    // follow canonical flow (graph-walk) order; unknown keys (deleted
    // nodes, non-question captures) keep first-seen order at the end,
    // matching the conservative incomplete-sheet contract.
    const { data: sheetNodes } = await ctx.supabase
      .from("flow_nodes")
      .select("node_key, node_type, config, created_at")
      .eq("flow_id", flowId)
      .order("created_at", { ascending: true });
    const orderedNodes = orderNodesForSheets(
      (flow as { entry_node_id?: string | null } | null)?.entry_node_id ?? null,
      (sheetNodes ?? []) as FlowNodeLite[],
    );
    const { disabledKeys } = partitionSheetKeys(orderedNodes);
    // Human-readable headers per the completed-sheet contract; unknown
    // keys fall back to the raw key. Map order matches flow order, so its
    // keys double as the ranking (unknowns keep first-seen order after).
    const headerMap = headerByKey(
      (flow as { entry_node_id?: string | null } | null)?.entry_node_id ?? null,
      orderedNodes,
    );
    const headerFor = (k: string): string => headerMap.get(k) ?? k;
    const unorderedKeys = new Set<string>();
    droppedRuns.forEach((run: FlowRunRow) => {
      Object.keys(run.vars ?? {}).forEach((k) => {
        if (!disabledKeys.has(k)) unorderedKeys.add(k);
      });
    });
    const allVarKeys = sortKeysByFlowOrder(
      [...unorderedKeys],
      [...headerMap.keys()],
    );

    // Use the V3 header structure for this brand-new spreadsheet (no
    // legacy layout to preserve): Name + Phone Number + Submission Time +
    // answer vars. Flow Name / User ID are display-only and omitted.
    const nameHeaderCell = ["Name"];
    const answerHeaders = Array.from(allVarKeys, headerFor);
    const headers = [...nameHeaderCell, ...STANDARD_COLUMNS_V3, ...answerHeaders];

    const rows = droppedRuns.map((run: FlowRunRow) => {
      const contact = run.contact_id
        ? contactMap.get(run.contact_id)
        : null;
      const vars = (run.vars ?? {}) as Record<string, unknown>;
      return [
        contact?.name ?? "",
        contact?.phone ?? "",
        formatSubmissionTimeIST(run.ended_at ?? run.started_at),
        ...Array.from(allVarKeys).map((k) =>
          stringifySheetCell(vars[k]),
        ),
      ];
    });

    // Append header + rows
    const toWrite = [[...headers], ...rows];
    await appendRows(
      token,
      meta.spreadsheetId,
      meta.firstSheetTitle,
      toWrite,
    );

    return NextResponse.json({
      rowCount: rows.length,
      sheetUrl: meta.url,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
