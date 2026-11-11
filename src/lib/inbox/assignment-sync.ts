import type { SupabaseClient } from "@supabase/supabase-js";

import { findAssigneeField, readAssignment } from "@/lib/lead-assignment/table-helpers";
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
 * Resolution of a contact's Workspace owner without writing
 * anything. Exactly one distinct member UUID across the contact's
 * runs → that owner; zero → `no-owner`; several → `conflict` (the
 * caller must not guess); no Assigned To column → `no-field`.
 * All queries account-scoped. Never throws.
 */
export type WorkspaceOwnerResolution =
  | { ownerId: string; reason?: undefined }
  | {
      ownerId: null;
      reason: "no-run" | "no-field" | "no-owner" | "conflict" | "error";
    };

export async function resolveWorkspaceOwnerForContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<WorkspaceOwnerResolution> {
  try {
    const { data: runs, error: runsErr } = await db
      .from("flow_runs")
      .select("id, flow_id, status, started_at")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .order("started_at", { ascending: false })
      .limit(25);
    if (runsErr) return { ownerId: null, reason: "error" };
    const list = (runs ?? []) as Array<{
      id: string;
      flow_id: string;
      status: string;
      started_at: string;
    }>;
    if (list.length === 0) return { ownerId: null, reason: "no-run" };

    // Resolve the Assigned To field per flow (cached — a contact's
    // runs almost always share one flow).
    const fieldByFlow = new Map<string, { id: string } | null>();
    const owners = new Set<string>();
    for (const run of list) {
      if (!run.flow_id) continue;
      let field = fieldByFlow.get(run.flow_id);
      if (field === undefined) {
        try {
          field = await findAssigneeField(db, accountId, run.flow_id);
        } catch {
          return { ownerId: null, reason: "error" };
        }
        fieldByFlow.set(run.flow_id, field);
      }
      if (!field) continue;
      let stored: string | null;
      try {
        stored = await readAssignment(db, accountId, field.id, run.id);
      } catch {
        return { ownerId: null, reason: "error" };
      }
      if (
        typeof stored === "string" &&
        stored.trim() !== "" &&
        stored.trim() !== ASSIGNED_TO_UNASSIGNED &&
        UUID_RE.test(stored.trim())
      ) {
        owners.add(stored.trim());
      }
    }
    if (fieldByFlow.size > 0 && [...fieldByFlow.values()].every((f) => !f)) {
      return { ownerId: null, reason: "no-field" };
    }
    if (owners.size === 0) return { ownerId: null, reason: "no-owner" };
    if (owners.size > 1) return { ownerId: null, reason: "conflict" };
    const [ownerId] = [...owners];
    return { ownerId };
  } catch {
    return { ownerId: null, reason: "error" };
  }
}

/**
 * Outcome of the strict Workspace-owner adoption. `adopted` is true
 * only when this call wrote `assigned_agent_id`; every other case
 * leaves the thread untouched. `conflict` means distinct runs name
 * different owners — the caller must not guess.
 */
export type AdoptWorkspaceOwnerOutcome =
  | { adopted: true; ownerId: string }
  | {
      adopted: false;
      reason:
        | "already-owned"
        | "no-run"
        | "no-field"
        | "no-owner"
        | "conflict"
        | "error";
    };

/**
 * Adopt the contact's Workspace owner onto a conversation that is
 * new or currently unowned. Ownership rules (never violated):
 *
 * - Only fills `assigned_agent_id IS NULL` — an explicit (manual)
 *   assignment is always preserved, including against a concurrent
 *   writer (the NULL predicate rides in the UPDATE itself).
 * - Only writes a real member UUID; "Unassigned"/legacy/cleared
 *   values are ignored.
 * - Requires exactly one distinct owner across the contact's runs;
 *   conflicting owners leave the thread unchanged (`conflict`).
 * - Everything is account-scoped. Best-effort: failures resolve to
 *   `{ adopted: false, reason: "error" }`, never throw.
 */
export async function adoptWorkspaceOwnerForConversation(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<AdoptWorkspaceOwnerOutcome> {
  try {
    const { data: conv, error: convErr } = await db
      .from("conversations")
      .select("assigned_agent_id")
      .eq("id", conversationId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (convErr) return { adopted: false, reason: "error" };
    const current = (conv as { assigned_agent_id: string | null } | null)
      ?.assigned_agent_id;
    // Never overwrite an explicit assignment (manual Inbox
    // assignment always wins over automatic adoption).
    if (typeof current === "string" && current.trim() !== "") {
      return { adopted: false, reason: "already-owned" };
    }

    const resolved = await resolveWorkspaceOwnerForContact(db, accountId, contactId);
    if (resolved.ownerId === null) {
      return { adopted: false, reason: resolved.reason };
    }
    const ownerId = resolved.ownerId;

    // Conditional write: NULL predicate in the UPDATE itself, so a
    // concurrent manual assignment between the read above and this
    // write cannot be clobbered.
    const { error: updateErr } = await db
      .from("conversations")
      .update({ assigned_agent_id: ownerId })
      .eq("id", conversationId)
      .eq("account_id", accountId)
      .is("assigned_agent_id", null);
    if (updateErr) return { adopted: false, reason: "error" };
    return { adopted: true, ownerId };
  } catch {
    return { adopted: false, reason: "error" };
  }
}
/**
 * Adopt-on-thread-open: when a conversation is newly created, copy
 * the contact's current Workspace owner (if any) onto it. Covers
 * leads assigned at ingestion/auto-assign whose thread only opens
 * later. Delegates to the strict adopter: only fills unowned
 * threads, only writes a real member UUID, never overwrites an
 * explicit assignment, and leaves conflicting owners untouched.
 * Best-effort: always resolves true/false, never throws.
 */
export async function adoptContactAssignmentForConversation(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<boolean> {
  const outcome = await adoptWorkspaceOwnerForConversation(
    db,
    accountId,
    contactId,
    conversationId,
  );
  return outcome.adopted;
}
