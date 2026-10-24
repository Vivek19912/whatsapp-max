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
    // assigned leads — and never the Assigned To cell itself
    // (reassignment is admin-only). Owners/admins and every Flow
    // Table keep existing behavior exactly.
    if (role === "agent") {
      const { data: kindRow } = await supabase
        .from("flows")
        .select("kind")
        .eq("id", id)
        .eq("account_id", accountId)
        .maybeSingle();
      if ((kindRow as { kind?: string | null } | null)?.kind === "meta_lead_ads") {
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
            { error: "Only admins can reassign leads." },
            { status: 403 },
          );
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
        stored = validateWorkspaceValue(field.field_type, field.options, value);
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
      // the save; Uses the RLS client (admin-insert policy scopes it
      // to this account).
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
          await enqueueSheetsSyncForRun(supabase, { accountId, runId });
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
      return NextResponse.json({ value: null });
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

    // ADDITIVE Meta Sheets sync — a Workspace cell changed on a Meta
    // table; queue an in-place sheet row update. Meta-only (kind
    // gate); Flow Tables skip this entirely. Best-effort.
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
          await enqueueSheetsSyncForRun(supabase, { accountId, runId });
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
    }

    return NextResponse.json({ value: storedValue });
  } catch (err) {
    return toErrorResponse(err);
  }
}
