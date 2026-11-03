import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccountRole } from "@/lib/auth/roles";

// ============================================================
// Inbox assignment-based visibility — single source of truth for
// "may this user see this conversation", shared by client guards
// (realtime removal, team-filter options, hydrate checks) and
// mirrored 1:1 by the RLS policies in
// supabase/migrations/148_inbox_assignment_access.sql.
//
// Rule (keep in sync with that migration):
//   - owner / admin : every thread in their account.
//   - agent         : only threads assigned to themselves.
//                     Unassigned threads are invisible to agents.
//   - viewer        : preserved legacy read-all (read-only role;
//                     directory-level reads elsewhere already assume
//                     account-wide visibility).
// Never keyed on names, emails, or phone numbers — only the stable
// profiles.user_id stored in assigned_agent_id.
// ============================================================

// ============================================================
// Inbox assignment-based visibility — single source of truth for
// "may this user see this conversation", shared by client guards
// (realtime removal, team-filter options, hydrate checks) and
// mirrored 1:1 by the RLS policies in
// supabase/migrations/148_inbox_assignment_access.sql (+ the
// view_all branch added by 149_agent_inbox_permissions.sql).
//
// Base rule (no granted permissions):
//   - owner / admin : every thread in their account.
//   - agent         : only threads assigned to themselves.
//                     Unassigned threads are invisible to agents.
//   - viewer        : preserved legacy read-all (read-only role;
//                     directory-level reads elsewhere already assume
//                     account-wide visibility).
// Granted permissions (agent_inbox_permissions, owner-managed):
//   - can_view_all         : agent sees every thread (read-only).
//   - can_manage_assignments: agent may (un)assign any thread
//                     (write-only; grants no read access by itself).
// Never keyed on names, emails, or phone numbers — only the stable
// profiles.user_id stored in assigned_agent_id.
// ============================================================

export interface AssignmentViewer {
  role?: AccountRole | string | null;
  userId?: string | null;
}

/** Per-agent capability flags resolved server-side (or via /me). */
export interface InboxViewerCaps {
  canViewAll: boolean;
  canManageAssignments: boolean;
}

export const NO_INBOX_CAPS: InboxViewerCaps = {
  canViewAll: false,
  canManageAssignments: false,
};

export function canViewConversation(
  viewer: AssignmentViewer,
  assignedAgentId: string | null | undefined,
  caps: InboxViewerCaps = NO_INBOX_CAPS
): boolean {
  const { role, userId } = viewer;
  if (!role || !userId) return false;
  if (role === "owner" || role === "admin") return true;
  if (role === "viewer") return true;
  if (role !== "agent") return false;
  if (caps.canViewAll) return true;
  return assignedAgentId != null && assignedAgentId === userId;
}

/**
 * Write permission for an existing thread. Owner/admin may act on
 * anything; agents only on threads assigned to them (including
 * unassigning themselves), or on ANY thread with the manage
 * permission; viewers never. Callers gate new-thread creation
 * separately (no assignee exists yet).
 */
export function canActOnConversation(
  viewer: AssignmentViewer,
  assignedAgentId: string | null | undefined,
  caps: InboxViewerCaps = NO_INBOX_CAPS
): boolean {
  const { role, userId } = viewer;
  if (!role || !userId) return false;
  if (role === "owner" || role === "admin") return true;
  if (role !== "agent") return false;
  if (caps.canManageAssignments) return true;
  return assignedAgentId != null && assignedAgentId === userId;
}

/** Minimum role gate for creating new threads (contact-initiated sends). */
export function isAgentOrAbove(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "agent";
}

/**
 * Resolve a viewer's effective Inbox capabilities. Owners/admins get
 * everything and viewers keep legacy read-all without a row; only
 * agents consult agent_inbox_permissions (missing row = no grants).
 * Read failures fail closed (no caps). RLS on the permissions table
 * itself (own row or owner) makes this safe on any client.
 */
export async function resolveViewerCaps(
  db: SupabaseClient,
  accountId: string,
  userId: string | null | undefined,
  role: string | null | undefined
): Promise<InboxViewerCaps> {
  if (!userId) return NO_INBOX_CAPS;
  if (role === "owner" || role === "admin") {
    return { canViewAll: true, canManageAssignments: true };
  }
  if (role === "viewer") {
    return { canViewAll: true, canManageAssignments: false };
  }
  if (role !== "agent") return NO_INBOX_CAPS;
  try {
    const { data, error } = await db
      .from("agent_inbox_permissions")
      .select("can_manage_assignments, can_view_all")
      .eq("account_id", accountId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return NO_INBOX_CAPS;
    const row = data as {
      can_manage_assignments: boolean | null;
      can_view_all: boolean | null;
    };
    return {
      canViewAll: row.can_view_all === true,
      canManageAssignments: row.can_manage_assignments === true,
    };
  } catch {
    return NO_INBOX_CAPS;
  }
}

/** Filter a conversation list down to what `viewer` may see. */
export function filterVisibleConversations<T extends { assigned_agent_id?: string | null }>(
  list: readonly T[],
  viewer: AssignmentViewer,
  caps: InboxViewerCaps = NO_INBOX_CAPS
): T[] {
  return list.filter((c) => canViewConversation(viewer, c.assigned_agent_id, caps));
}
