// ============================================================
// Lead Assignment rule persistence — create/read/update/delete,
// conflict detection, per-form coverage, and algorithm-state
// maintenance. Used by the /api/lead-assignment routes (which own
// auth + tenant scoping); every query below is account-scoped.
//
// Conflict policy (write-time, active rules only):
//   * a specific rule may not share a table with another active
//     specific rule — 409 with the overlap details;
//   * only one active All-Tables fallback per account (partial
//     unique index is the backstop, the API reports it cleanly).
// Paused rules never conflict. Editing/pausing one rule never
// touches another rule's rows or state.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAssignmentRule } from "./service";
import { validateRuleInput, type ValidRuleInput } from "./validation";

export interface RuleTableRef {
  form_id: string;
}

export interface RuleMemberRef {
  user_id: string;
  position: number;
  weight: number;
}

export interface RuleDetail {
  id: string;
  account_id: string;
  name: string;
  scope: "specific" | "all";
  mode: "round_robin" | "swrr";
  status: "active" | "paused";
  created_by: string | null;
  created_at: string;
  updated_at: string;
  tables: string[];
  members: RuleMemberRef[];
}

export interface RuleConflict {
  rule_id: string;
  rule_name: string;
  tables: string[];
}

function toDetail(
  row: Record<string, unknown>,
  tables: string[],
  members: RuleMemberRef[],
): RuleDetail {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    name: row.name as string,
    scope: row.scope as RuleDetail["scope"],
    mode: row.mode as RuleDetail["mode"],
    status: row.status as RuleDetail["status"],
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    tables,
    members,
  };
}

async function loadMembers(
  db: SupabaseClient,
  ruleId: string,
): Promise<RuleMemberRef[]> {
  const { data, error } = await db
    .from("lead_assignment_rule_members")
    .select("user_id, position, weight")
    .eq("rule_id", ruleId)
    .order("position", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as RuleMemberRef[]).map((m) => ({
    user_id: m.user_id,
    position: m.position,
    weight: m.weight,
  }));
}

async function loadTables(db: SupabaseClient, ruleId: string): Promise<string[]> {
  const { data, error } = await db
    .from("lead_assignment_rule_tables")
    .select("form_id")
    .eq("rule_id", ruleId);
  if (error) throw error;
  return ((data ?? []) as Array<{ form_id: string }>).map((t) => t.form_id);
}

/** Active-rule overlaps for a candidate (self excluded on update). */
export async function findConflicts(
  db: SupabaseClient,
  accountId: string,
  candidate: {
    scope: "specific" | "all";
    tables: string[];
    excludeRuleId?: string;
  },
): Promise<RuleConflict[]> {
  const { data, error } = await db
    .from("lead_assignment_rules")
    .select("id, name, scope")
    .eq("account_id", accountId)
    .eq("status", "active");
  if (error) throw error;
  const active = ((data ?? []) as Array<{
    id: string;
    name: string;
    scope: string;
  }>).filter((r) => r.id !== candidate.excludeRuleId);

  if (candidate.scope === "all") {
    return active
      .filter((r) => r.scope === "all")
      .map((r) => ({ rule_id: r.id, rule_name: r.name, tables: [] }));
  }
  if (candidate.tables.length === 0) return [];
  const { data: targets, error: targetErr } = await db
    .from("lead_assignment_rule_tables")
    .select("rule_id, form_id")
    .in(
      "rule_id",
      active.filter((r) => r.scope === "specific").map((r) => r.id),
    );
  if (targetErr) throw targetErr;
  const byRule = new Map<string, string[]>();
  for (const t of (targets ?? []) as Array<{ rule_id: string; form_id: string }>) {
    if (!candidate.tables.includes(t.form_id)) continue;
    const list = byRule.get(t.rule_id) ?? [];
    list.push(t.form_id);
    byRule.set(t.rule_id, list);
  }
  return [...byRule.entries()].map(([rule_id, tables]) => {
    const rule = active.find((r) => r.id === rule_id)!;
    return { rule_id, rule_name: rule.name, tables };
  });
}

async function assertFormsBelongToAccount(
  db: SupabaseClient,
  accountId: string,
  formIds: string[],
): Promise<void> {
  if (formIds.length === 0) return;
  const { data, error } = await db
    .from("meta_lead_forms")
    .select("id")
    .eq("account_id", accountId)
    .in("id", formIds);
  if (error) throw error;
  const found = new Set(((data ?? []) as Array<{ id: string }>).map((f) => f.id));
  const missing = formIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    const err = new Error("One or more selected tables no longer exist.") as Error & {
      status: number;
    };
    err.status = 400;
    throw err;
  }
}

async function assertMembersBelongToAccount(
  db: SupabaseClient,
  accountId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const { data, error } = await db
    .from("profiles")
    .select("user_id")
    .eq("account_id", accountId)
    .in("user_id", userIds);
  if (error) throw error;
  const found = new Set(((data ?? []) as Array<{ user_id: string }>).map((p) => p.user_id));
  const missing = userIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    const err = new Error("One or more selected members are not in this company.") as Error & {
      status: number;
    };
    err.status = 400;
    throw err;
  }
}

export async function listRules(
  db: SupabaseClient,
  accountId: string,
): Promise<RuleDetail[]> {
  const { data, error } = await db
    .from("lead_assignment_rules")
    .select("*")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const out: RuleDetail[] = [];
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    out.push(
      toDetail(
        row,
        await loadTables(db, row.id as string),
        await loadMembers(db, row.id as string),
      ),
    );
  }
  return out;
}

export async function getRule(
  db: SupabaseClient,
  accountId: string,
  ruleId: string,
): Promise<RuleDetail | null> {
  const { data, error } = await db
    .from("lead_assignment_rules")
    .select("*")
    .eq("id", ruleId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return toDetail(
    row,
    await loadTables(db, row.id as string),
    await loadMembers(db, row.id as string),
  );
}

export async function createRule(
  db: SupabaseClient,
  args: {
    accountId: string;
    createdBy: string;
    input: ValidRuleInput;
  },
): Promise<RuleDetail> {
  const { accountId, createdBy, input } = args;
  await assertFormsBelongToAccount(db, accountId, input.tables);
  await assertMembersBelongToAccount(
    db,
    accountId,
    input.members.map((m) => m.user_id),
  );
  if (input.status === "active") {
    const conflicts = await findConflicts(db, accountId, {
      scope: input.scope,
      tables: input.tables,
    });
    if (conflicts.length > 0) {
      const err = new Error(describeConflicts(conflicts)) as Error & {
        status: number;
        conflicts: RuleConflict[];
      };
      err.status = 409;
      err.conflicts = conflicts;
      throw err;
    }
  }
  const { data, error } = await db
    .from("lead_assignment_rules")
    .insert({
      account_id: accountId,
      name: input.name,
      scope: input.scope,
      mode: input.mode,
      status: input.status,
      created_by: createdBy,
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: unknown }).code === "23505") {
      const err = new Error(
        "An active All Tables fallback already exists. Pause or delete it first.",
      ) as Error & { status: number };
      err.status = 409;
      throw err;
    }
    throw error;
  }
  const row = data as Record<string, unknown>;
  const ruleId = row.id as string;
  if (input.tables.length > 0) {
    const { error: tableErr } = await db
      .from("lead_assignment_rule_tables")
      .insert(input.tables.map((form_id) => ({ rule_id: ruleId, form_id })));
    if (tableErr) throw tableErr;
  }
  const { error: memberErr } = await db.from("lead_assignment_rule_members").insert(
    input.members.map((m, index) => ({
      rule_id: ruleId,
      user_id: m.user_id,
      position: index,
      weight: input.mode === "swrr" ? m.weight : 0,
    })),
  );
  if (memberErr) throw memberErr;
  return toDetail(
    row,
    input.tables,
    input.members.map((m, index) => ({
      user_id: m.user_id,
      position: index,
      weight: input.mode === "swrr" ? m.weight : 0,
    })),
  );
}

export function describeConflicts(conflicts: RuleConflict[]): string {
  const parts = conflicts.map((c) =>
    c.tables.length > 0
      ? `"${c.rule_name}" already covers ${c.tables.length} of the selected table(s)`
      : `All Tables fallback "${c.rule_name}" is already active`,
  );
  return `Conflicting assignment rule: ${parts.join("; ")}. Resolve the overlap before saving.`;
}

export async function updateRule(
  db: SupabaseClient,
  args: {
    accountId: string;
    ruleId: string;
    input: ValidRuleInput;
  },
): Promise<RuleDetail> {
  const { accountId, ruleId, input } = args;
  const existing = await getRule(db, accountId, ruleId);
  if (!existing) {
    const err = new Error("Rule not found.") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  await assertFormsBelongToAccount(db, accountId, input.tables);
  await assertMembersBelongToAccount(
    db,
    accountId,
    input.members.map((m) => m.user_id),
  );
  if (input.status === "active") {
    const conflicts = await findConflicts(db, accountId, {
      scope: input.scope,
      tables: input.tables,
      excludeRuleId: ruleId,
    });
    if (conflicts.length > 0) {
      const err = new Error(describeConflicts(conflicts)) as Error & {
        status: number;
        conflicts: RuleConflict[];
      };
      err.status = 409;
      err.conflicts = conflicts;
      throw err;
    }
  }

  const { data, error } = await db
    .from("lead_assignment_rules")
    .update({
      name: input.name,
      scope: input.scope,
      mode: input.mode,
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ruleId)
    .eq("account_id", accountId)
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: unknown }).code === "23505") {
      const err = new Error(
        "An active All Tables fallback already exists. Pause or delete it first.",
      ) as Error & { status: number };
      err.status = 409;
      throw err;
    }
    throw error;
  }

  // Replace targets wholesale; drop per-table state for tables that
  // left the rule (a re-added table starts fresh). Member edits keep
  // the cursor; SWRR weights of removed members are pruned.
  const removedTables = existing.tables.filter((t) => !input.tables.includes(t));
  const { error: delTablesErr } = await db
    .from("lead_assignment_rule_tables")
    .delete()
    .eq("rule_id", ruleId);
  if (delTablesErr) throw delTablesErr;
  if (input.tables.length > 0) {
    const { error: tableErr } = await db
      .from("lead_assignment_rule_tables")
      .insert(input.tables.map((form_id) => ({ rule_id: ruleId, form_id })));
    if (tableErr) throw tableErr;
  }
  if (removedTables.length > 0) {
    const { error: stateErr } = await db
      .from("lead_assignment_table_state")
      .delete()
      .eq("rule_id", ruleId)
      .in("form_id", removedTables);
    if (stateErr) throw stateErr;
  }

  const { error: delMembersErr } = await db
    .from("lead_assignment_rule_members")
    .delete()
    .eq("rule_id", ruleId);
  if (delMembersErr) throw delMembersErr;
  const { error: memberErr } = await db.from("lead_assignment_rule_members").insert(
    input.members.map((m, index) => ({
      rule_id: ruleId,
      user_id: m.user_id,
      position: index,
      weight: input.mode === "swrr" ? m.weight : 0,
    })),
  );
  if (memberErr) throw memberErr;

  const keepUsers = new Set(input.members.map((m) => m.user_id));
  const { data: states, error: statesErr } = await db
    .from("lead_assignment_table_state")
    .select("id, current_weights")
    .eq("rule_id", ruleId);
  if (statesErr) throw statesErr;
  for (const st of (states ?? []) as Array<{
    id: string;
    current_weights: Record<string, number> | null;
  }>) {
    const pruned: Record<string, number> = {};
    for (const [userId, value] of Object.entries(st.current_weights ?? {})) {
      if (keepUsers.has(userId)) pruned[userId] = value;
    }
    const { error: pruneErr } = await db
      .from("lead_assignment_table_state")
      .update({ current_weights: pruned })
      .eq("id", st.id);
    if (pruneErr) throw pruneErr;
  }

  const row = data as Record<string, unknown>;
  return toDetail(
    row,
    input.tables,
    input.members.map((m, index) => ({
      user_id: m.user_id,
      position: index,
      weight: input.mode === "swrr" ? m.weight : 0,
    })),
  );
}

export async function deleteRule(
  db: SupabaseClient,
  accountId: string,
  ruleId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("lead_assignment_rules")
    .delete()
    .eq("id", ruleId)
    .eq("account_id", accountId)
    .select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

/**
 * Which active rule governs each Meta table of the account
 * (specific wins; otherwise the fallback; otherwise none).
 * Powers the "which rule governs each table" coverage display.
 */
export async function getCoverage(
  db: SupabaseClient,
  accountId: string,
): Promise<Array<{ form_id: string; rule_id: string | null }>> {
  const { data, error } = await db
    .from("meta_lead_forms")
    .select("id")
    .eq("account_id", accountId);
  if (error) throw error;
  const forms = ((data ?? []) as Array<{ id: string }>).map((f) => f.id);
  const out: Array<{ form_id: string; rule_id: string | null }> = [];
  for (const formId of forms) {
    const resolved = await resolveAssignmentRule(db, accountId, formId);
    out.push({ form_id: formId, rule_id: resolved ? resolved.rule.id : null });
  }
  return out;
}
