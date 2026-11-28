// ============================================================
// Meta Leads Export — Assigned-To display-name resolution.
//
// Workspace stores assignment as a stable member user_id in
// workspace_values.value_text (see lib/flows/workspace-assignee:
// null = cleared, "Unassigned" = explicit, <user_id> = member,
// anything else = legacy display string preserved on read).
// The export must never leak raw user_ids into the workbook:
// names resolve here, in ONE batched account-scoped roster read
// (never N+1), mirroring GET /api/account/members.
//
//_semantics (export column shows text, never ids)_:
//   null / "" / "Unassigned" → "Unassigned"
//   roster hit               → member's display name
//   legacy non-UUID text     → preserved as-is (matches UI)
//   UUID-shaped miss         → "Unknown" + reported (unresolved)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ASSIGNED_TO_UNASSIGNED,
  assigneeDisplayName,
  type AssigneeMember,
} from '@/lib/flows/workspace-assignee';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROSTER_CHUNK = 500;

/** Fallback cell text when a stored UUID has no roster entry. */
export const ASSIGNEE_EXPORT_UNKNOWN = 'Unknown';

export interface ResolvedExportAssignee {
  /** Final cell text — never a raw unresolved UUID. */
  text: string;
  /** True when a UUID-shaped value had no roster entry. */
  unresolved: boolean;
}

/**
 * Map one stored Assigned-To value to its export cell text.
 * Pure — the roster map comes from fetchAssigneeDisplayNames.
 */
export function resolveExportAssigneeName(
  stored: string | null | undefined,
  namesByUserId: ReadonlyMap<string, string>
): ResolvedExportAssignee {
  const trimmed = (stored ?? '').trim();
  if (trimmed === '' || trimmed === ASSIGNED_TO_UNASSIGNED) {
    return { text: ASSIGNED_TO_UNASSIGNED, unresolved: false };
  }
  const name = namesByUserId.get(trimmed);
  if (name !== undefined) return { text: name, unresolved: false };
  if (UUID_RE.test(trimmed)) {
    return { text: ASSIGNEE_EXPORT_UNKNOWN, unresolved: true };
  }
  // Legacy pre-ID display string — preserved exactly as the UI does.
  return { text: stored as string, unresolved: false };
}

/**
 * Batch-resolve member user_ids to display names for one account.
 * One profiles query per 500 ids; account-scoped (RLS defense in
 * depth, same scope as GET /api/account/members). Never throws —
 * a failed chunk simply leaves those ids unresolved (they surface
 * as "Unknown" + reported, never as raw UUIDs, never as a 500).
 */
export async function fetchAssigneeDisplayNames(
  supabase: SupabaseClient,
  accountId: string,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.map((v) => v.trim()).filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  for (let i = 0; i < unique.length; i += ROSTER_CHUNK) {
    const slice = unique.slice(i, i + ROSTER_CHUNK);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .eq('account_id', accountId)
        .in('user_id', slice);
      if (error || !data) continue;
      for (const p of data as Array<{
        user_id: string;
        full_name: string | null;
      }>) {
        if (typeof p.user_id !== 'string' || p.user_id === '') continue;
        if (out.has(p.user_id)) continue;
        const member: AssigneeMember = {
          user_id: p.user_id,
          full_name: p.full_name ?? null,
        };
        out.set(p.user_id, assigneeDisplayName(member));
      }
    } catch {
      continue;
    }
  }
  return out;
}
