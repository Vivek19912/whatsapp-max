import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { countDistinctMetaTablesForContact } from "@/lib/inbox/assignment-sync";

// ============================================================
// GET /api/inbox/conversations/[id]/meta-tables — Inbox safety gate
// read model for the Assign control.
//
// Returns the DISTINCT Meta Lead Ads table count for the
// conversation's contact so the thread header can disable Inbox
// reassignment when the contact spans multiple tables. Read-only:
// never writes. Account-scoped; foreign conversations 404.
// ============================================================

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  const admin = supabaseAdmin();
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("id, contact_id")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (convErr || !conv) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  const contactId = (conv as { contact_id: string | null }).contact_id ?? null;
  if (!contactId) {
    return NextResponse.json({
      distinctMetaTables: 0,
      blocked: false,
      checkFailed: false,
    });
  }

  const tableCheck = await countDistinctMetaTablesForContact(
    admin as never,
    ctx.accountId,
    contactId,
  );
  if (tableCheck.error) {
    return NextResponse.json({
      distinctMetaTables: 0,
      blocked: true,
      checkFailed: true,
    });
  }

  return NextResponse.json({
    distinctMetaTables: tableCheck.count,
    blocked: tableCheck.count > 1,
    checkFailed: false,
  });
}
