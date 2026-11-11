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
 * Best-effort membership check: true when `userId` is a live profile
 * in this account. External notification-only contacts (user_id NULL,
 * never in profiles) and removed members resolve false. DB errors
 * fail OPEN (return true) so a transient profiles outage never blocks
 * an otherwise valid ownership write — the route-level roster check
 * remains the hard gate.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isLiveMember(db: any, accountId: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("profiles")
      .select("user_id")
      .eq("account_id", accountId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return true;
    if (!data) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Workspace -> Inbox: after the Assigned To cell for `runId` becomes
 * `stored` ("Unassigned"/null clears, member user_id assigns), apply
 * the same value to the linked conversation's `assigned_agent_id`.
 * Legacy display strings can never land in the UUID column — they
 * map to null (clear). Resolves true when there was nothing to do
 * (no contact / no thread yet — e.g. assigned at ingestion before
 * the first WhatsApp message creates the thread).
 *
 * Direction-aware: this is the Workspace-initiated edge only. It
 * writes `conversations` directly and never calls the reverse
 * mirror, so no update loop is possible (last writer wins per row).
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

    let assignedAgentId =
      typeof stored === "string" &&
      stored !== ASSIGNED_TO_UNASSIGNED &&
      UUID_RE.test(stored.trim())
        ? stored.trim()
        : null;

    // Never orphan a thread to a removed/external user: a UUID that is
    // no longer a live profile in this account clears instead of
    // writing a dead owner (renders as unassigned, stays accessible
    // to owner/admin via RLS).
    if (assignedAgentId !== null) {
      const live = await isLiveMember(db, accountId, assignedAgentId);
      if (!live) assignedAgentId = null;
    }

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
 * same owner into the contact's Meta Lead Ads Workspace lead(s).
 * Updates EVERY Meta run for the contact that has an Assigned To
 * column (all tables), so Workspace and Inbox converge on ONE owner
 * even when a contact appears in several Meta tables. Non-Meta
 * (Flow Table) runs are left untouched.
 *
 * Direction-aware: this is the Inbox-initiated edge only. It writes
 * `workspace_values` directly and never calls the reverse mirror, so
 * no update loop is possible. Idempotent (upsert/delete by
 * (field_id, flow_run_id)); safe to retry.
 *
 * The caller validates membership (400 on non-members); every query
 * below is additionally account-scoped, so cross-account writes are
 * impossible even if miscalled. Non-UUID agentIds are rejected
 * (return false, Inbox write unaffected); removed/external users are
 * rejected the same way.
 */
export async function mirrorConversationAssignmentToWorkspace(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  agentId: string | null,
): Promise<boolean> {
  try {
    // Reject non-UUID targets (legacy display strings must never land
    // in workspace_values as an "owner" via this path).
    if (agentId !== null && !UUID_RE.test(agentId.trim())) return false;
    const normalized = agentId === null ? null : (agentId as string).trim();
    const { data: conv, error: convErr } = await db
      .from("conversations")
      .select("contact_id")
      .eq("id", conversationId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (convErr || !conv) return false;
    const contactId = (conv as { contact_id: string | null }).contact_id;
    if (!contactId) return false;
    // Removed/external users must not become Workspace owners.
    if (normalized !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const live = await isLiveMember(db as any, accountId, normalized);
      if (!live) return false;
    }

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

    // Restrict to Meta Lead Ads flows: Flow Table assignments live in
    // the same cell shape but are owned by a different engine. When
    // the contact has at least one Meta run, only Meta runs converge;
    // otherwise fall back to whatever runs exist (preserves legacy
    // single-run behavior for non-Meta contacts → no-op via no-field).
    let candidateRuns = list;
    let metaRunsIdentified = false;
    try {
      const flowIds = [...new Set(list.map((r) => r.flow_id).filter(Boolean))];
      if (flowIds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: flows } = await (db as any)
          .from("flows")
          .select("id, kind")
          .eq("account_id", accountId)
          .in("id", flowIds);
        const kindById = new Map(
          ((flows ?? []) as Array<{ id: string; kind: string | null }>).map(
            (f) => [f.id, f.kind] as const,
          ),
        );
        const metaRuns = list.filter((r) => kindById.get(r.flow_id) === "meta_lead_ads");
        // Only narrow when we positively identified Meta runs; if the
        // flows lookup failed/empty, keep the full list so the legacy
        // single-pick path still applies.
        if (metaRuns.length > 0) {
          candidateRuns = metaRuns;
          metaRunsIdentified = true;
        }
      }
    } catch {
      // Best-effort narrowing; fall through with the full list.
    }

    // Resolve the Assigned To field per flow (cached).
    // Safety: never bulk-write across multiple distinct Meta tables.
    // Inbox-originated reassignment for multi-table contacts is
    // rejected by the assign route before any write; this guard
    // protects every other caller (e.g. flow handoff) that reaches
    // the mirror directly. Single-table contacts (even with many
    // runs) converge that table's leads; multi-table contacts refuse.
    const distinctMetaFlows = new Set(
      candidateRuns.map((r) => r.flow_id).filter(Boolean),
    );
    // Only enforce when we positively narrowed to Meta runs; when the
    // flows lookup failed we kept the full list (legacy fail-open) and
    // must not newly block on it.
    if (metaRunsIdentified && distinctMetaFlows.size > 1) return false;
    const fieldByFlow = new Map<string, { id: string } | null>();
    const targets: Array<{ fieldId: string; runId: string }> = [];
    for (const run of candidateRuns) {
      if (!run.flow_id) continue;
      let field = fieldByFlow.get(run.flow_id);
      if (field === undefined) {
        try {
          field = await findAssigneeField(db, accountId, run.flow_id);
        } catch {
          return false;
        }
        fieldByFlow.set(run.flow_id, field);
      }
      if (!field) continue;
      targets.push({ fieldId: field.id, runId: run.id });
    }
    if (targets.length === 0) return true;

    if (normalized === null) {
      for (const t of targets) {
        const { error } = await db
          .from("workspace_values")
          .delete()
          .eq("account_id", accountId)
          .eq("field_id", t.fieldId)
          .eq("flow_run_id", t.runId);
        if (error) return false;
      }
      return true;
    }

    for (const t of targets) {
      const { error } = await db.from("workspace_values").upsert(
        {
          account_id: accountId,
          field_id: t.fieldId,
          flow_run_id: t.runId,
          value_text: normalized,
        },
        { onConflict: "field_id,flow_run_id" },
      );
      if (error) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Distinct Meta Lead Ads table count for a contact (Inbox safety gate).
 *
 * Counts DISTINCT `flows.id` where `flows.kind='meta_lead_ads'` among
 * the contact's account-scoped `flow_runs`. Duplicate submissions in
 * the same table count as ONE. Non-Meta (Flow Table) runs are ignored.
 * All queries account-scoped; contact matching is by stable
 * (account_id, contact_id), never names/phones. Never throws:
 * lookup failures resolve `{ count: 0, flowIds: [], error: true }` so
 * callers fail safely (block reassignment until the check succeeds).
 */
export interface MetaTableCount {
  count: number;
  flowIds: string[];
  error: boolean;
}

export async function countDistinctMetaTablesForContact(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  contactId: string,
): Promise<MetaTableCount> {
  try {
    const { data: runs, error: runsErr } = await db
      .from("flow_runs")
      .select("flow_id")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .limit(100);
    if (runsErr) return { count: 0, flowIds: [], error: true };
    const flowIds = [
      ...new Set(
        (((runs ?? []) as Array<{ flow_id: string | null }>).map((r) => r.flow_id).filter(Boolean) as string[]),
      ),
    ];
    if (flowIds.length === 0) return { count: 0, flowIds: [], error: false };
    const { data: flows, error: flowsErr } = await db
      .from("flows")
      .select("id, kind")
      .eq("account_id", accountId)
      .in("id", flowIds);
    if (flowsErr) return { count: 0, flowIds: [], error: true };
    const metaIds = [
      ...new Set(
        (((flows ?? []) as Array<{ id: string; kind: string | null }>)
          .filter((f) => f.kind === "meta_lead_ads")
          .map((f) => f.id)),
      ),
    ];
    return { count: metaIds.length, flowIds: metaIds, error: false };
  } catch {
    return { count: 0, flowIds: [], error: true };
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

    // Removed/external users must never become Inbox owners via
    // adoption: verify the resolved UUID is still a live profile.
    // Fail-closed here (no adoption) — the thread stays unowned and
    // visible to owner/admin rather than orphaned to a dead user.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const live = await isLiveMember(db as any, accountId, ownerId);
    if (!live) return { adopted: false, reason: "no-owner" };

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
