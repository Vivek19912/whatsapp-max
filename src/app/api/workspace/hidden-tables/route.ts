import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";

/**
 * Workspace table hide/restore preferences (account-wide).
 *
 *   GET — { hidden: string[] } flow ids hidden from the
 *     Workspace selector for this account. Any member.
 *   PUT — { hidden: string[] } replaces the hidden set
 *     (owner only). Every id must be a flow in the caller's
 *     account — foreign ids read as not-found so they can never
 *     hide (or probe) another tenant's tables. Unhiding is the
 *     same call with the id omitted.
 *
 * Visibility-only: rows here never touch flows, forms, leads,
 * ingestion, imports, or polling — the client simply filters the
 * selector. Deleting a flow cascades its hide row.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("workspace_hidden_tables")
      .select("flow_id")
      .eq("account_id", accountId);
    if (error) throw error;
    const hidden = ((data ?? []) as Array<{ flow_id: unknown }>)
      .map((r) => r.flow_id)
      .filter((v): v is string => typeof v === "string" && v !== "");
    return NextResponse.json({ hidden });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("owner");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { hidden: rawHidden } = body;
    if (!Array.isArray(rawHidden)) {
      return NextResponse.json(
        { error: "hidden must be an array of flow ids." },
        { status: 400 },
      );
    }
    const wanted = [...new Set(
      rawHidden.filter((v): v is string => typeof v === "string" && UUID_RE.test(v)),
    )];
    if (wanted.length !== rawHidden.length) {
      return NextResponse.json(
        { error: "hidden must contain only valid flow ids." },
        { status: 400 },
      );
    }

    // Every id must resolve to a flow in THIS account — a foreign
    // id reads as not-found (never an existence oracle for another
    // tenant's tables).
    if (wanted.length > 0) {
      const { data: owned, error: ownedErr } = await supabase
        .from("flows")
        .select("id")
        .eq("account_id", accountId)
        .in("id", wanted);
      if (ownedErr) throw ownedErr;
      const ownedIds = new Set(
        ((owned ?? []) as Array<{ id: string }>).map((r) => r.id),
      );
      if (ownedIds.size !== wanted.length) {
        return NextResponse.json({ error: "Flow not found." }, { status: 404 });
      }
    }

    // Replace the set: drop unhidden rows, upsert the rest. Both
    // statements are account-scoped; RLS additionally restricts
    // writes to the owner (migration 168).
    if (wanted.length === 0) {
      const { error: deleteErr } = await supabase
        .from("workspace_hidden_tables")
        .delete()
        .eq("account_id", accountId);
      if (deleteErr) throw deleteErr;
    } else {
      const { error: deleteErr } = await supabase
        .from("workspace_hidden_tables")
        .delete()
        .eq("account_id", accountId)
        .not("flow_id", "in", `(${wanted.join(",")})`);
      if (deleteErr) throw deleteErr;
      const { error: upsertErr } = await supabase
        .from("workspace_hidden_tables")
        .upsert(
          wanted.map((flowId) => ({
            account_id: accountId,
            flow_id: flowId,
            hidden_by: userId,
          })),
          { onConflict: "account_id,flow_id" },
        );
      if (upsertErr) throw upsertErr;
    }

    return NextResponse.json({ hidden: wanted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
