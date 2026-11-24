import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { isRunOwnedByUser } from "@/lib/flows/workspace-ownership";
import {
  validateWorkspaceValue,
  type WorkspaceField,
} from "@/lib/flows/workspace-fields";
import {
  isAssigneeField,
  validateAssigneeValue,
} from "@/lib/flows/workspace-assignee";
import { isLeadQualityField } from "@/lib/flows/workspace-defaults";
import { recordWorkspaceStatusChanged } from "@/lib/meta-capi/triggers";

/**
 * PUT /api/flows/[id]/workspace-values — set or clear ONE custom
 * cell. Agent+ (operational data). Empty/null clears the cell
 * (deletes the value row); defaults are read-time fallbacks and
 * are never written here, so history is never rewritten.
 * Flow vars/node config are never touched — only workspace_values.
 *
 * "Assigned To" cells store the stable member user_id (or the
 * structural "Unassigned"), validated against the live account
 * roster (profiles for this account — the Team Members source of
 * truth). Existing legacy/removed assignments are preserved on
 * read and never rewritten here.
 */

async function loadField(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
  fieldId: string,
): Promise<WorkspaceField | null> {
  const { data, error } = await supabase
    .from("workspace_fields")
    .select("*")
    .eq("id", fieldId)
    .eq("account_id", accountId)
    .eq("flow_id", flowId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    flow_id: row.flow_id as string,
    name: row.name as string,
    field_type: row.field_type as WorkspaceField["field_type"],
    position: row.position as number,
    options: (row.options as string[] | null) ?? null,
    default_value: (row.default_value as string | null) ?? null,
    currency_code: (row.currency_code as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export async function PUT(
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
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { field_id: fieldId, flow_run_id: runId, value } = body;
    if (typeof fieldId !== "string" || !fieldId) {
      return NextResponse.json({ error: "field_id is required." }, { status: 400 });
    }
    if (typeof runId !== "string" || !runId) {
      return NextResponse.json({ error: "flow_run_id is required." }, { status: 400 });
    }
    // Explicit dropdown selection only: the Lead Quality editor
    // passes triggerCrmEvent when the salesperson picks an option.
    // Programmatic saves (imports, syncs, retries) omit it and
    // stay send-free, as do clears and unchanged re-saves below.
    const triggerCrmEvent = body.triggerCrmEvent === true;

    const field = await loadField(supabase, accountId, id, fieldId);
    if (!field) {
      return NextResponse.json({ error: "Column not found." }, { status: 404 });
    }
    // The run must belong to this account (and this flow — a cell
    // cannot be attached across flows).
    const { data: run, error: runErr } = await supabase
      .from("flow_runs")
      .select("id, account_id, flow_id, contact_id")
      .eq("id", runId)
      .maybeSingle();
    if (runErr) throw runErr;
    const typed = run as {
      account_id: string;
      flow_id: string;
      contact_id: string | null;
    } | null;
    if (!typed || typed.account_id !== accountId || typed.flow_id !== id) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }

    // Agents on Meta Lead Ads Tables may only write their own
    // assigned leads — and never the Assigned To cell itself, unless
    // they hold the Manage Assignments permission (which grants
    // cross-lead assignment from Workspace exactly like the Inbox
    // assign API). Owners/admins and every Flow Table keep existing
    // behavior exactly.
    if (role === "agent") {
      const { data: kindRow } = await supabase
        .from("flows")
        .select("kind")
        .eq("id", id)
        .eq("account_id", accountId)
        .maybeSingle();
      if ((kindRow as { kind?: string | null } | null)?.kind === "meta_lead_ads") {
        const { resolveViewerCaps } = await import(
          "@/lib/inbox/assignment-access"
        );
        const caps = await resolveViewerCaps(supabase, accountId, userId, role);
        if (!caps.canManageAssignments) {
          const owned = await isRunOwnedByUser(supabase, {
            accountId,
            flowId: id,
            runId,
            userId,
          });
          if (!owned) {
            return NextResponse.json({ error: "Run not found." }, { status: 404 });
          }
          if (isAssigneeField(field)) {
            return NextResponse.json(
              { error: "Only admins or agents with Manage Assignments can reassign leads." },
              { status: 403 },
            );
          }
        }
      }
    }

    let stored: string | null;
    try {
      if (isAssigneeField(field)) {
        // "Assigned To" stores the stable member user_id (or the
        // structural "Unassigned"), validated against the CURRENT
        // account roster — the same profiles rows shown in
        // Settings → Team Members. Account-scoped via the
        // account_id filter (RLS scopes it too); never another
        // account's members, never bare auth.users rows. Legacy
        // display strings are preserved on read but rejected for
        // new writes; removed members stop being selectable while
        // their existing rows are left untouched.
        const { data: roster, error: rosterErr } = await supabase
          .from("profiles")
          .select("user_id")
          .eq("account_id", accountId);
        if (rosterErr) throw rosterErr;
        const memberIds = new Set(
          ((roster ?? []) as Array<{ user_id: string }>).map((r) => r.user_id),
        );
        stored = validateAssigneeValue(value, memberIds);
      } else {
        // Lead Quality columns provisioned before "Lead" became an
        // explicit option still carry the four-outcome option set.
        // Accept the canonical "Lead" display default for them (no
        // migration, no option rewrite): chips already cover it and
        // the CRM mapper accepts it. Every other value still
        // validates exactly against the stored options.
        const rawValue = typeof value === "string" ? value.trim() : value;
        const allowLeadDefault =
          isLeadQualityField(field) && rawValue === "Lead";
        stored = allowLeadDefault
          ? "Lead"
          : validateWorkspaceValue(field.field_type, field.options, value);
      }
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid value." },
        { status: 400 },
      );
    }

    // Current stored value, so a Conversions API trigger only fires on
    // a genuine CHANGE (never on a re-save of the same value).
    const { data: existingRow, error: existingErr } = await supabase
      .from("workspace_values")
      .select("value_text")
      .eq("field_id", fieldId)
      .eq("flow_run_id", runId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (existingErr) throw existingErr;
    const previous =
      (existingRow as { value_text: string | null } | null)?.value_text ?? null;

    if (stored === null) {
      const { error } = await supabase
        .from("workspace_values")
        .delete()
        .eq("field_id", fieldId)
        .eq("flow_run_id", runId)
        .eq("account_id", accountId);
      if (error) throw error;
      // ADDITIVE Meta Sheets sync — a Workspace cell was cleared on a
      // Meta table; queue an in-place sheet row update. Flow Tables
      // never reach this branch (kind gate). Best-effort: never fails
      // the save. Uses the service-role client for the queue write:
      // the queue's RLS policy only allows admin inserts, so the
      // user-scoped client of an authorized agent edit would be
      // denied (and the UI would falsely look synced). Server-side
      // validation above (run belongs to this account + flow, agent
      // ownership) already authorizes this exact (account, run)
      // pair, so the elevated client cannot reach other tenants.
      let sheetsSync: 'queued' | 'failed' = 'failed';
      try {
        const { enqueueSheetsSyncForRun } = await import(
          "@/lib/meta-lead-sheets/queue"
        );
        const { data: kindRow } = await supabase
          .from("flows")
          .select("kind")
          .eq("id", id)
          .eq("account_id", accountId)
          .maybeSingle();
        if ((kindRow as { kind?: string | null } | null)?.kind === "meta_lead_ads") {
          const queued = await enqueueSheetsSyncForRun(supabaseAdmin(), {
            accountId,
            runId,
          });
          sheetsSync = queued.enqueued ? 'queued' : 'failed';
          // Prompt post-response drain (tracked `after()`, never a
          // detached promise); the cron remains the fallback.
          const { scheduleSheetsDrainSoon } = await import(
            "@/lib/meta-lead-sheets/trigger"
          );
          scheduleSheetsDrainSoon({ accountId });
        }
      } catch (err) {
        console.error("[meta-sheets] cell-clear enqueue failed:", err);
      }
      // ADDITIVE Inbox mirror — clearing the Assigned To cell clears
      // the linked thread's assignee the same way. Best-effort.
      // Uses the service-role client (like the Sheets sync above):
      // the conversations RLS update gate requires the old row to
      // be visible, so an authorized agent's user-scoped client
      // would be denied on threads assigned to someone else (and
      // the UI would falsely look synced). The (account, run) pair
      // is already server-side validated above, and the mirror
      // re-scopes every statement by account.
      if (isAssigneeField(field)) {
        try {
          const { mirrorRunAssignmentToConversation } = await import(
            "@/lib/inbox/assignment-sync"
          );
          await mirrorRunAssignmentToConversation(supabaseAdmin(), accountId, runId, null);
        } catch (err) {
          console.error("[inbox/workspace-values] mirror failed:", err);
        }
      }
      return NextResponse.json({ value: null, sheetsSync });
    }

    const { data, error } = await supabase
      .from("workspace_values")
      .upsert(
        {
          account_id: accountId,
          field_id: fieldId,
          flow_run_id: runId,
          value_text: stored,
        },
        { onConflict: "field_id,flow_run_id" },
      )
      .select("value_text")
      .single();
    if (error) throw error;
    const storedValue = (data as { value_text: string | null }).value_text;

    // ADDITIVE Meta Conversions API hook — best-effort and isolated so it
    // can never fail the save. The shared helper fires only when the value
    // actually changed to a new, non-empty value.
    try {
      await recordWorkspaceStatusChanged(supabaseAdmin(), {
        accountId,
        flowRunId: runId,
        contactId: typed.contact_id,
        fieldName: field.name,
        previousValue: previous,
        newValue: storedValue,
      });
    } catch (err) {
      console.error("[meta-capi] workspace trigger failed:", err);
    }

    // Meta CRM feedback — AUTOMATIC send on explicit Lead Quality
    // selection. Saving a status through the Lead Quality dropdown
    // (triggerCrmEvent: true) enqueues the mapped event through the
    // EXISTING durable outbox (same ledger, same UNIQUE dedup, same
    // drain); selecting, clearing, or re-saving without the flag
    // never enqueues. No new pipeline, no second send path: gated
    // states (disabled, unmapped, non-Meta, unselected table) only
    // store the status, and duplicates resolve to the recorded
    // delivery state instead of a new Meta request.
    type SaveCrmEvent =
      | { state: "queued"; eventName: string; message: string }
      | {
          state: "duplicate";
          eventName: string;
          deliveryStatus: "pending" | "sent" | "failed" | "skipped";
          message: string;
        }
      | { state: "blocked"; reason: string; message: string };
    let crmEvent: SaveCrmEvent | null = null;
    if (
      isLeadQualityField(field) &&
      storedValue !== null &&
      storedValue !== previous &&
      triggerCrmEvent
    ) {
      try {
        const { enqueueLeadQualityEvent } = await import("@/lib/meta-crm/feedback");
        const outcome = await enqueueLeadQualityEvent(supabaseAdmin(), {
          accountId,
          flowId: id,
          runId,
          fromQuality: previous ?? "",
          toQuality: storedValue,
          eventTimeIso: new Date().toISOString(),
          actorUserId: userId,
        });
        if (outcome.enqueued && !outcome.deduplicated) {
          const { scheduleCrmDrainSoon } = await import("@/lib/meta-crm/trigger");
          scheduleCrmDrainSoon({ accountId, eventIds: [outcome.eventId] });
          crmEvent = {
            state: "queued",
            eventName: storedValue,
            message: "Event queued for delivery to Meta.",
          };
        } else if (outcome.enqueued) {
          // Duplicate transition: no new event, no Meta request —
          // report the RECORDED delivery state instead.
          const { data: existing } = await supabase
            .from("meta_crm_events")
            .select("status")
            .eq("account_id", accountId)
            .eq("id", outcome.eventId)
            .maybeSingle();
          const recorded = (existing as { status?: unknown } | null)?.status;
          const deliveryStatus =
            recorded === "sent" ||
            recorded === "pending" ||
            recorded === "failed" ||
            recorded === "skipped"
              ? recorded
              : "pending";
          crmEvent = {
            state: "duplicate",
            eventName: storedValue,
            deliveryStatus,
            message:
              deliveryStatus === "sent"
                ? `${storedValue} has already been sent to Meta for this lead.`
                : deliveryStatus === "pending"
                  ? `${storedValue} is already queued for delivery to Meta.`
                  : `${storedValue} was already recorded (${deliveryStatus}).`,
          };
        } else if (outcome.reason === "table_not_selected") {
          const { TABLE_NOT_SELECTED_MESSAGE } = await import("@/lib/meta-crm/feedback");
          crmEvent = {
            state: "blocked",
            reason: outcome.reason,
            message: TABLE_NOT_SELECTED_MESSAGE,
          };
        } else {
          // disabled / unmapped / no_meta_lead: status saves, nothing
          // to report — the UI shows the plain saved state.
          crmEvent = { state: "blocked", reason: outcome.reason, message: "" };
        }
      } catch (err) {
        console.error("[meta-crm] workspace auto-send enqueue failed:", err);
      }
    }

    // ADDITIVE Meta Sheets sync — a Workspace cell changed on a Meta
    // table; queue an in-place sheet row update. Meta-only (kind
    // gate); Flow Tables skip this entirely. Best-effort: never
    // fails the save. Uses the service-role client for the queue
    // write (see the clear path above): the queue's RLS policy only
    // allows admin inserts, so an authorized agent's user-scoped
    // client would be denied and the UI would falsely look synced.
    // The (account, run) pair is already server-side validated
    // above, so no other tenant is reachable.
    let sheetsSync: 'queued' | 'skipped' | 'failed' = 'skipped';
    try {
      const { enqueueSheetsSyncForRun } = await import(
        "@/lib/meta-lead-sheets/queue"
      );
      const { data: kindRow } = await supabase
        .from("flows")
        .select("kind")
        .eq("id", id)
        .eq("account_id", accountId)
        .maybeSingle();
      if ((kindRow as { kind?: string | null } | null)?.kind === "meta_lead_ads") {
        if (storedValue !== previous) {
          const queued = await enqueueSheetsSyncForRun(supabaseAdmin(), {
            accountId,
            runId,
          });
          sheetsSync = queued.enqueued ? 'queued' : 'failed';
          // Prompt post-response drain (tracked `after()`, never a
          // detached promise); the cron remains the fallback.
          const { scheduleSheetsDrainSoon } = await import(
            "@/lib/meta-lead-sheets/trigger"
          );
          scheduleSheetsDrainSoon({ accountId });
        }
      }
    } catch (err) {
      console.error("[meta-sheets] cell-save enqueue failed:", err);
      sheetsSync = 'failed';
    }

    // ADDITIVE Inbox mirror — an Assigned To edit (any Workspace
    // table, Meta or Flow) applies the same owner to the linked
    // thread so the conversation header/list match the Workspace
    // column. Best-effort: never fails the save. Service-role
    // client (same RLS rationale as the clear path above).
    if (isAssigneeField(field)) {
      try {
        const { mirrorRunAssignmentToConversation } = await import(
          "@/lib/inbox/assignment-sync"
        );
        await mirrorRunAssignmentToConversation(
          supabaseAdmin(),
          accountId,
          runId,
          storedValue,
        );
      } catch (err) {
        console.error("[inbox/workspace-values] mirror failed:", err);
      }
    }

    return NextResponse.json({ value: storedValue, sheetsSync, crmEvent });
  } catch (err) {
    return toErrorResponse(err);
  }
}
