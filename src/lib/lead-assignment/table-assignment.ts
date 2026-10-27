// ============================================================
// Per-table Lead Assignment engine — config-first assignment for
// Meta Lead Ads tables AND Flow tables.
//
// Resolution order for a new lead on table T:
//   1. T's own assignment config (enabled) → this engine.
//   2. Otherwise, for Meta tables only → the legacy global rule
//      engine (service.assignLead) so existing setups keep working.
//      Flow tables have no legacy rules: without a config the lead
//      simply stays unassigned.
//
// Guarantees (mirroring the legacy engine):
//   * Eligibility (active flag, pause windows incl. account-scope
//     pauses, live roster for internal members) is evaluated AT
//     ASSIGNMENT TIME, never cached from the settings page.
//   * Algorithm state advances exactly once per selection via
//     compare-and-swap; concurrent arrivals serialize on the
//     version column and retries never corrupt the sequence.
//   * Existing owners are never overwritten (skip-if-owned +
//     unique backstop); config saves never reassign history.
//   * Internal members take ownership in the Assigned To cell.
//     External recipients are NEVER written as owners — they get
//     notifications only, and the lead stays Unassigned.
//   * Failures are recorded as audit events with clear reasons;
//     notification failures never block assignment.
//
// Flow Tables must never enter the Google Sheets sync system for
// Meta Lead Ads: this module has no dependency on that sync stack
// (no imports, no shared state, no side effects).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AssignmentTableState } from "./service";
import {
  findAssigneeField,
  hasPriorAssignment,
  listEligibleUserIds,
  readAssignment,
} from "./table-helpers";
import { roundRobinNext, swrrNext } from "./algorithms";
import { getTableConfig, type TableAssigneeRow, type TableConfigDetail } from "./table-config";
import { enqueueTableAssignmentNotifications } from "./table-notify";

export const TABLE_STATE_CAS_MAX_ATTEMPTS = 5;

export type TableAssignOutcome =
  | "assigned"
  | "assigned-external"
  | "already-owned"
  | "no-config"
  | "no-eligible"
  | "no-field";

export interface TableAssignResult {
  outcome: TableAssignOutcome;
  /** Internal member user_id when one took ownership. */
  userId: string | null;
  /** The selected assignee (internal or external). */
  assigneeId: string | null;
  configId: string | null;
  /**
   * True when this table's engine took responsibility for the lead
   * (assigned or recorded unassigned). Callers must NOT run the
   * legacy global-rule notification path then — the engine already
   * enqueued (or intentionally skipped) alerts. False only for
   * "no-config", where the legacy engine remains in charge.
   */
  notifyHandled: boolean;
}

interface EligibleAssignee extends TableAssigneeRow {
  effectiveWeight: number;
}

/** True when the pause window still covers `now`. */
export function isPausedAt(
  assignee: Pick<TableAssigneeRow, "paused_until">,
  now: number = Date.now(),
): boolean {
  if (!assignee.paused_until) return false;
  const at = Date.parse(assignee.paused_until);
  return !Number.isNaN(at) && at > now;
}

/**
 * Account-wide pause blocks for one account: any assignee row in
 * the account with scope 'account' and a live window blocks the
 * same identity everywhere. Internal members match by user_id;
 * external recipients match by email or phone.
 */
async function loadAccountPauseBlocks(
  db: SupabaseClient,
  accountId: string,
  nowIso: string,
): Promise<{ users: Set<string>; emails: Set<string>; phones: Set<string> }> {
  const users = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const { data, error } = await db
    .from("lead_assignment_table_assignees")
    .select("user_id, email, phone, paused_until, pause_scope, config_id")
    .eq("pause_scope", "account");
  if (error) throw error;
  // Tenant + liveness filtering is applied in code (the pause rows
  // join through their configs, which carry the account).
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter(
    (r) => typeof r.paused_until === "string" && Date.parse(r.paused_until) > Date.parse(nowIso),
  );
  if (rows.length === 0) return { users, emails, phones };
  const configIds = [...new Set(rows.map((r) => r.config_id as string))];
  const { data: configs, error: configErr } = await db
    .from("lead_assignment_table_configs")
    .select("id")
    .eq("account_id", accountId)
    .in("id", configIds);
  if (configErr) throw configErr;
  const own = new Set(((configs ?? []) as Array<{ id: string }>).map((c) => c.id));
  for (const r of rows) {
    if (!own.has(r.config_id as string)) continue;
    if (typeof r.user_id === "string" && r.user_id !== "") users.add(r.user_id);
    if (typeof r.email === "string" && r.email !== "") emails.add(r.email.toLowerCase());
    if (typeof r.phone === "string" && r.phone !== "") phones.add(r.phone);
  }
  return { users, emails, phones };
}

/**
 * The eligible pool for one assignment: active, unpaused (table
 * window AND account-wide blocks), and — for internal members —
 * on the live assignable roster. Configured order is preserved.
 * Paused-until timestamps already past count as expired (automatic
 * restore with no cron and no write).
 */
export async function resolveEligibleAssignees(
  db: SupabaseClient,
  accountId: string,
  detail: TableConfigDetail,
  now: number = Date.now(),
): Promise<EligibleAssignee[]> {
  const nowIso = new Date(now).toISOString();
  const blocks = await loadAccountPauseBlocks(db, accountId, nowIso);
  const internal = detail.assignees.filter((a) => typeof a.user_id === "string");
  // Reuse the roster gate (assignable roles + owner backstop).
  const rosterOk = new Set(
    await listEligibleUserIds(
      db,
      accountId,
      internal.map((a) => ({ user_id: a.user_id as string, position: 0, weight: 0 })),
    ),
  );
  const out: EligibleAssignee[] = [];
  for (const a of detail.assignees) {
    if (!a.is_active) continue;
    if (isPausedAt(a, now)) continue;
    if (a.pause_scope === "account") continue; // live window = blocked everywhere
    if (a.user_id) {
      if (!rosterOk.has(a.user_id)) continue;
      if (blocks.users.has(a.user_id)) continue;
    } else {
      if (a.email && blocks.emails.has(a.email.toLowerCase())) continue;
      if (a.phone && blocks.phones.has(a.phone)) continue;
    }
    out.push({ ...a, effectiveWeight: a.weight });
  }
  return out;
}

interface ConfigState {
  id: string;
  rr_cursor: number;
  current_weights: Record<string, number>;
  version: number;
}

async function getOrInitConfigState(
  db: SupabaseClient,
  configId: string,
): Promise<ConfigState> {
  const { data, error } = await db
    .from("lead_assignment_table_config_state")
    .select("config_id, rr_cursor, current_weights, version")
    .eq("config_id", configId)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    const row = data as Record<string, unknown>;
    const weights = row.current_weights;
    return {
      id: row.config_id as string,
      rr_cursor: typeof row.rr_cursor === "number" ? row.rr_cursor : 0,
      current_weights:
        weights && typeof weights === "object" && !Array.isArray(weights)
          ? (weights as Record<string, number>)
          : {},
      version: typeof row.version === "number" ? row.version : 0,
    };
  }
  const { data: created, error: insertErr } = await db
    .from("lead_assignment_table_config_state")
    .insert({ config_id: configId })
    .select("config_id, rr_cursor, current_weights, version")
    .single();
  if (insertErr) {
    // Lost a lazy-init race: the winner's row is authoritative.
    if ((insertErr as { code?: unknown }).code === "23505") {
      const { data: existing, error: existingErr } = await db
        .from("lead_assignment_table_config_state")
        .select("config_id, rr_cursor, current_weights, version")
        .eq("config_id", configId)
        .maybeSingle();
      if (!existingErr && existing) {
        const row = existing as Record<string, unknown>;
        const weights = row.current_weights;
        return {
          id: row.config_id as string,
          rr_cursor: typeof row.rr_cursor === "number" ? row.rr_cursor : 0,
          current_weights:
            weights && typeof weights === "object" && !Array.isArray(weights)
              ? (weights as Record<string, number>)
              : {},
          version: typeof row.version === "number" ? row.version : 0,
        };
      }
    }
    throw insertErr;
  }
  const row = created as Record<string, unknown>;
  return {
    id: row.config_id as string,
    rr_cursor: 0,
    current_weights: {},
    version: 0,
  };
}

async function recordTableEvent(
  db: SupabaseClient,
  evt: {
    accountId: string;
    configId: string | null;
    assigneeId: string | null;
    flowId: string | null;
    runId: string | null;
    formId: string | null;
    assignedUserId: string | null;
    previousUserId: string | null;
    kind: "auto" | "manual" | "unassigned" | "cleared";
    reason: string | null;
    createdBy: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await db.from("lead_assignment_events").insert({
    account_id: evt.accountId,
    rule_id: null,
    table_config_id: evt.configId,
    table_assignee_id: evt.assigneeId,
    flow_id: evt.flowId,
    flow_run_id: evt.runId,
    form_id: evt.formId,
    assigned_user_id: evt.assignedUserId,
    previous_user_id: evt.previousUserId,
    kind: evt.kind,
    reason: evt.reason,
    created_by: evt.createdBy,
    meta: evt.meta ?? {},
  });
  if (error) throw error;
}

/**
 * Assign one lead using its table's own config. Safe for duplicate
 * deliveries and retries (skip-if-owned + unique ownership write +
 * idempotent notification enqueue). Throws only on persistent
 * state conflicts — callers treat the lead as unassigned-but-kept.
 */
export async function assignTableLead(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    runId: string;
    formId: string | null;
    createdBy?: string | null;
  },
): Promise<TableAssignResult> {
  const { accountId, flowId, runId, formId } = args;
  const detail = await getTableConfig(db, accountId, flowId);
  if (!detail || !detail.enabled) {
    return { outcome: "no-config", userId: null, assigneeId: null, configId: null, notifyHandled: false };
  }

  const eligible = await resolveEligibleAssignees(db, accountId, detail);
  if (eligible.length === 0) {
    await recordTableEvent(db, {
      accountId,
      configId: detail.id,
      assigneeId: null,
      flowId,
      runId,
      formId,
      assignedUserId: null,
      previousUserId: null,
      kind: "unassigned",
      reason: "no-eligible-assignees",
      createdBy: args.createdBy ?? null,
    });
    return { outcome: "no-eligible", userId: null, assigneeId: null, configId: detail.id, notifyHandled: true };
  }

  const field = await findAssigneeField(db, accountId, flowId);
  if (!field) {
    return { outcome: "no-field", userId: null, assigneeId: null, configId: detail.id, notifyHandled: true };
  }
  // Never overwrite an existing owner — manual assignments and
  // previous auto-assignments win. Duplicate webhook deliveries
  // and retries land here and return without writing.
  const existing = await readAssignment(db, accountId, field.id, runId);
  if (existing !== null) {
    return { outcome: "already-owned", userId: null, assigneeId: null, configId: detail.id, notifyHandled: true };
  }
  // Genuine initial assignment requires no prior assignment event
  // for this run (a clear-then-reassign leaves the owner empty but
  // is still a reassignment). Checked BEFORE this assignment
  // writes its own event below — afterwards every run trivially
  // "has" a prior event. Best-effort: on read failure we fail
  // closed (no customer sequence) rather than risk a duplicate.
  let isInitialAssignment = false;
  try {
    isInitialAssignment = !(await hasPriorAssignment(db, accountId, runId));
  } catch {
    isInitialAssignment = false;
  }

  let state = await getOrInitConfigState(db, detail.id);
  let selected: EligibleAssignee | null = null;
  let nextCursor = state.rr_cursor;
  let nextWeights = state.current_weights;
  let attempts = 0;
  while (attempts < TABLE_STATE_CAS_MAX_ATTEMPTS) {
    attempts += 1;
    if (detail.mode === "round_robin") {
      const pick = roundRobinNext(
        eligible.map((a) => a.id),
        state.rr_cursor,
      );
      if (!pick) break;
      selected = eligible.find((a) => a.id === pick.userId) ?? null;
      nextCursor = pick.nextCursor;
      nextWeights = state.current_weights;
    } else {
      const pick = swrrNext(
        eligible.map((a) => ({ userId: a.id, weight: a.effectiveWeight })),
        state.current_weights,
      );
      if (!pick) break;
      selected = eligible.find((a) => a.id === pick.userId) ?? null;
      nextCursor = state.rr_cursor;
      nextWeights = pick.nextCurrent;
    }
    if (!selected) break;
    const { data, error } = await db
      .from("lead_assignment_table_config_state")
      .update({
        rr_cursor: nextCursor,
        current_weights: nextWeights,
        version: state.version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("config_id", detail.id)
      .eq("version", state.version)
      .select("config_id")
      .maybeSingle();
    if (error) throw error;
    if (data) {
      state = { ...state, version: state.version + 1 };
      break;
    }
    // Lost the race: re-read and retry (eligibility is
    // re-resolved per attempt implicitly — the pool cannot grow
    // mid-loop in a way that breaks determinism).
    state = await getOrInitConfigState(db, detail.id);
    selected = null;
  }
  if (!selected) {
    const err = new Error("Lead assignment state conflict.") as Error & { code: string };
    err.code = "STATE_CONFLICT";
    throw err;
  }

  // Ownership: internal members take the Assigned To cell.
  // External recipients NEVER become owners — the lead stays
  // Unassigned and they are notified instead.
  let ownerUserId: string | null = null;
  if (selected.user_id) {
    const { error: ownerErr } = await db.from("workspace_values").insert({
      account_id: accountId,
      field_id: field.id,
      flow_run_id: runId,
      value_text: selected.user_id,
    });
    if (ownerErr) {
      if ((ownerErr as { code?: unknown }).code === "23505") {
        return { outcome: "already-owned", userId: null, assigneeId: null, configId: detail.id, notifyHandled: true };
      }
      throw ownerErr;
    }
    ownerUserId = selected.user_id;
  }

  await recordTableEvent(db, {
    accountId,
    configId: detail.id,
    assigneeId: selected.id,
    flowId,
    runId,
    formId,
    assignedUserId: ownerUserId,
    previousUserId: null,
    kind: "auto",
    reason: selected.user_id ? detail.mode : "external-notification",
    createdBy: args.createdBy ?? null,
    meta: {
      mode: detail.mode,
      external: !selected.user_id,
      notify_email: selected.notify_email,
      notify_whatsapp: selected.notify_whatsapp,
    },
  });

  // Best-effort notifications (email and/or WhatsApp per the
  // assignee's toggles). Failures are queued/recorded, never
  // thrown — assignment always survives notification outages.
  // Internal members on Meta tables keep the existing durable
  // queue (unchanged behavior, templates, and dedup); every other
  // combination uses the per-table outbox.
  if (selected.user_id && formId && selected.notify_email) {
    try {
      const { data: sub } = await db
        .from("meta_lead_submissions")
        .select("id")
        .eq("account_id", accountId)
        .eq("flow_run_id", runId)
        .maybeSingle();
      const submissionId = (sub as { id: string } | null)?.id;
      if (submissionId) {
        const { maybeEnqueueLeadNotification } = await import(
          "@/lib/meta-lead-ads/notify"
        );
        await maybeEnqueueLeadNotification(db, {
          accountId,
          submissionId,
          assigneeUserId: selected.user_id,
        });
      }
    } catch {
      // Best-effort only; the outbox below still covers WhatsApp.
    }
  }
  // Internal Meta members already used the legacy email queue
  // above — skip the email channel here so they are never mailed
  // twice. Flow tables and external recipients use this outbox.
  await enqueueTableAssignmentNotifications(db, {
    accountId,
    detail,
    assignee: selected,
    runId,
    formId,
    skipEmail: !!(selected.user_id && formId),
  });

  // ADDITIVE salesperson customer sequence: only on a genuine
  // initial assignment (no owner was present AND no prior
  // assignment event — clear-then-reassign, retries, and duplicate
  // deliveries never restart customer messaging). Reassignments
  // notify through the channels above and stop here. Best-effort:
  // never fails assignment. Dynamically imported so Flow-table
  // paths keep no static dependency on the WhatsApp send stack.
  if (selected && formId && isInitialAssignment) {
    try {
      const { salespersonKeyFor } = await import(
        "@/lib/meta-lead-whatsapp/assignee-sequences"
      );
      const key = salespersonKeyFor({
        user_id: selected.user_id,
        email: selected.email,
        phone: selected.phone,
      });
      if (key) {
        const { maybeEnqueueAssigneeSequence } = await import(
          "@/lib/meta-lead-whatsapp/queue"
        );
        const queued = await maybeEnqueueAssigneeSequence(db, {
          accountId,
          formId,
          flowRunId: runId,
          assigneeKey: key,
        });
        if (queued.enqueued > 0) {
          const { scheduleWhatsappDrainSoon } = await import(
            "@/lib/meta-lead-whatsapp/trigger"
          );
          scheduleWhatsappDrainSoon({ accountId });
        }
      }
    } catch {
      // Best-effort only; assignment already succeeded.
    }
  }

  return {
    outcome: selected.user_id ? "assigned" : "assigned-external",
    userId: ownerUserId,
    assigneeId: selected.id,
    configId: detail.id,
    notifyHandled: true,
  };
}

/**
 * Ingestion-safe wrapper for Meta + Flow arrivals: never throws.
 * Returns null when assignment did not (or could not) happen.
 */
export async function maybeAutoAssignTableLead(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    runId: string;
    formId: string | null;
  },
): Promise<TableAssignResult | null> {
  try {
    return await assignTableLead(db, args);
  } catch (err) {
    console.error("[lead-assignment] table auto-assign failed:", err);
    return null;
  }
}

/** Retry assignment for one run (same skip-if-owned semantics). */
export async function retryTableAssignRun(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    runId: string;
    formId: string | null;
  },
): Promise<TableAssignResult> {
  return assignTableLead(db, args);
}

// Re-exported for tests: the legacy state shape stays compatible.
export type { AssignmentTableState };
