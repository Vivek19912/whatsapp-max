import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { ALL_META_LEADS_ID } from "@/lib/workspace/all-meta-leads";
import {
  clampColumnWidth,
  WORKSPACE_COLUMN_MAX_WIDTH,
  WORKSPACE_COLUMN_MIN_WIDTH,
} from "@/lib/flows/workspace-column-widths";

/**
 * Column-width overrides for one flow's Workspace (drag-to-resize
 * persistence).
 *
 *   GET — every width as { column_key: width_px }. Any account
 *     member. Natural (auto) widths store nothing.
 *   PUT — { column_key, width_px } upserts one width (agent+);
 *     { column_key, width_px: null } deletes it (back to auto).
 *     Widths validate to integers in the 80–500 safe band; keys
 *     are stable visibility ids (`core:row`, `flow:<key>`,
 *     `custom:<uuid>`, `lead_source`). The flow must belong to
 *     the caller's account — ids from the browser are never
 *     trusted as authority.
 */

const COLUMN_KEY_MAX = 120;

async function loadFlowAccount(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
) {
  const { data: flow, error } = await supabase
    .from("flows")
    .select("id, account_id")
    .eq("id", flowId)
    .maybeSingle();
  if (error) throw error;
  if (!flow || (flow as { account_id: string }).account_id !== accountId) {
    return null;
  }
  return flow;
}

function toWidths(
  rows: Array<{ column_key: string; width_px: number }>,
): Record<string, number> {
  const widths: Record<string, number> = {};
  for (const row of rows) {
    if (
      typeof row.column_key === "string" &&
      typeof row.width_px === "number"
    ) {
      widths[row.column_key] = row.width_px;
    }
  }
  return widths;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await getCurrentAccount();
    if (id === ALL_META_LEADS_ID) {
      // Virtual combined table: widths are keyed by real flow UUIDs,
      // so nothing is ever stored — return the default (same shape
      // as a table with no saved widths). Never passed to UUID
      // columns or database functions.
      return NextResponse.json({ widths: {} });
    }
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const { data, error } = await supabase
      .from("workspace_column_widths")
      .select("column_key, width_px")
      .eq("account_id", accountId)
      .eq("flow_id", id);
    if (error) throw error;
    return NextResponse.json({
      widths: toWidths(
        (data ?? []) as Array<{ column_key: string; width_px: number }>,
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("agent");
    if (id === ALL_META_LEADS_ID) {
      // Virtual combined table has no flow row and no stored
      // preferences — writes are rejected like any unknown flow.
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { column_key: rawKey, width_px: rawWidth } = body;
    if (
      typeof rawKey !== "string" ||
      rawKey.trim() === "" ||
      rawKey.trim().length > COLUMN_KEY_MAX
    ) {
      return NextResponse.json(
        { error: "column_key is required." },
        { status: 400 },
      );
    }
    const columnKey = rawKey.trim();

    // Null resets the column to its natural width (deletes the row).
    if (rawWidth === null || rawWidth === undefined || rawWidth === "") {
      const { error } = await supabase
        .from("workspace_column_widths")
        .delete()
        .eq("account_id", accountId)
        .eq("flow_id", id)
        .eq("column_key", columnKey);
      if (error) throw error;
      return NextResponse.json({ column_key: columnKey, width_px: null });
    }

    let widthPx: number;
    try {
      widthPx = clampColumnWidth(rawWidth);
    } catch {
      return NextResponse.json(
        {
          error: `width_px must be an integer between ${WORKSPACE_COLUMN_MIN_WIDTH} and ${WORKSPACE_COLUMN_MAX_WIDTH}.`,
        },
        { status: 400 },
      );
    }

    const { error } = await supabase.from("workspace_column_widths").upsert(
      {
        account_id: accountId,
        flow_id: id,
        column_key: columnKey,
        width_px: widthPx,
      },
      { onConflict: "account_id,flow_id,column_key" },
    );
    if (error) throw error;
    return NextResponse.json({ column_key: columnKey, width_px: widthPx });
  } catch (err) {
    return toErrorResponse(err);
  }
}
