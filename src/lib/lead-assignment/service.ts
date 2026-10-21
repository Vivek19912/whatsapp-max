// ============================================================
// Lead Assignment service — rule resolution, eligibility,
// idempotent auto-assignment with CAS-protected per-table state,
// manual assignment, and audit events.
//
// Applies ONLY to Workspace Meta Lead Ads Tables. Ownership reuses
// the existing "Assigned To" workspace_values cell (value =
// member user_id), so the Workspace column displays the owner with
// no new ownership field and no ownership duplication.
//
// Concurrency: per-(rule, table) state carries a version column;
// updates compare-and-swap it and retry on conflict, so concurrent
// lead arrivals never duplicate or corrupt sequence positions.
// Presence (member_presence) is deliberately NOT an eligibility
// signal — leads are not realtime chats, and presence flapping
// would corrupt SWRR weights. Ineligible = not an admin/agent
// member of the account (removed, deactivated, or role-changed).
//
// Strictly separate from Chat Assignment (src/lib/assignment):
// nothing is imported from or shared with that engine.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isAssigneeField } from "@/lib/flows/workspace-assignee";
import { roundRobinNext, swrrNext } from "./algorithms";
import { ASSIGNABLE_ROLES } from "./members";

export type LeadAssignmentMode = "round_robin" | "swrr";

export interface AssignmentRule {
  id: string;
  account_id: string;
  name: string;
  scope: "specific" | "all";
  mode: LeadAssignmentMode;
  status: "active" | "paused";
}

export interface AssignmentRuleMember {
  user_id: string;
  position: number;
  weight: number;
}

export interface AssignmentTableState {
  id: string;
  rule_id: string;
  form_id: string;
  rr_cursor: number;
  current_weights: Record<string, number>;
  version: number;
}

/** Roles allowed to receive automatic lead assignments (see members.ts). */
export { ASSIGNABLE_ROLES };

/** Compare-and-swap attempts before surfacing a state conflict. */
export const STATE_CAS_MAX_ATTEMPTS = 5;

export type AssignOutcome =
  | "assigned"
  | "already-owned"
  | "no-rule"
  | "no-eligible"
  | "no-field";

export interface AssignResult {
  outcome: AssignOutcome;
  userId: string | null;
  ruleId: string | null;
}

/**
 * Resolve the single effective ACTIVE rule for one Meta table:
 * a specific-table rule wins over the All-Tables fallback; at most
 * one of each can exist (enforced at write time). Deterministic
 * tie-break (earliest created) if overlapping specifics slipped
 * in — writers must still reject the overlap.
 */
export async function resolveAssignmentRule(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<{ rule: AssignmentRule; members: AssignmentRuleMember[] } | null> {
  const { data: rules, error } = await db
    .from("lead_assignment_rules")
    .select("id, account_id, name, scope, mode, status, created_at")
    .eq("account_id", accountId)
    .eq("status", "active");
  if (error) throw error;
  const active = ((rules ?? []) as Array<AssignmentRule & { created_at?: string }>)
    .filter((r) => r.scope === "specific" || r.scope === "all");

  let rule: AssignmentRule | null = null;
  if (active.length > 0) {
    const { data: targets, error: targetErr } = await db
      .from("lead_assignment_rule_tables")
      .select("rule_id")
      .eq("form_id", formId);
    if (targetErr) throw targetErr;
    const covering = new Set(
      ((targets ?? []) as Array<{ rule_id: string }>).map((t) => t.rule_id),
    );
    const specifics = active
      .filter((r) => r.scope === "specific" && covering.has(r.id))
      .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    const fallbacks = active.filter((r) => r.scope === "all");
    rule = specifics[0] ?? fallbacks[0] ?? null;
  }
  if (!rule) return null;

  const { data: members, error: memberErr } = await db
    .from("lead_assignment_rule_members")
    .select("user_id, position, weight")
    .eq("rule_id", rule.id)
    .order("position", { ascending: true });
  if (memberErr) throw memberErr;
  return {
    rule,
    members: ((members ?? []) as AssignmentRuleMember[]).map((m) => ({
      user_id: m.user_id,
      position: m.position,
      weight: m.weight,
    })),
  };
}

/**
 * Intersect rule members with the live account roster (admin/agent
 * roles only), preserving configured member order. A removed,
 * deactivated, or demoted member simply drops out — the saved
 * configuration is untouched, so the original allocation resumes
 * when they return.
 */
export async function listEligibleUserIds(
  db: SupabaseClient,
  accountId: string,
  members: readonly AssignmentRuleMember[],
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
  return members
    .filter((m) => typeof m.user_id === "string" && roster.has(m.user_id))
    .map((m) => m.user_id);
}

/** Load the per-(rule, table) state, creating the default row lazily. */
export async function getOrInitTableState(
  db: SupabaseClient,
  ruleId: string,
  formId: string,
): Promise<AssignmentTableState> {
  const { data, error } = await db
    .from("lead_assignment_table_state")
    .select("id, rule_id, form_id, rr_cursor, current_weights, version")
    .eq("rule_id", ruleId)
    .eq("form_id", formId)
    .maybeSingle();
  if (error) throw error;
  if (data) return normalizeState(data as Record<string, unknown>);
  const { data: created, error: insertErr } = await db
    .from("lead_assignment_table_state")
    .insert({ rule_id: ruleId, form_id: formId })
    .select("id, rule_id, form_id, rr_cursor, current_weights, version")
    .single();
  if (insertErr) {
    // Lost a lazy-init race: the winner's row is authoritative.
    const code = (insertErr as { code?: unknown }).code;
    if (code === "23505") {
      const { data: raced, error: raceErr } = await db
        .from("lead_assignment_table_state")
        .select("id, rule_id, form_id, rr_cursor, current_weights, version")
        .eq("rule_id", ruleId)
        .eq("form_id", formId)
        .maybeSingle();
      if (raceErr) throw raceErr;
      if (raced) return normalizeState(raced as Record<string, unknown>);
    }
    throw insertErr;
  }
  return normalizeState(created as Record<string, unknown>);
}

function normalizeState(row: Record<string, unknown>): AssignmentTableState {
  const weights = row.current_weights;
  return {
    id: row.id as string,
    rule_id: row.rule_id as string,
    form_id: row.form_id as string,
    rr_cursor: typeof row.rr_cursor === "number" ? row.rr_cursor : 0,
    current_weights:
      weights && typeof weights === "object" && !Array.isArray(weights)
        ? (weights as Record<string, number>)
        : {},
    version: typeof row.version === "number" ? row.version : 0,
  };
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

async function recordEvent(
  db: SupabaseClient,
  evt: {
    accountId: string;
    ruleId: string | null;
    flowId: string | null;
    runId: string | null;
    formId: string | null;
    assignedUserId: string | null;
    previousUserId: string | null;
    kind: "auto" | "manual" | "unassigned" | "cleared";
    reason: string | null;
    createdBy: string | null;
  },
): Promise<void> {
  const { error } = await db.from("lead_assignment_events").insert({
    account_id: evt.accountId,
    rule_id: evt.ruleId,
    flow_id: evt.flowId,
    flow_run_id: evt.runId,
    form_id: evt.formId,
    assigned_user_id: evt.assignedUserId,
    previous_user_id: evt.previousUserId,
    kind: evt.kind,
    reason: evt.reason,
    created_by: evt.createdBy,
  });
  if (error) throw error;
}

/**
 * Automatically assign one lead. Safe to call for duplicates,
 * updates, and already-owned leads — those return without writing.
 * Throws on persistent state conflicts (callers treat the lead as
 * unassigned-but-persisted and may retry).
 */
export async function assignLead(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    runId: string;
    formId: string;
    createdBy?: string | null;
  },
): Promise<AssignResult> {
  const { accountId, flowId, runId, formId } = args;

  const resolved = await resolveAssignmentRule(db, accountId, formId);
  if (!resolved) {
    return { outcome: "no-rule", userId: null, ruleId: null };
  }
  const { rule, members } = resolved;
  const eligible = await listEligibleUserIds(db, accountId, members);
  if (eligible.length === 0) {
    await recordEvent(db, {
      accountId,
      ruleId: rule.id,
      flowId,
      runId,
      formId,
      assignedUserId: null,
      previousUserId: null,
      kind: "unassigned",
      reason: "no-eligible-members",
      createdBy: args.createdBy ?? null,
    });
    return { outcome: "no-eligible", userId: null, ruleId: rule.id };
  }

  const field = await findAssigneeField(db, accountId, flowId);
  if (!field) {
    return { outcome: "no-field", userId: null, ruleId: rule.id };
  }
  // Never overwrite an existing owner — manual assignments and
  // previous auto-assignments (surviving Meta updates) win.
  const existing = await readAssignment(db, accountId, field.id, runId);
  if (existing !== null) {
    return { outcome: "already-owned", userId: null, ruleId: rule.id };
  }

  // Compute + claim state with compare-and-swap retries. The state
  // advances exactly when a selection is claimed; ownership is
  // written right after (unique backstop below).
  let state = await getOrInitTableState(db, rule.id, formId);
  let selected: string | null = null;
  let attempts = 0;
  while (attempts < STATE_CAS_MAX_ATTEMPTS) {
    attempts += 1;
    const pick = pickNext(rule, members, eligible, state);
    if (!pick) {
      await recordEvent(db, {
        accountId,
        ruleId: rule.id,
        flowId,
        runId,
        formId,
        assignedUserId: null,
        previousUserId: null,
        kind: "unassigned",
        reason: "no-eligible-selection",
        createdBy: args.createdBy ?? null,
      });
      return { outcome: "no-eligible", userId: null, ruleId: rule.id };
    }
    const { data, error } = await db
      .from("lead_assignment_table_state")
      .update({
        rr_cursor: pick.nextCursor,
        current_weights: pick.nextWeights,
        version: state.version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", state.id)
      .eq("version", state.version)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (data) {
      selected = pick.userId;
      state = { ...state, version: state.version + 1 };
      break;
    }
    state = await getOrInitTableState(db, rule.id, formId);
  }
  if (!selected) {
    const err = new Error("Lead assignment state conflict.") as Error & {
      code: string;
    };
    err.code = "STATE_CONFLICT";
    throw err;
  }

  const { error: ownerErr } = await db.from("workspace_values").insert({
    account_id: accountId,
    field_id: field.id,
    flow_run_id: runId,
    value_text: selected,
  });
  if (ownerErr) {
    const code = (ownerErr as { code?: unknown }).code;
    // A concurrent writer (or a manual edit racing us) already owns
    // this lead: keep their value, never overwrite.
    if (code === "23505") {
      return { outcome: "already-owned", userId: null, ruleId: rule.id };
    }
    throw ownerErr;
  }

  await recordEvent(db, {
    accountId,
    ruleId: rule.id,
    flowId,
    runId,
    formId,
    assignedUserId: selected,
    previousUserId: null,
    kind: "auto",
    reason: rule.mode,
    createdBy: args.createdBy ?? null,
  });
  return { outcome: "assigned", userId: selected, ruleId: rule.id };
}

/**
 * Ingestion-safe wrapper: runs assignLead but never throws, so
 * automatic assignment can never fail lead processing. Returns
 * null when assignment did not (or could not) happen.
 */
export async function maybeAutoAssignLead(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    runId: string;
    formId: string;
  },
): Promise<AssignResult | null> {
  try {
    return await assignLead(db, args);
  } catch (err) {
    console.error("[lead-assignment] auto-assign failed:", err);
    return null;
  }
}

/** Retry assignment for one run (same skip-if-owned semantics). */
export async function retryAssignRun(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    runId: string;
    formId: string;
  },
): Promise<AssignResult> {
  return assignLead(db, args);
}

function pickNext(
  rule: AssignmentRule,
  members: readonly AssignmentRuleMember[],
  eligible: readonly string[],
  state: AssignmentTableState,
): { userId: string; nextCursor: number; nextWeights: Record<string, number> } | null {
  if (rule.mode === "round_robin") {
    const pick = roundRobinNext(eligible, state.rr_cursor);
    if (!pick) return null;
    return {
      userId: pick.userId,
      nextCursor: pick.nextCursor,
      nextWeights: state.current_weights,
    };
  }
  const byId = new Map(members.map((m) => [m.user_id, m]));
  const weighted = eligible.map((userId) => ({
    userId,
    weight: byId.get(userId)?.weight ?? 0,
  }));
  const pick = swrrNext(weighted, state.current_weights);
  if (!pick) return null;
  return {
    userId: pick.userId,
    nextCursor: state.rr_cursor,
    nextWeights: pick.nextCurrent,
  };
}

/**
 * Manual assignment (or clearing) of one Meta lead by an authorized
 * agent. Writes the same Assigned To cell the Workspace uses, so
 * the owner displays immediately — plus an audit event recording
 * actor, previous, and new owner. Never touches algorithm state
 * (cursor/weights), so manual edits can't corrupt sequences, and a
 * later Meta update won't overwrite the manual owner (assignLead
 * skips owned rows).
 */
export async function manualAssign(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    runId: string;
    formId: string | null;
    newUserId: string | null;
    actorUserId: string;
  },
): Promise<{ previous: string | null; current: string | null }> {
  const { accountId, flowId, runId } = args;

  // Meta-only gate: Flow Tables must never reach this service.
  const { data: flow, error: flowErr } = await db
    .from("flows")
    .select("id, kind")
    .eq("id", flowId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (flowErr) throw flowErr;
  const kind = (flow as { kind: string | null } | null)?.kind;
  if (!flow) {
    const err = new Error("Table not found.") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  if (kind !== "meta_lead_ads") {
    const err = new Error("Manual lead assignment is for Meta tables only.") as Error & {
      status: number;
    };
    err.status = 404;
    throw err;
  }

  const field = await findAssigneeField(db, accountId, flowId);
  if (!field) {
    throw new Error("The Assigned To column is not available on this table.");
  }

  // The run must belong to this account and flow.
  const { data: run, error: runErr } = await db
    .from("flow_runs")
    .select("id")
    .eq("id", runId)
    .eq("account_id", accountId)
    .eq("flow_id", flowId)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run) {
    const err = new Error("Lead not found.") as Error & { status: number };
    err.status = 404;
    throw err;
  }

  // Validate the new owner against the live roster ("Unassigned"
  // and null clear the cell; anything else must be a member).
  let stored: string | null;
  const requested = args.newUserId;
  if (requested === null || requested === "Unassigned") {
    stored = requested;
  } else {
    const { data: roster, error: rosterErr } = await db
      .from("profiles")
      .select("user_id")
      .eq("account_id", accountId);
    if (rosterErr) throw rosterErr;
    const ids = new Set(
      ((roster ?? []) as Array<{ user_id: string }>).map((p) => p.user_id),
    );
    if (typeof requested !== "string" || !ids.has(requested)) {
      throw new Error("Choose a team member from this account.");
    }
    stored = requested;
  }

  const previous = await readAssignment(db, accountId, field.id, runId);
  if (stored === null) {
    const { error } = await db
      .from("workspace_values")
      .delete()
      .eq("account_id", accountId)
      .eq("field_id", field.id)
      .eq("flow_run_id", runId);
    if (error) throw error;
  } else {
    const { error } = await db.from("workspace_values").upsert(
      {
        account_id: accountId,
        field_id: field.id,
        flow_run_id: runId,
        value_text: stored,
      },
      { onConflict: "field_id,flow_run_id" },
    );
    if (error) throw error;
  }

  await recordEvent(db, {
    accountId,
    ruleId: null,
    flowId,
    runId,
    formId: args.formId,
    assignedUserId: stored,
    previousUserId: previous,
    kind: "manual",
    reason: null,
    createdBy: args.actorUserId,
  });
  return { previous, current: stored };
}
