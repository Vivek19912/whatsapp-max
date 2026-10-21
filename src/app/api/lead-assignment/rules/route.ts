import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  createRule,
  listRules,
} from "@/lib/lead-assignment/rules";
import { validateRuleInput } from "@/lib/lead-assignment/validation";

/**
 * GET /api/lead-assignment/rules — list all assignment setups with
 * targets + members. Any member may read.
 *
 * POST /api/lead-assignment/rules — create a setup. Admin+.
 * Validates percentages (exactly 100 for SWRR), table/member
 * membership, and active-rule conflicts (409 with details).
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

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    return NextResponse.json({ rules: await listRules(supabase, accountId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("admin");
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
      const rule = await createRule(supabase, {
        accountId,
        createdBy: userId,
        input,
      });
      return NextResponse.json({ rule }, { status: 201 });
    } catch (err) {
      return mapKnownError(err);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
