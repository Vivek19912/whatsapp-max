import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { ALL_META_LEADS_ID } from "@/lib/workspace/all-meta-leads";
import { normalizeHeaderColor } from "@/lib/flows/header-colors";

/**
 * Header background overrides for one flow's Workspace.
 *
 *   GET — every override as { column_key: "#rrggbb" }. Any
 *     account member. Defaults are NOT stored (they resolve in
 *     code), so hiding/showing columns or resetting visibility
 *     can never disturb colors.
 *   PUT — { column_key, color } upserts one override (agent+);
 *     { column_key, color: null } deletes it (reset to default).
 *     Colors validate as hex; keys are stable visibility ids
 *     (`core:row`, `flow:<key>`, `custom:<uuid>`, `lead_source`).
 *     The flow must belong to the caller's account — ids from the
 *     browser are never trusted as authority.
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

function toColors(
  rows: Array<{ column_key: string; color: string }>,
): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.column_key === "string" && typeof row.color === "string") {
      colors[row.column_key] = row.color;
    }
  }
  return colors;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await getCurrentAccount();
    if (id === ALL_META_LEADS_ID) {
      // Virtual combined table: colors are keyed by real flow UUIDs,
      // so nothing is ever stored — return the default (same shape
      // as a table with no saved colors). Never passed to UUID
      // columns or database functions.
      return NextResponse.json({ colors: {} });
    }
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const { data, error } = await supabase
      .from("workspace_header_colors")
      .select("column_key, color")
      .eq("account_id", accountId)
      .eq("flow_id", id);
    if (error) throw error;
    return NextResponse.json({
      colors: toColors(
        (data ?? []) as Array<{ column_key: string; color: string }>,
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
    const { column_key: rawKey, color: rawColor } = body;
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

    // A missing color is a client bug (400); explicit null/empty
    // resets the column to its default (deletes the row).
    if (rawColor === undefined) {
      return NextResponse.json(
        { error: "color is required (null resets to the default)." },
        { status: 400 },
      );
    }
    if (rawColor === null || rawColor === "") {
      const { error } = await supabase
        .from("workspace_header_colors")
        .delete()
        .eq("account_id", accountId)
        .eq("flow_id", id)
        .eq("column_key", columnKey);
      if (error) throw error;
      return NextResponse.json({ column_key: columnKey, color: null });
    }

    let color: string;
    try {
      color = normalizeHeaderColor(rawColor);
    } catch {
      return NextResponse.json(
        { error: "color must be a hex value like #dbeafe." },
        { status: 400 },
      );
    }

    // Strict uniqueness: every column keeps its own header color.
    // Re-saving the column's CURRENT color is idempotent (200);
    // taking a color another column uses is rejected (409) with a
    // message the UI surfaces verbatim.
    const { data: existing, error: readErr } = await supabase
      .from("workspace_header_colors")
      .select("column_key, color")
      .eq("account_id", accountId)
      .eq("flow_id", id);
    if (readErr) throw readErr;
    const clash = ((existing ?? []) as Array<{
      column_key: string;
      color: string;
    }>).some(
      (row) => row.column_key !== columnKey && row.color === color,
    );
    if (clash) {
      return NextResponse.json(
        {
          error:
            "That color is already used by another column — choose a different one.",
        },
        { status: 409 },
      );
    }

    const { error } = await supabase.from("workspace_header_colors").upsert(
      {
        account_id: accountId,
        flow_id: id,
        column_key: columnKey,
        color,
      },
      { onConflict: "account_id,flow_id,column_key" },
    );
    if (error) throw error;
    return NextResponse.json({ column_key: columnKey, color });
  } catch (err) {
    return toErrorResponse(err);
  }
}
