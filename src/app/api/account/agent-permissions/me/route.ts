import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

// ============================================================
// GET /api/account/agent-permissions/me — this caller's own
// Inbox capability flags. Any authenticated member may call it;
// it returns only their own row (or all-false defaults).
// The Inbox UI uses it to decide whether to show the
// cross-thread assignment tools; owners/admins/viewers get
// their role-implied capabilities without a row.
// ============================================================

export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  if (ctx.role === "owner" || ctx.role === "admin") {
    return NextResponse.json({
      can_view_all: true,
      can_manage_assignments: true,
    });
  }
  if (ctx.role !== "agent") {
    // Viewers keep legacy read-all (mirrors resolveViewerCaps); any
    // other non-agent role gets no grants.
    if (ctx.role === "viewer") {
      return NextResponse.json({ can_manage_assignments: false, can_view_all: true });
    }
    return NextResponse.json({ can_manage_assignments: false, can_view_all: false });
  }

  const { data, error } = await ctx.supabase
    .from("agent_inbox_permissions")
    .select("can_manage_assignments, can_view_all")
    .eq("account_id", ctx.accountId)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error) {
    console.error("[agent-permissions/me] lookup failed:", error.message);
    return NextResponse.json(
      { error: "Could not load permissions." },
      { status: 500 },
    );
  }
  if (!data) return NextResponse.json({ can_manage_assignments: false, can_view_all: false });
  const row = data as { can_manage_assignments: boolean | null; can_view_all: boolean | null };
  return NextResponse.json({
    can_manage_assignments: row.can_manage_assignments === true,
    can_view_all: row.can_view_all === true,
  });
}
