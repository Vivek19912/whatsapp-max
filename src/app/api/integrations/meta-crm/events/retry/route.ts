// POST /api/integrations/meta-crm/events/retry
//
// Requeue one failed/skipped CRM event for this workspace
// (admin-only). Resets it to pending with an immediate retry —
// the SAME row (same event_uuid → same Meta event_id) is resent,
// so Meta never sees a duplicate conversion. Never creates a new
// Meta event, never retries from the browser to Meta directly.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const eventId = typeof body?.event_id === "string" ? body.event_id.trim() : "";
    if (!eventId) {
      return NextResponse.json({ error: "event_id is required." }, { status: 400 });
    }

    const { data: row, error: readErr } = await ctx.supabase
      .from("meta_crm_events")
      .select("id, status")
      .eq("id", eventId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!row) {
      return NextResponse.json({ error: "Event not found." }, { status: 404 });
    }
    const status = (row as { status: string }).status;
    if (status !== "failed" && status !== "skipped") {
      return NextResponse.json(
        { error: "Only failed or skipped events can be retried." },
        { status: 400 },
      );
    }

    const { error: updateErr } = await ctx.supabase
      .from("meta_crm_events")
      .update({
        status: "pending",
        attempts: 0,
        last_error: null,
        next_retry_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .eq("account_id", ctx.accountId);
    if (updateErr) throw updateErr;

    const { scheduleCrmDrainSoon } = await import("@/lib/meta-crm/trigger");
    scheduleCrmDrainSoon({ accountId: ctx.accountId });

    return NextResponse.json({ ok: true, retried: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
