// ============================================================
// Lead Assignment member eligibility (pure, client-safe).
//
// Single source of truth for "who can receive leads", shared by
// the rule form (client) and the assignment service (server) so
// the two can never disagree. Eligible = account members with
// role owner, admin, or agent. Viewers, unknown roles, and
// removed members are never eligible. The owner is always
// eligible even when they hold no explicit Admin/Agent role —
// their role is `owner`, and an explicit `is_owner`/`isOwner`
// flag (when callers supply it from accounts.owner_user_id)
// also qualifies them without changing their role or granting
// unrelated permissions. Online presence is deliberately NOT a
// signal — offline or away members stay eligible; leads are not
// realtime chats, and presence flapping must never corrupt
// distribution.
//
// Member identity is always the stable profiles.user_id, the same
// id the assignment service persists and the Team Members page
// lists — never display names or emails.
// ============================================================

export const ASSIGNABLE_ROLES = ["owner", "admin", "agent"] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Whether an account role may receive automatic lead assignments. */
export function isAssignableRole(role: unknown): role is AssignableRole {
  return role === "owner" || role === "admin" || role === "agent";
}

/** Optional owner indicator callers may supply alongside role. */
interface MaybeOwner {
  user_id: unknown;
  role: unknown;
  is_owner?: unknown;
  isOwner?: unknown;
}

/** True when the row is the account owner by explicit flag. */
function isOwnerFlag(m: MaybeOwner): boolean {
  return m.is_owner === true || m.isOwner === true;
}

/**
 * Eligible member ids in the given order (callers pass configured
 * or roster order; it is preserved). Only user_id + role (+
 * optional owner flag) are read — presence fields, if present,
 * are ignored, so offline members stay eligible.
 */
export function eligibleMemberIds<T extends { user_id: unknown; role: unknown }>(
  members: readonly T[] | null | undefined,
): string[] {
  if (!Array.isArray(members)) return [];
  const out: string[] = [];
  for (const m of members) {
    if (!m || typeof m.user_id !== "string" || m.user_id === "") continue;
    const ownerByFlag = isOwnerFlag(m as MaybeOwner);
    if (!ownerByFlag && !isAssignableRole(m.role)) continue;
    if (!out.includes(m.user_id)) out.push(m.user_id);
  }
  return out;
}
