// ============================================================
// Lead Assignment member eligibility (pure, client-safe).
//
// Single source of truth for "who can receive leads", shared by
// the rule form (client) and the assignment service (server) so
// the two can never disagree. Eligibility mirrors Chat
// Assignment's pool: account members with role admin or agent.
// Owners, viewers, unknown roles, and removed members are never
// eligible. Online presence is deliberately NOT a signal —
// offline or away agents stay eligible; leads are not realtime
// chats, and presence flapping must never corrupt distribution.
//
// Member identity is always the stable profiles.user_id, the same
// id the assignment service persists and the Team Members page
// lists — never display names or emails.
// ============================================================

export const ASSIGNABLE_ROLES = ["admin", "agent"] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Whether an account role may receive automatic lead assignments. */
export function isAssignableRole(role: unknown): role is AssignableRole {
  return role === "admin" || role === "agent";
}

/**
 * Eligible member ids in the given order (callers pass configured
 * or roster order; it is preserved). Only user_id + role are read
 * — presence fields, if present, are ignored, so offline members
 * stay eligible.
 */
export function eligibleMemberIds<T extends { user_id: unknown; role: unknown }>(
  members: readonly T[] | null | undefined,
): string[] {
  if (!Array.isArray(members)) return [];
  const out: string[] = [];
  for (const m of members) {
    if (!m || typeof m.user_id !== "string" || m.user_id === "") continue;
    if (!isAssignableRole(m.role)) continue;
    if (!out.includes(m.user_id)) out.push(m.user_id);
  }
  return out;
}
