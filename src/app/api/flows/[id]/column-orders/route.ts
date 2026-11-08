import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";

/**
 * Per-user, per-table Workspace column order (drag-and-drop
 * persistence).
 *
 *   GET — { ordered_ids: string[] | null }. Any account member;
 *     always scoped to the caller (server-derived user id).
 *   PUT — { ordered_ids: string[] } upserts the caller's order
 *     (agent+); validated as a bounded string array, unknown ids
 *     tolerated (the client merge drops stale ones).
 *   DELETE — clears the caller's order (agent+); the table falls
 *     back to default order. Reset affects ordering only.
 *
 * The flow must belong to the caller's account — ids from the
 * browser are never trusted as authority.
 */

const ORDER_ID_MAX = 120;

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

function sanitizeOrderIds(value: unknown): string[] | null {
  // Server-side boundary validation (intentionally independent of
  // the client order model, which lives in a client-hook module
  // the server cannot import): bounded array of non-empty stable
  // column ids, deduped. Unknown ids are tolerated — the client's
  // merge drops stale ones and appends new columns.
  if (!Array.isArray(value)) return null;
  if (value.length > 500) return null;
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const id = raw.trim();
    if (id === "" || id.length > ORDER_ID_MAX) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId } = await getCurrentAccount();
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const { data, error } = await supabase
      .from("workspace_column_orders")
      .select("ordered_ids")
      .eq("account_id", accountId)
      .eq("flow_id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    const orderedIds =
      data && typeof data === "object" && "ordered_ids" in data
        ? sanitizeOrderIds((data as { ordered_ids: unknown }).ordered_ids)
        : null;
    return NextResponse.json({ ordered_ids: orderedIds });
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
    const { supabase, accountId, userId } = await requireRole("agent");
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
    const orderedIds = sanitizeOrderIds(body.ordered_ids);
    if (!orderedIds) {
      return NextResponse.json(
        { error: "ordered_ids must be an array of column id strings." },
        { status: 400 },
      );
    }
    const { error } = await supabase.from("workspace_column_orders").upsert(
      {
        user_id: userId,
        account_id: accountId,
        flow_id: id,
        ordered_ids: orderedIds,
      },
      { onConflict: "user_id,account_id,flow_id" },
    );
    if (error) throw error;
    return NextResponse.json({ ordered_ids: orderedIds });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId } = await requireRole("agent");
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const { error } = await supabase
      .from("workspace_column_orders")
      .delete()
      .eq("account_id", accountId)
      .eq("flow_id", id)
      .eq("user_id", userId);
    if (error) throw error;
    return NextResponse.json({ cleared: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
