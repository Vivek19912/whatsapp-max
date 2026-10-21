import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  deleteRule,
  getRule,
  updateRule,
} from "@/lib/lead-assignment/rules";
import { validateRuleInput } from "@/lib/lead-assignment/validation";

/**
 * /api/lead-assignment/rules/[id] — one assignment setup.
 * GET: any member may read. PATCH/DELETE: admin+.
 * PATCH validates like create (409 on new conflicts, 404 missing).
 * DELETE removes the rule + targets + members + state (audit
 * events keep their rows with rule_id nulled).
 */

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function errStatus(err: unknown): number | null {
  if (err instanceof Error) {
    const status = (err as unknown as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

function mapKnownError(err: unknown) {
  const status = errStatus(err) ?? 500;
  if (status === 500) throw err;
  const extra =
    err instanceof Error &&
    Array.isArray((err as unknown as { conflicts?: unknown }).conflicts)
      ? { conflicts: (err as unknown as { conflicts: unknown }).conflicts }
      : {};
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Invalid input.", ...extra },
    { status },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await getCurrentAccount();
    const rule = await getRule(supabase, accountId, id);
    if (!rule) return bad("Rule not found.", 404);
    return NextResponse.json({ rule });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return bad("Invalid JSON body.");
    }
    let input;
    try {
      input = validateRuleInput({
        name: body.name,
        scope: body.scope,
        mode: body.mode,
        status: body.status ?? "active",
        tables: body.tables ?? body.table_ids,
        members: body.members,
      });
    } catch (err) {
      return bad(err instanceof Error ? err.message : "Invalid rule.");
    }
    try {
      const rule = await updateRule(supabase, { accountId, ruleId: id, input });
      return NextResponse.json({ rule });
    } catch (err) {
      return mapKnownError(err);
    }
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
    const { supabase, accountId } = await requireRole("admin");
    const deleted = await deleteRule(supabase, accountId, id);
    if (!deleted) return bad("Rule not found.", 404);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
