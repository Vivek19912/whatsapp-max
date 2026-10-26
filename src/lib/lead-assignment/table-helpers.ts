// ============================================================
// Per-table Lead Assignment — shared roster/ownership helpers.
//
// These read-only helpers are used by BOTH the legacy global
// rule engine (service.ts) and the per-table engine
// (table-assignment.ts). They live here — with NO dependency on
// the Meta Sheets sync system — so Flow-table code paths
// (flows/engine.ts → table-assignment.ts) never pull Sheets code
// into the Flow runtime.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isAssigneeField } from "@/lib/flows/workspace-assignee";
import { ASSIGNABLE_ROLES } from "./members";

export interface RosterMemberRef {
  user_id: string;
  position: number;
  weight: number;
}

/**
 * Intersect rule members with the live account roster (owner/
 * admin/agent roles only), preserving configured member order. A
 * removed, deactivated, or demoted member simply drops out — the
 * saved configuration is untouched, so the original allocation
 * resumes when they return. The account owner is always eligible:
 * role `owner` is in ASSIGNABLE_ROLES, and as a backstop the
 * accounts.owner_user_id for this account is unioned in (after
 * confirming they hold a profile in the same account, so tenant
 * isolation is preserved and no role is changed).
 */
export async function listEligibleUserIds(
  db: SupabaseClient,
  accountId: string,
  members: readonly RosterMemberRef[],
): Promise<string[]> {
  if (members.length === 0) return [];
  const { data, error } = await db
    .from("profiles")
    .select("user_id")
    .eq("account_id", accountId)
    .in("account_role", [...ASSIGNABLE_ROLES]);
  if (error) throw error;
  const roster = new Set(
    ((data ?? []) as Array<{ user_id: string }>).map((p) => p.user_id),
  );
  // Owner backstop: accounts.owner_user_id for THIS account only.
  // Covers owners whose profile role differs from owner/admin/
  // agent (e.g. legacy or demoted rows) without widening to any
  // other account.
  try {
    const { data: acct, error: acctErr } = await db
      .from("accounts")
      .select("owner_user_id")
      .eq("id", accountId)
      .maybeSingle();
    if (!acctErr && acct) {
      const ownerUserId = (acct as { owner_user_id?: unknown }).owner_user_id;
      if (typeof ownerUserId === "string" && ownerUserId !== "") {
        const { data: ownerProfile, error: ownerErr } = await db
          .from("profiles")
          .select("user_id")
          .eq("account_id", accountId)
          .eq("user_id", ownerUserId)
          .maybeSingle();
        if (!ownerErr && ownerProfile) {
          roster.add(ownerUserId);
        }
      }
    }
  } catch {
    // Backstop is best-effort; role-based eligibility above stands.
  }
  return members
    .filter((m) => typeof m.user_id === "string" && roster.has(m.user_id))
    .map((m) => m.user_id);
}

/** The flow's "Assigned To" workspace field, if present. */
export async function findAssigneeField(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("workspace_fields")
    .select("id, name")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (error) throw error;
  const field = ((data ?? []) as Array<{ id: string; name: string }>).find((f) =>
    isAssigneeField(f),
  );
  return field ? { id: field.id } : null;
}

/** Current stored owner (member user_id, "Unassigned", or null). */
export async function readAssignment(
  db: SupabaseClient,
  accountId: string,
  fieldId: string,
  runId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("workspace_values")
    .select("value_text")
    .eq("account_id", accountId)
    .eq("field_id", fieldId)
    .eq("flow_run_id", runId)
    .maybeSingle();
  if (error) throw error;
  return ((data as { value_text: string | null } | null)?.value_text ?? null);
}
