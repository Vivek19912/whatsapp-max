import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

// ============================================================
// GET /api/account/agent-permissions?user_id=<uuid> — one agent's
// permission flags. Owner-only (single-row lookup keeps the
// endpoint minimal; the dialog fetches per member on open).
// Missing row => all-false defaults (never null-ambiguous).
// ============================================================

export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("owner");
  } catch (err) {
    return toErrorResponse(err);
  }

  const userId = new URL(request.url).searchParams.get("user_id");
  if (!userId || !UUID_RE.test(userId)) {
    return NextResponse.json(
      { error: "A valid user_id query parameter is required." },
      { status: 400 },
    );
  }

  const { data, error } = await ctx.supabase
    .from("agent_inbox_permissions")
    .select("user_id, can_manage_assignments, can_view_all, updated_at")
    .eq("account_id", ctx.accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[agent-permissions] lookup failed:", error.message);
    return NextResponse.json(
      { error: "Could not load permissions." },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({
      permission: {
        user_id: userId,
        can_manage_assignments: false,
        can_view_all: false,
        updated_at: null,
      },
    });
  }
  return NextResponse.json({ permission: data });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// PUT /api/account/agent-permissions — grant/revoke one agent's
// Inbox permissions. Owner-only, enforced here AND by RLS
// (agent_inbox_permissions_* policies allow only owner writes,
// so a forged request from any other role fails at the database
// even if this check were bypassed).
//
// Body: { user_id: string, can_manage_assignments?: boolean,
//         can_view_all?: boolean }
// Only agents may hold permission rows — owners/admins already
// have full access by role, viewers keep legacy read-only, and
// writing a row for them would be misleading dead config.
// ============================================================

export async function PUT(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("owner");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const userId = body?.user_id;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    return NextResponse.json(
      { error: "user_id must be a valid member id." },
      { status: 400 },
    );
  }

  const patch: { can_manage_assignments?: boolean; can_view_all?: boolean } = {};
  for (const key of ["can_manage_assignments", "can_view_all"] as const) {
    if (body?.[key] === undefined) continue;
    if (typeof body[key] !== "boolean") {
      return NextResponse.json(
        { error: `"${key}" must be true or false.` },
        { status: 400 },
      );
    }
    patch[key] = body[key] as boolean;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  // The target must be an agent of this account — never another
  // account's member, never an owner/admin (their access comes from
  // their role, and a permission row for them would imply a
  // downgrade path that does not exist).
  const { data: profile, error: profileErr } = await ctx.supabase
    .from("profiles")
    .select("user_id, account_id, account_role")
    .eq("user_id", userId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (profileErr) {
    console.error("[agent-permissions] roster lookup failed:", profileErr.message);
    return NextResponse.json(
      { error: "Could not verify team member." },
      { status: 500 },
    );
  }
  const target = profile as {
    user_id: string;
    account_id: string;
    account_role: string;
  } | null;
  if (!target) {
    return NextResponse.json(
      { error: "Choose a team member from this account." },
      { status: 400 },
    );
  }
  if (target.account_role !== "agent") {
    return NextResponse.json(
      { error: "Permissions can only be granted to agents." },
      { status: 400 },
    );
  }
  if (target.user_id === ctx.userId) {
    return NextResponse.json(
      { error: "Owners already have full access." },
      { status: 400 },
    );
  }

  const { data, error } = await ctx.supabase
    .from("agent_inbox_permissions")
    .upsert(
      {
        account_id: ctx.accountId,
        user_id: userId,
        granted_by: ctx.userId,
        ...patch,
      },
      { onConflict: "account_id,user_id" }
    )
    .select("user_id, can_manage_assignments, can_view_all, updated_at")
    .maybeSingle();
  if (error) {
    console.error("[agent-permissions] upsert failed:", error.message);
    return NextResponse.json(
      { error: "Could not save permissions." },
      { status: 500 },
    );
  }
  return NextResponse.json({ permission: data });
}
