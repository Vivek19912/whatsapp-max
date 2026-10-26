// ============================================================
// Per-table Lead Assignment — configuration persistence.
//
// One config row per (account, flow) covers BOTH Meta Lead Ads
// tables and Flow tables uniformly: every Meta table is backed by
// a virtual flow row (flows.meta_form_id), so flows.id is the
// single table identity. Every query below carries the caller's
// account_id AND flow_id — one table's settings can never leak
// into or overwrite another table's.
//
// Saving a config never touches historical leads: algorithm state
// (cursor/weights) is preserved, ownership cells are never
// rewritten here, and only future arrivals use the new settings.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  validatePauseInput,
  validateTableConfig,
  type PauseInput,
  type TableConfigInput,
  type ValidPause,
  type ValidTableConfig,
} from "./table-validation";

export interface TableFlowRef {
  flowId: string;
  kind: "meta_lead_ads" | "whatsapp_flow";
  /** Meta form db id (meta_lead_forms.id) for Meta tables, else null. */
  formDbId: string | null;
}

export interface TableAssigneeRow {
  id: string;
  config_id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  position: number;
  weight: number;
  is_active: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  pause_scope: "table" | "account";
  notify_email: boolean;
  notify_whatsapp: boolean;
}

export interface TableConfigDetail {
  id: string;
  account_id: string;
  flow_id: string;
  kind: TableFlowRef["kind"];
  form_db_id: string | null;
  enabled: boolean;
  mode: "round_robin" | "percentage";
  timezone: string;
  whatsapp_template_name: string | null;
  whatsapp_template_language: string;
  assignees: TableAssigneeRow[];
}

export interface AvailabilityView extends TableAssigneeRow {
  /** True when the assignee can receive a new lead right now. */
  available: boolean;
  /** Machine reason when unavailable (paused/active/roster). */
  unavailable_reason: "active" | "paused" | "ineligible-member" | null;
  /** Human status line in the config's timezone. */
  status_label: string;
}

/**
 * Resolve the caller's table: same account, any flow kind. Flow
 * tables and Meta tables share this path — the kind only decides
 * which engine features apply downstream (Meta tables keep the
 * Sheets coupling out of this module entirely). Null when the
 * flow is missing, foreign, or archived away.
 */
export async function resolveTableFlow(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<TableFlowRef | null> {
  const { data, error } = await db
    .from("flows")
    .select("id, kind, meta_form_id")
    .eq("id", flowId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    id: string;
    kind: string | null;
    meta_form_id: string | null;
  } | null;
  if (!row) return null;
  if (row.kind === "meta_lead_ads") {
    if (!row.meta_form_id) return null;
    return { flowId: row.id, kind: "meta_lead_ads", formDbId: row.meta_form_id };
  }
  if (row.kind === "whatsapp_flow") {
    return { flowId: row.id, kind: "whatsapp_flow", formDbId: null };
  }
  return null;
}

function toAssigneeRow(raw: Record<string, unknown>): TableAssigneeRow {
  return {
    id: raw.id as string,
    config_id: raw.config_id as string,
    user_id: (raw.user_id as string | null) ?? null,
    display_name: raw.display_name as string,
    email: (raw.email as string | null) ?? null,
    phone: (raw.phone as string | null) ?? null,
    position: typeof raw.position === "number" ? raw.position : 0,
    weight: typeof raw.weight === "number" ? raw.weight : 0,
    is_active: raw.is_active !== false,
    paused_until: (raw.paused_until as string | null) ?? null,
    pause_reason: (raw.pause_reason as string | null) ?? null,
    pause_scope:
      raw.pause_scope === "account" ? "account" : "table",
    notify_email: raw.notify_email !== false,
    notify_whatsapp: raw.notify_whatsapp === true,
  };
}

/** Load one table's saved config with assignees in position order. */
export async function getTableConfig(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<TableConfigDetail | null> {
  const flow = await resolveTableFlow(db, accountId, flowId);
  if (!flow) return null;
  const { data: config, error } = await db
    .from("lead_assignment_table_configs")
    .select(
      "id, account_id, flow_id, enabled, mode, timezone, whatsapp_template_name, whatsapp_template_language",
    )
    .eq("account_id", accountId)
    .eq("flow_id", flowId)
    .maybeSingle();
  if (error) throw error;
  if (!config) return null;
  const row = config as Record<string, unknown>;
  const { data: assignees, error: assigneeErr } = await db
    .from("lead_assignment_table_assignees")
    .select(
      "id, config_id, user_id, display_name, email, phone, position, weight, is_active, paused_until, pause_reason, pause_scope, notify_email, notify_whatsapp",
    )
    .eq("config_id", row.id as string)
    .order("position", { ascending: true });
  if (assigneeErr) throw assigneeErr;
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    flow_id: row.flow_id as string,
    kind: flow.kind,
    form_db_id: flow.formDbId,
    enabled: (row.enabled as boolean) === true,
    mode: (row.mode as string) === "percentage" ? "percentage" : "round_robin",
    timezone: (row.timezone as string) || "UTC",
    whatsapp_template_name: (row.whatsapp_template_name as string | null) ?? null,
    whatsapp_template_language:
      (row.whatsapp_template_language as string) || "en_US",
    assignees: ((assignees ?? []) as Record<string, unknown>[]).map(toAssigneeRow),
  };
}

/**
 * Create or replace one table's assignment settings. Assignees are
 * replaced wholesale (positions = array order); algorithm state,
 * historical leads, and events are preserved. Only this table's
 * rows are touched (config upsert is keyed on account+flow, and
 * assignees are deleted/inserted strictly under that config id).
 */
export async function saveTableConfig(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    input: TableConfigInput;
  },
): Promise<TableConfigDetail> {
  const flow = await resolveTableFlow(db, args.accountId, args.flowId);
  if (!flow) {
    const err = new Error("Table not found.") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  const valid: ValidTableConfig = validateTableConfig(args.input);

  // Internal links must be live members of THIS account (roster =
  // Settings → Team Members). External-only rows need no roster
  // check — they are notifications-only by construction.
  const linkedIds = valid.assignees
    .map((a) => a.user_id)
    .filter((id): id is string => typeof id === "string");
  if (linkedIds.length > 0) {
    const { data: roster, error: rosterErr } = await db
      .from("profiles")
      .select("user_id")
      .eq("account_id", args.accountId)
      .in("user_id", linkedIds);
    if (rosterErr) throw rosterErr;
    const found = new Set(
      ((roster ?? []) as Array<{ user_id: string }>).map((p) => p.user_id),
    );
    const missing = linkedIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error("One or more linked team members are not in this company.");
    }
  }

  const { data: config, error } = await db
    .from("lead_assignment_table_configs")
    .upsert(
      {
        account_id: args.accountId,
        flow_id: args.flowId,
        enabled: valid.enabled,
        mode: valid.mode,
        timezone: valid.timezone,
        whatsapp_template_name: valid.whatsapp_template_name,
        whatsapp_template_language: valid.whatsapp_template_language,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "account_id,flow_id" },
    )
    .select("id")
    .single();
  if (error) throw error;
  const configId = (config as { id: string }).id;

  const { error: deleteErr } = await db
    .from("lead_assignment_table_assignees")
    .delete()
    .eq("config_id", configId);
  if (deleteErr) throw deleteErr;
  if (valid.assignees.length > 0) {
    const { error: insertErr } = await db
      .from("lead_assignment_table_assignees")
      .insert(
        valid.assignees.map((a, index) => ({
          config_id: configId,
          user_id: a.user_id,
          display_name: a.display_name,
          email: a.email,
          phone: a.phone,
          position: index,
          weight: valid.mode === "percentage" ? a.weight : 0,
          is_active: a.is_active,
          notify_email: a.notify_email,
          notify_whatsapp: a.notify_whatsapp,
        })),
      );
    if (insertErr) throw insertErr;
  }
  // Lazily ensure the algorithm state row exists so the first
  // assignment never pays for a racy init (insert is unique-keyed;
  // a concurrent saver wins and we simply proceed).
  await db.from("lead_assignment_table_config_state").upsert(
    { config_id: configId },
    { onConflict: "config_id" },
  );

  const detail = await getTableConfig(db, args.accountId, args.flowId);
  if (!detail) throw new Error("Assignment settings could not be reloaded after saving.");
  return detail;
}

/**
 * Pause or resume one assignee of THIS table. The assignee id is
 * resolved strictly under this table's config — a guessed id from
 * another table (or tenant) resolves to 404. Resuming clears the
 * window immediately; pausing with scope "account" blocks the same
 * person/contact on every table of the account (default "table"
 * affects only this table).
 */
export async function pauseTableAssignee(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowId: string;
    assigneeId: string;
    input: PauseInput;
  },
): Promise<TableAssigneeRow> {
  const detail = await getTableConfig(db, args.accountId, args.flowId);
  if (!detail) {
    const err = new Error("Table not found.") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  const target = detail.assignees.find((a) => a.id === args.assigneeId);
  if (!target) {
    const err = new Error("Assignee not found.") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  const pause: ValidPause = validatePauseInput(args.input);
  // Pauses are computed in the table's own timezone unless the
  // request carries an explicit one.
  const effective: ValidPause =
    args.input.timezone === undefined
      ? validatePauseInput({ ...args.input, timezone: detail.timezone })
      : pause;
  const { data, error } = await db
    .from("lead_assignment_table_assignees")
    .update({
      paused_until: effective.paused_until,
      pause_reason: effective.reason,
      pause_scope: effective.scope,
      updated_at: new Date().toISOString(),
    })
    .eq("id", target.id)
    .eq("config_id", detail.id)
    .select(
      "id, config_id, user_id, display_name, email, phone, position, weight, is_active, paused_until, pause_reason, pause_scope, notify_email, notify_whatsapp",
    )
    .single();
  if (error) throw error;
  return toAssigneeRow(data as Record<string, unknown>);
}
