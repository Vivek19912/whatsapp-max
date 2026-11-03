import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { resolveViewerCaps } from "@/lib/inbox/assignment-access";
import { supabaseAdmin } from "@/lib/flows/admin-client";

export const dynamic = "force-dynamic";

// ============================================================
// GET /api/inbox/assignable?q=&limit= — minimal thread roster for
// the cross-thread assignment dialog.
//
// Who may call: owners/admins (full Inbox anyway) and agents
// holding the Manage Assignments permission. Plain agents get
// 403 — they assign only their own visible threads through the
// thread header instead.
//
// What it returns (deliberately minimal — assignment-only access,
// NOT message history): conversation id, contact name/phone,
// current assignee id, last activity. No messages, no media,
// no contact details beyond the display name/number needed to
// pick the right thread. Runs on the service-role client because
// RLS correctly hides these very rows from the caller; every
// boundary (role/permission check, account scoping) is enforced
// explicitly below instead.
// ============================================================

export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const caps = await resolveViewerCaps(
    admin,
    ctx.accountId,
    ctx.userId,
    ctx.role
  );
  const allowed =
    ctx.role === "owner" ||
    ctx.role === "admin" ||
    (ctx.role === "agent" && caps.canManageAssignments);
  if (!allowed) {
    return NextResponse.json(
      { error: "Requires the Manage Assignments permission." },
      { status: 403 }
    );
  }

  const params = new URL(request.url).searchParams;
  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 200)
    : 100;

  // Most recent threads first; the dialog filters by name/number
  // client-side. No server-side text search — embedded-contact
  // predicates would complicate the account-scoped join, and 200
  // rows are cheap to filter locally.
  const { data, error } = await admin
    .from("conversations")
    .select("id, assigned_agent_id, last_message_at, contact:contacts(id, name, phone)")
    .eq("account_id", ctx.accountId)
    .order("last_message_at", { ascending: false, nullsFirst: true })
    .limit(limit);
  if (error) {
    console.error("[inbox/assignable] list failed:", error.message);
    return NextResponse.json(
      { error: "Could not load conversations." },
      { status: 500 }
    );
  }
  const conversations = ((data ?? []) as Array<{
    id: string;
    assigned_agent_id: string | null;
    last_message_at: string | null;
    contact: { id: string; name: string | null; phone: string | null } | Array<{ id: string; name: string | null; phone: string | null }> | null;
  }>).map((c) => {
    const contact = Array.isArray(c.contact) ? c.contact[0] ?? null : c.contact;
    return {
      id: c.id,
      assigned_agent_id: c.assigned_agent_id ?? null,
      last_message_at: c.last_message_at ?? null,
      contact: contact
        ? { id: contact.id, name: contact.name, phone: contact.phone }
        : null,
    };
  });
  return NextResponse.json({ conversations });
}
