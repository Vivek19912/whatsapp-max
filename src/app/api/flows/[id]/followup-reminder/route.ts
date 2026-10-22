import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { canManageReminder } from "@/lib/followups/ownership";
import {
  normalizeAgentWhatsappNumber,
  validateFollowupInput,
} from "@/lib/followups/types";
import {
  buildWorkspaceFollowupMessage,
  isWorkspaceFollowupFieldName,
  WORKSPACE_FOLLOWUP_SOURCE_KIND,
} from "@/lib/followups/workspace-link";
import { isRunOwnedByUser } from "@/lib/flows/workspace-ownership";

/**
 * POST /api/flows/[id]/followup-reminder — create or update the ONE
 * reminder linked to a lead's Workspace "Next Follow-up Date &
 * Time" cell. Agent+.
 *
 * META LEAD ADS TABLES ONLY: the flow must be kind
 * 'meta_lead_ads' (Flow Tables get a 404, exactly like the other
 * Meta-only Workspace endpoints). Everything else reuses the
 * existing whatsapp_followups system — same table, same
 * scheduled/failed/cancelled lifecycle, same scheduler and
 * delivery (which sends to the creator's WhatsApp number, never
 * to the lead).
 *
 * Idempotent per lead: an open linked reminder (scheduled, or a
 * failed one being re-armed) is updated in place; sent/cancelled
 * history is never rewritten. A unique-violation race between two
 * concurrent inserts falls back to updating the winner's row.
 */

interface LinkRow {
  id: string;
  status: string;
  created_by: string | null;
}

async function loadFlow(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
) {
  const { data, error } = await supabase
    .from("flows")
    .select("id, account_id, kind")
    .eq("id", flowId)
    .maybeSingle();
  if (error) throw error;
  const flow = data as {
    id: string;
    account_id: string;
    kind: string | null;
  } | null;
  if (!flow || flow.account_id !== accountId) return null;
  return flow;
}

async function loadRun(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
  runId: string,
) {
  const { data, error } = await supabase
    .from("flow_runs")
    .select("id, account_id, flow_id")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  const run = data as {
    id: string;
    account_id: string;
    flow_id: string;
  } | null;
  if (!run || run.account_id !== accountId || run.flow_id !== flowId) {
    return null;
  }
  return run;
}

/** The canonical follow-up column for this Meta table, if present. */
async function loadFollowupField(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
) {
  const { data, error } = await supabase
    .from("workspace_fields")
    .select("id, name, field_type")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (error) throw error;
  const fields = (data ?? []) as Array<{
    id: string;
    name: string;
    field_type: string;
  }>;
  return (
    fields.find(
      (f) =>
        f.field_type === "datetime" && isWorkspaceFollowupFieldName(f.name),
    ) ?? null
  );
}

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

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function findOpenLink(
  supabase: SupabaseClient,
  accountId: string,
  runId: string,
): Promise<LinkRow | null> {
  const { data, error } = await supabase
    .from("whatsapp_followups")
    .select("id, status, created_by")
    .eq("account_id", accountId)
    .eq("source_kind", WORKSPACE_FOLLOWUP_SOURCE_KIND)
    .eq("source_run_id", runId)
    .in("status", ["scheduled", "failed", "processing"])
    .maybeSingle();
  if (error) throw error;
  return (data as LinkRow | null) ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return bad("Invalid JSON body.");
    }
    const runId = body.flow_run_id;
    const scheduledFor = body.scheduled_for;
    if (typeof runId !== "string" || !runId) {
      return bad("flow_run_id is required.");
    }
    if (typeof scheduledFor !== "string" || !scheduledFor) {
      return bad("scheduled_for is required.");
    }

    const flow = await loadFlow(supabase, accountId, id);
    if (!flow || flow.kind !== "meta_lead_ads") {
      return bad("Not found.", 404);
    }
    const run = await loadRun(supabase, accountId, id, runId);
    if (!run) {
      return bad("Run not found.", 404);
    }
    const field = await loadFollowupField(supabase, accountId, id);
    if (!field) {
      return bad(
        "The Next Follow-up Date & Time column is not available on this table.",
      );
    }
    // Agents may only manage reminders for their own assigned
    // leads (same not-found shape as a foreign run).
    if (role === "agent") {
      const owned = await isRunOwnedByUser(supabase, {
        accountId,
        flowId: id,
        runId,
        userId,
      });
      if (!owned) return bad("Run not found.", 404);
    }

    // The reminder must match the persisted cell value — never a
    // stale dialog payload. The cell save already normalized the
    // instant to ISO, so this is an exact comparison.
    const { data: storedRow, error: storedErr } = await supabase
      .from("workspace_values")
      .select("value_text")
      .eq("field_id", field.id)
      .eq("flow_run_id", runId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (storedErr) throw storedErr;
    const stored = (storedRow as { value_text: string | null } | null)
      ?.value_text;
    if (!stored || stored !== scheduledFor) {
      return bad(
        "The follow-up changed. Refresh the table and select the date and time again.",
        409,
      );
    }

    const rawMessage = body.message;
    const messageText =
      typeof rawMessage === "string" && rawMessage.trim() !== ""
        ? rawMessage
        : buildWorkspaceFollowupMessage({
            name:
              typeof body.lead_name === "string" ? body.lead_name : null,
            phone:
              typeof body.lead_phone === "string" ? body.lead_phone : null,
          });

    let input;
    try {
      // contact_id is always NULL (personal reminder); past times
      // are rejected, never silently shifted — same rules as the
      // Reminders page.
      input = validateFollowupInput({
        contact_id: null,
        scheduled_for: scheduledFor,
        message_text: messageText,
      });
    } catch (err) {
      return bad(err instanceof Error ? err.message : "Invalid input.");
    }

    const recipient_phone = await loadAgentRecipientPhone(supabase, userId);
    if (!recipient_phone) {
      return bad(
        "Add your WhatsApp number in Settings → Reminder WhatsApp Number before creating a reminder.",
      );
    }

    const existing = await findOpenLink(supabase, accountId, runId);
    if (existing) {
      if (existing.status === "processing") {
        return bad(
          "The reminder is being sent right now. Try again in a moment.",
          409,
        );
      }
      if (!canManageReminder(role, existing, userId)) {
        return bad(
          "Only the reminder creator or an admin can change it.",
          403,
        );
      }
      const { data, error } = await supabase
        .from("whatsapp_followups")
        .update({
          scheduled_for: input.scheduled_for,
          message_text: input.message_text,
          status: "scheduled",
          failure_reason: null,
          failed_at: null,
        })
        .eq("id", existing.id)
        .eq("account_id", accountId)
        .select("id, scheduled_for, message_text, status")
        .single();
      if (error) throw error;
      const row = data as Record<string, unknown>;
      return NextResponse.json({
        reminder: {
          id: row.id,
          scheduled_for: row.scheduled_for,
          message_text: row.message_text,
          status: row.status,
          created: false,
        },
      });
    }

    const { data, error } = await supabase
      .from("whatsapp_followups")
      .insert({
        account_id: accountId,
        recipient_phone,
        contact_id: null,
        conversation_id: null,
        scheduled_for: input.scheduled_for,
        message_text: input.message_text,
        template_name: null,
        template_language: null,
        status: "scheduled",
        created_by: userId,
        source_kind: WORKSPACE_FOLLOWUP_SOURCE_KIND,
        source_run_id: runId,
      })
      .select("id, scheduled_for, message_text, status")
      .single();
    if (error) {
      // Lost a concurrent insert race: the winner's row is now the
      // link target — update it instead of duplicating.
      const code = (error as { code?: unknown }).code;
      if (code === "23505") {
        const winner = await findOpenLink(supabase, accountId, runId);
        if (winner && winner.status !== "processing") {
          if (!canManageReminder(role, winner, userId)) {
            return bad(
              "Only the reminder creator or an admin can change it.",
              403,
            );
          }
          const { data: updated, error: updateErr } = await supabase
            .from("whatsapp_followups")
            .update({
              scheduled_for: input.scheduled_for,
              message_text: input.message_text,
              status: "scheduled",
              failure_reason: null,
              failed_at: null,
            })
            .eq("id", winner.id)
            .eq("account_id", accountId)
            .select("id, scheduled_for, message_text, status")
            .single();
          if (updateErr) throw updateErr;
          const row = updated as Record<string, unknown>;
          return NextResponse.json({
            reminder: {
              id: row.id,
              scheduled_for: row.scheduled_for,
              message_text: row.message_text,
              status: row.status,
              created: false,
            },
          });
        }
      }
      throw error;
    }
    const row = data as Record<string, unknown>;
    return NextResponse.json(
      {
        reminder: {
          id: row.id,
          scheduled_for: row.scheduled_for,
          message_text: row.message_text,
          status: row.status,
          created: true,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/flows/[id]/followup-reminder — cancel the linked
 * reminder after its follow-up cell was cleared. Agent+.
 *
 * Only a still-scheduled reminder is cancelled. Sent, failed,
 * processing, and cancelled rows are never touched (a sent
 * reminder is history; a failed one stays visible in the
 * Reminders page). Manual reminders (no source link) can never
 * match.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return bad("Invalid JSON body.");
    }
    const runId = body.flow_run_id;
    if (typeof runId !== "string" || !runId) {
      return bad("flow_run_id is required.");
    }

    const flow = await loadFlow(supabase, accountId, id);
    if (!flow || flow.kind !== "meta_lead_ads") {
      return bad("Not found.", 404);
    }
    const run = await loadRun(supabase, accountId, id, runId);
    if (!run) {
      return bad("Run not found.", 404);
    }
    if (role === "agent") {
      const owned = await isRunOwnedByUser(supabase, {
        accountId,
        flowId: id,
        runId,
        userId,
      });
      if (!owned) return bad("Run not found.", 404);
    }

    const { data, error } = await supabase
      .from("whatsapp_followups")
      .select("id, status, created_by")
      .eq("account_id", accountId)
      .eq("source_kind", WORKSPACE_FOLLOWUP_SOURCE_KIND)
      .eq("source_run_id", runId)
      .eq("status", "scheduled")
      .maybeSingle();
    if (error) throw error;
    const row = (data as LinkRow | null) ?? null;
    if (!row) {
      return NextResponse.json({ cancelled: false });
    }
    if (!canManageReminder(role, row, userId)) {
      return bad("Only the reminder creator or an admin can change it.", 403);
    }
    const { error: cancelErr } = await supabase
      .from("whatsapp_followups")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("account_id", accountId);
    if (cancelErr) throw cancelErr;
    return NextResponse.json({ cancelled: true, id: row.id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
