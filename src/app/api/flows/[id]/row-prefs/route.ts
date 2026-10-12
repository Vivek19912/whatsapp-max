import { NextResponse } from "next/server";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import type { HiddenRowInfo } from "@/lib/flows/workspace-row-prefs";

/**
 * Row pin/hide preferences for one flow's Workspace (per user).
 *
 *   GET — { pinned: string[], hidden: HiddenRowInfo[] } for the
 *     caller + flow. Any account member. Hidden rows carry just
 *     enough to identify them (lead name + phone); runs that no
 *     longer belong to this flow are dropped, never exposed.
 *   PUT — { flow_run_id, pinned?, hidden? } upserts one row's
 *     preference (agent+). Null/omitted means "leave unchanged",
 *     so pin and hide stay independent; both-false deletes the
 *     preference row. The run must belong to this flow.
 *   DELETE — { all_hidden: true } restores every hidden row in
 *     this flow for the caller (agent+). Pins are never touched.
 *
 * Writes go through SECURITY DEFINER RPCs (migration 117) that
 * re-validate auth, tenant, flow, and run server-side; RLS exposes
 * each caller to their own preference rows only. The flow must
 * belong to the caller's account — ids from the browser are never
 * trusted as authority.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

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

/**
 * Map a row-pref RPC error onto the right HTTP response. The RPCs
 * raise with well-known SQLSTATEs (see migration 117):
 *   42501 -> forbidden, P0002 -> flow not found, 22023 -> row
 *   not found (missing, deleted, or cross-account — deliberately
 *   indistinguishable, never an existence oracle).
 */
function prefRpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "P0002") {
    return NextResponse.json({ error: "Flow not found." }, { status: 404 });
  }
  // Run missing or not in the caller's flow/account — treat as a
  // not-found so we don't leak whether the id exists elsewhere.
  if (err.code === "22023") {
    return NextResponse.json({ error: "Row not found." }, { status: 404 });
  }
  console.error("[row-prefs] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Unable to update row preferences. Please try again." },
    { status: 500 },
  );
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
    const { data: prefRows, error: prefErr } = await supabase
      .from("workspace_row_prefs")
      .select("flow_run_id, is_pinned, is_hidden")
      .eq("account_id", accountId)
      .eq("flow_id", id)
      .eq("user_id", userId);
    if (prefErr) throw prefErr;
    const prefs = (prefRows ?? []) as Array<{
      flow_run_id: string;
      is_pinned: boolean;
      is_hidden: boolean;
    }>;
    const pinned = prefs
      .filter((p) => p.is_pinned && typeof p.flow_run_id === "string")
      .map((p) => p.flow_run_id);
    const hiddenIds = prefs
      .filter((p) => p.is_hidden && typeof p.flow_run_id === "string")
      .map((p) => p.flow_run_id);

    // Identify hidden rows (name + phone) from runs that STILL
    // belong to this flow. Plain point lookups (no FK embeds, per
    // the issue-#294 lesson) under the caller's RLS — a run that
    // moved away or became inaccessible simply drops out, and no
    // unauthorized information is ever exposed.
    const hidden: HiddenRowInfo[] = [];
    if (hiddenIds.length > 0) {
      const { data: runRows, error: runErr } = await supabase
        .from("flow_runs")
        .select("id, contact_id")
        .eq("flow_id", id)
        .in("id", hiddenIds);
      if (runErr) throw runErr;
      const byRunId = new Map(
        ((runRows ?? []) as Array<{ id: string; contact_id: string | null }>).map(
          (r) => [r.id, r.contact_id] as const,
        ),
      );
      const contactIds = [
        ...new Set(
          [...byRunId.values()].filter(
            (v): v is string => typeof v === "string" && v !== "",
          ),
        ),
      ];
      const byContactId = new Map<string, { name: string | null; phone: string | null }>();
      if (contactIds.length > 0) {
        const { data: contactRows, error: contactErr } = await supabase
          .from("contacts")
          .select("id, name, phone")
          .in("id", contactIds);
        if (contactErr) throw contactErr;
        for (const c of (contactRows ?? []) as Array<{
          id: string;
          name: string | null;
          phone: string | null;
        }>) {
          byContactId.set(c.id, { name: c.name, phone: c.phone });
        }
      }
      // Preserve the hidden order the prefs query returned.
      for (const runId of hiddenIds) {
        if (!byRunId.has(runId)) continue;
        const contactId = byRunId.get(runId);
        const contact = contactId ? byContactId.get(contactId) : undefined;
        hidden.push({
          flow_run_id: runId,
          name: contact?.name ?? null,
          phone: contact?.phone ?? null,
        });
      }
    }
    return NextResponse.json({ pinned, hidden });
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
    const { flow_run_id: rawRunId, pinned: rawPinned, hidden: rawHidden } = body;
    if (!isUuid(rawRunId)) {
      return NextResponse.json(
        { error: "flow_run_id must be a valid UUID." },
        { status: 400 },
      );
    }
    for (const [key, raw] of [
      ["pinned", rawPinned],
      ["hidden", rawHidden],
    ] as const) {
      if (raw !== undefined && raw !== null && typeof raw !== "boolean") {
        return NextResponse.json(
          { error: `${key} must be a boolean when provided.` },
          { status: 400 },
        );
      }
    }
    if (
      (rawPinned === undefined || rawPinned === null) &&
      (rawHidden === undefined || rawHidden === null)
    ) {
      return NextResponse.json(
        { error: "Nothing to update: provide pinned and/or hidden." },
        { status: 400 },
      );
    }

    // The run must belong to this flow (and therefore this
    // account) — a foreign or deleted run reads as not-found.
    const { data: run, error: runErr } = await supabase
      .from("flow_runs")
      .select("id")
      .eq("id", rawRunId)
      .eq("flow_id", id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (runErr) throw runErr;
    if (!run) {
      return NextResponse.json({ error: "Row not found." }, { status: 404 });
    }

    const { data, error } = await supabase.rpc("set_workspace_row_pref", {
      p_flow_id: id,
      p_flow_run_id: rawRunId,
      p_pinned:
        typeof rawPinned === "boolean" ? rawPinned : null,
      p_hidden:
        typeof rawHidden === "boolean" ? rawHidden : null,
    });
    if (error) return prefRpcErrorToResponse(error);
    const saved = (data ?? {}) as {
      pinned?: boolean;
      hidden?: boolean;
    };
    return NextResponse.json({
      flow_run_id: rawRunId,
      pinned: saved.pinned ?? false,
      hidden: saved.hidden ?? false,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("agent");
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    // Bulk restore is the only supported DELETE: it clears hidden
    // flags for the caller's rows in this flow and never touches
    // pins. Single-row resets converge on PUT with both flags
    // false (the RPC deletes the emptied preference row).
    if (!body || typeof body !== "object" || body.all_hidden !== true) {
      return NextResponse.json(
        { error: "Only { all_hidden: true } is supported." },
        { status: 400 },
      );
    }
    const { data, error } = await supabase.rpc(
      "restore_workspace_hidden_rows",
      { p_flow_id: id },
    );
    if (error) return prefRpcErrorToResponse(error);
    const restored = typeof data === "number" ? data : Number(data ?? 0);
    return NextResponse.json({ restored });
  } catch (err) {
    return toErrorResponse(err);
  }
}
