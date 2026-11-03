import type { SupabaseClient } from "@supabase/supabase-js";

import { findAssigneeField } from "@/lib/lead-assignment/table-helpers";
import { ASSIGNED_TO_UNASSIGNED } from "@/lib/flows/workspace-assignee";

// ============================================================
// Workspace <-> Inbox assignment sync.
//
// Workspace ownership lives in `workspace_values.value_text` (member
// user_id | "Unassigned" | cleared) per (field, flow_run). Inbox
// visibility lives in `conversations.assigned_agent_id`. The two
// stores describe the SAME human decision, so every writer mirrors
// to the other side (best-effort — a mirror failure must never fail
// the primary write; callers log and continue).
//
// Relationship used in both directions (stable, account-scoped, no
// phone matching):
//   flow_runs (id) -> contact_id -> conversations (one thread per
//   (account_id, contact_id) — migration 062 unique index).
// A Meta run links to its thread through its contact, never through
// flow_runs.conversation_id (always NULL for Meta runs).
// ============================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Workspace -> Inbox: after the Assigned To cell for `runId` becomes
 * `stored` ("Unassigned"/null clears, member user_id assigns), apply
 * the same value to the linked conversation's `assigned_agent_id`.
 * Legacy display strings can never land in the UUID column — they
 * map to null (clear). Resolves true when there was nothing to do
 * (no contact / no thread yet — e.g. assigned at ingestion before
 * the first WhatsApp message creates the thread).
 */
export async function mirrorRunAssignmentToConversation(
  db: SupabaseClient,
  accountId: string,
  runId: string,
  stored: string | null,
): Promise<boolean> {
  try {
    const { data: run, error: runErr } = await db
      .from("flow_runs")
      .select("contact_id")
      .eq("id", runId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (runErr) return false;
    const contactId = (run as { contact_id: string | null } | null)?.contact_id;
    // No linked contact (or run already gone): nothing to mirror.
    if (!run || !contactId) return true;

    const { data: conv, error: convErr } = await db
      .from("conversations")
      .select("id")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .maybeSingle();
    if (convErr || !conv) return true;
    const conversationId = (conv as { id: string }).id;

    const assignedAgentId =
      typeof stored === "string" &&
      stored !== ASSIGNED_TO_UNASSIGNED &&
      UUID_RE.test(stored.trim())
        ? stored.trim()
        : null;

    const { error: updateErr } = await db
      .from("conversations")
      .update({ assigned_agent_id: assignedAgentId })
      .eq("id", conversationId)
      .eq("account_id", accountId);
    if (updateErr) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Inbox -> Workspace: after a conversation is (un)assigned, write the
 * same owner into the contact's active flow run's Assigned To cell
 * (active run first, else most recent — the same resolution the
 * Inbox flow filter uses). `agentId` null clears the cell (row
 * delete, mirroring the Workspace Clear action). Returns false when
 * there is nothing to mirror to (no run, or the run's flow has no
 * Assigned To column) — the Inbox write itself is unaffected.
 *
 * The caller validates membership (400 on non-members); every query
 * below is additionally account-scoped, so cross-account writes are
 * impossible even if miscalled.
 */
export async function mirrorConversationAssignmentToWorkspace(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  agentId: string | null,
): Promise<boolean> {
  try {
    const { data: conv, error: convErr } = await db
      .from("conversations")
      .select("contact_id")
      .eq("id", conversationId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (convErr || !conv) return false;
    const contactId = (conv as { contact_id: string | null }).contact_id;
    if (!contactId) return false;

    const { data: runs, error: runsErr } = await db
      .from("flow_runs")
      .select("id, flow_id, status, started_at")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .order("started_at", { ascending: false })
      .limit(25);
    if (runsErr) return false;
    const list = (runs ?? []) as Array<{
      id: string;
      flow_id: string;
      status: string;
      started_at: string;
    }>;
    if (list.length === 0) return true;
    const active = list.filter((r) => r.status === "active");
    const newest = (a: (typeof list)[number], b: (typeof list)[number]) =>
      a.started_at >= b.started_at ? a : b;
    const picked = (active.length > 0 ? active : list).reduce(newest);

    const field = await findAssigneeField(db, accountId, picked.flow_id);
    if (!field) return true;

    if (agentId === null) {
      const { error } = await db
        .from("workspace_values")
        .delete()
        .eq("account_id", accountId)
        .eq("field_id", field.id)
        .eq("flow_run_id", picked.id);
      return !error;
    }

    const { error } = await db.from("workspace_values").upsert(
      {
        account_id: accountId,
        field_id: field.id,
        flow_run_id: picked.id,
        value_text: agentId,
      },
      { onConflict: "field_id,flow_run_id" },
    );
    return !error;
  } catch {
    return false;
  }
}

/**
 * Adopt-on-thread-open: when a conversation is newly created, copy
 * the contact's current Workspace owner (if any) onto it. Covers
 * leads assigned at ingestion/auto-assign whose thread only opens
 * later. Only sets a real member UUID; "Unassigned"/legacy/cleared
 * leave the fresh thread unassigned. Best-effort.
 */
export async function adoptContactAssignmentForConversation(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const { data: runs, error: runsErr } = await db
      .from("flow_runs")
      .select("id, status, started_at")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .order("started_at", { ascending: false })
      .limit(25);
    if (runsErr || !runs || runs.length === 0) return true;
    const list = runs as Array<{ id: string; status: string; started_at: string }>;
    const active = list.filter((r) => r.status === "active");
    const newest = (a: (typeof list)[number], b: (typeof list)[number]) =>
      a.started_at >= b.started_at ? a : b;
    const picked = (active.length > 0 ? active : list).reduce(newest);

    const { data: runDetail, error: runErr } = await db
      .from("flow_runs")
      .select("flow_id")
      .eq("id", picked.id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (runErr || !runDetail) return false;
    const flowId = (runDetail as { flow_id: string }).flow_id;

    const field = await findAssigneeField(db, accountId, flowId);
    if (!field) return true;

    const { data: cell, error: cellErr } = await db
      .from("workspace_values")
      .select("value_text")
      .eq("account_id", accountId)
      .eq("field_id", field.id)
      .eq("flow_run_id", picked.id)
      .maybeSingle();
    if (cellErr) return false;
    const stored = (cell as { value_text: string | null } | null)?.value_text ?? null;
    if (
      typeof stored !== "string" ||
      stored === ASSIGNED_TO_UNASSIGNED ||
      !UUID_RE.test(stored.trim())
    ) {
      return true;
    }

    const { error: updateErr } = await db
      .from("conversations")
      .update({ assigned_agent_id: stored.trim() })
      .eq("id", conversationId)
      .eq("account_id", accountId);
    return !updateErr;
  } catch {
    return false;
  }
}
