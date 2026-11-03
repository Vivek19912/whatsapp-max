// ============================================================
// /api/inbox/conversations/[id]/hide — owner-only tenant-scoped
// hiding of one Inbox conversation (POST) and unhiding (DELETE).
//
// Hiding inserts a row into `inbox_hidden_conversations`; the thread
// disappears from Inbox surfaces that honor the hidden set while
// every underlying conversation/message/contact row is preserved.
// Unhiding deletes the row and restores visibility. Both are
// idempotent: hiding twice (or unhiding twice) succeeds without
// creating duplicates.
//
// Security: session auth via requireRole("owner") (RLS-scoped SSR
// client); the conversation must belong to the caller's account or
// the request 404s without disclosing cross-tenant existence.
// RLS policies on the table enforce the same invariant in depth.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(message = "Conversation not found.") {
  return NextResponse.json({ error: message }, { status: 404 });
}

async function resolveTenantConversation(
  supabase: Awaited<ReturnType<typeof requireRole>>["supabase"],
  accountId: string,
  id: string,
) {
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string };
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx;
  try {
    ctx = await requireRole("owner");
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;
  if (typeof id !== "string" || !UUID_RE.test(id)) return notFound();

  const conv = await resolveTenantConversation(ctx.supabase, ctx.accountId, id);
  if (!conv) return notFound();

  const { error } = await ctx.supabase
    .from("inbox_hidden_conversations")
    .upsert(
      { account_id: ctx.accountId, conversation_id: id, hidden_by: ctx.userId },
      { onConflict: "account_id,conversation_id" },
    );
  if (error) {
    console.error("[inbox/hide] upsert error:", {
      message: error.message,
      code: error.code,
    });
    return NextResponse.json(
      { error: "Could not hide conversation." },
      { status: 500 },
    );
  }
  return NextResponse.json({ hidden: true, conversation_id: id });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx;
  try {
    ctx = await requireRole("owner");
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;
  if (typeof id !== "string" || !UUID_RE.test(id)) return notFound();

  const conv = await resolveTenantConversation(ctx.supabase, ctx.accountId, id);
  if (!conv) return notFound();

  const { error } = await ctx.supabase
    .from("inbox_hidden_conversations")
    .delete()
    .eq("account_id", ctx.accountId)
    .eq("conversation_id", id);
  if (error) {
    console.error("[inbox/hide] delete error:", {
      message: error.message,
      code: error.code,
    });
    return NextResponse.json(
      { error: "Could not unhide conversation." },
      { status: 500 },
    );
  }
  return NextResponse.json({ hidden: false, conversation_id: id });
}
