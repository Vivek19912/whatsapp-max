import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  isFollowupStatus,
  normalizeAgentWhatsappNumber,
  validateFollowupInput,
  type Followup,
} from "@/lib/followups/types";

function toFollowup(row: Record<string, unknown>): Followup {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    recipient_phone: (row.recipient_phone as string | null) ?? null,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    scheduled_for: row.scheduled_for as string,
    message_text: row.message_text as string,
    template_name: (row.template_name as string | null) ?? null,
    template_language: (row.template_language as string | null) ?? null,
    status: row.status as Followup["status"],
    attempts: (row.attempts as number) ?? 0,
    whatsapp_message_id: (row.whatsapp_message_id as string | null) ?? null,
    message_id: (row.message_id as string | null) ?? null,
    sent_at: (row.sent_at as string | null) ?? null,
    delivered_at: (row.delivered_at as string | null) ?? null,
    read_at: (row.read_at as string | null) ?? null,
    cancelled_at: (row.cancelled_at as string | null) ?? null,
    failed_at: (row.failed_at as string | null) ?? null,
    failure_reason: (row.failure_reason as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Load the creating agent's stored WhatsApp number
 * (`profiles.whatsapp_number`) and normalize it to the canonical
 * digits-only form Meta expects. Returns null when the agent has
 * no (or no valid) stored number — and also when the column does
 * not exist yet (pre-migration schema): both cases fail closed at
 * the caller, never substituting another number.
 */
async function loadAgentRecipientPhone(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("whatsapp_number")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeAgentWhatsappNumber(
    (data as { whatsapp_number?: unknown }).whatsapp_number,
  );
}

/**
 * GET /api/followups?status=scheduled|sent|failed|cancelled —
 * account-scoped list for the Reminders page. Any member may read.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const status = new URL(request.url).searchParams.get("status");
    let query = supabase
      .from("whatsapp_followups")
      .select("*")
      .eq("account_id", accountId);
    if (status) {
      if (!isFollowupStatus(status)) {
        return NextResponse.json({ error: "Invalid status filter." }, { status: 400 });
      }
      query = query.eq("status", status);
    }
    const ascending = !status || status === "scheduled";
    const { data, error } = await query
      .order("scheduled_for", { ascending })
      .limit(100);
    if (error) throw error;
    // Customer context in the same round trip (no N+1): contact
    // names/phones for the listed rows only. Display context —
    // never the recipient.
    const rows = (data ?? []) as Record<string, unknown>[];
    const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))] as string[];
    const contactsById: Record<string, { name: string | null; phone: string }> = {};
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, name, phone")
        .eq("account_id", accountId)
        .in("id", contactIds);
      for (const c of (contacts ?? []) as Array<{
        id: string;
        name: string | null;
        phone: string;
      }>) {
        contactsById[c.id] = { name: c.name, phone: c.phone };
      }
    }
    return NextResponse.json({
      followups: rows.map((r) => ({
        ...toFollowup(r),
        contact_name: contactsById[r.contact_id as string]?.name ?? null,
        contact_phone: contactsById[r.contact_id as string]?.phone ?? null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/followups — schedule a reminder. Agent+.
 *
 * The reminder is delivered TO ITS CREATOR's stored WhatsApp
 * number (`profiles.whatsapp_number`), snapshotted into
 * `recipient_phone` at creation. Creation FAILS CLOSED when the
 * agent has no valid stored number — no other number may be
 * substituted. Creation carries NO customer field: any
 * `contact_id` in the body is ignored and the row stores NULL.
 * No customer conversation is created or attached.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    let input;
    try {
      // No customer field on creation: contact_id is always stored
      // as NULL regardless of what the body carries.
      input = validateFollowupInput({
        contact_id: null,
        scheduled_for: body.scheduled_for,
        message_text: body.message_text,
        template_name: body.template_name,
        template_language: body.template_language,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid input." },
        { status: 400 },
      );
    }

    // Resolve the creator's stored WhatsApp number and snapshot it.
    // Fail closed: without a valid agent number there is no
    // recipient, and NO fallback (customer / business / email) may
    // be substituted. A missing column (pre-migration schema) also
    // fails closed — the error tells the agent what to do.
    const recipient_phone = await loadAgentRecipientPhone(
      supabase,
      userId,
    );
    if (!recipient_phone) {
      return NextResponse.json(
        {
          error:
            "Add your WhatsApp number in Settings → Reminder WhatsApp Number before creating a reminder.",
        },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("whatsapp_followups")
      .insert({
        account_id: accountId,
        recipient_phone,
        contact_id: null,
        // No thread for a self-reminder: delivery goes straight to
        // the agent's number, never into a customer conversation.
        conversation_id: null,
        scheduled_for: input.scheduled_for,
        message_text: input.message_text,
        template_name: input.template_name,
        template_language: input.template_language,
        status: "scheduled",
        created_by: userId,
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json(
      { followup: toFollowup(data as Record<string, unknown>) },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
