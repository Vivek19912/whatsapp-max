// ============================================================
// Travel CRM integration — WACRM lead loading + owner resolution
// (Phase 1: WACRM side only).
//
// Server-only: resolves one Workspace lead by its stable identity
// (flow_run_id) under the authenticated account and assembles
// every input the mapper needs. The browser is never trusted for
// field values — everything comes from the database. No external
// requests happen here (or anywhere in Phase 1).
//
// Owner identity rule: the lead's "Assigned To" cell holds a
// member user_id (or Unassigned/nothing). The owner's email is
// read from that member's account-scoped `profiles` row and
// normalized (trim + lowercase) for future Travel CRM user
// matching. Nothing is guessed, hardcoded, or mapped by hand.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isAssigneeField, ASSIGNED_TO_UNASSIGNED } from "@/lib/flows/workspace-assignee";
import { adSourcePlatform as resolveAdSourcePlatform } from "@/lib/flows/workspace-ad-source";
import {
  buildFlowTableColumns,
  findFlowNameAnswerKey,
} from "@/lib/flows/flow-tables";
import type {
  WacrmAnswerSource,
  WacrmCustomSource,
} from "./mapping";

export type TravelCrmAssignmentIssue =
  | "assignment-required"
  | "owner-email-missing";

export interface TravelCrmLoadedLead {
  accountId: string;
  flowId: string;
  /** Flow kind (e.g. 'meta_lead_ads') for caller-side scoping. */
  flowKind: string | null;
  runId: string;
  createdBy: string | null;
  /** Stable contact identity for scoped writes (two-way dialog sync). */
  contactId: string | null;
  contact: { name: string | null; phone: string | null; email: string | null };
  answers: WacrmAnswerSource[];
  custom: WacrmCustomSource[];
  /**
   * Ad platform behind the Workspace Lead Source icon, derived
   * from the SAME contacts.source_url the column renders — the
   * single source of truth for icon-based Received inference.
   */
  adSourcePlatform: "facebook" | "instagram" | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  /** Normalized owner email, or null when unresolvable. */
  assignedOwnerEmail: string | null;
  assignmentIssue: TravelCrmAssignmentIssue | null;
  /**
   * Exact key of the flow-derived Workspace "Name" column for this
   * flow (via the same buildFlowTableColumns derivation the table
   * renders), or null when the flow has no such column. Drives
   * Travel CRM Name prefill: the column's answer wins, the
   * WhatsApp contact name is the fallback. Never a merge.
   */
  flowNameColumnKey: string | null;
}

/** Normalize an owner email for identity matching. */
export function normalizeOwnerEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

export type OwnerEmailResolution =
  | { status: "ok"; email: string; name: string | null }
  | { status: "unknown-member" }
  | { status: "no-email" };

/**
 * Resolve one team member to their normalized owner email within
 * the account. Shared by lead loading and dialog overrides so
 * both paths enforce the same membership rule.
 */
export async function resolveOwnerEmailByUserId(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<OwnerEmailResolution> {
  const { data: profile } = await db
    .from("profiles")
    .select("email, full_name")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!profile) return { status: "unknown-member" };
  const email = normalizeOwnerEmail(
    (profile as { email?: unknown } | null)?.email,
  );
  if (!email) return { status: "no-email" };
  const fullName = (profile as { full_name?: unknown } | null)?.full_name;
  return {
    status: "ok",
    email,
    name: typeof fullName === "string" && fullName.trim() ? fullName : null,
  };
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * Load one Workspace lead for the integration. Returns null when
 * the run does not exist under (accountId, flowId) — callers map
 * that to LEAD_NOT_FOUND without distinguishing the reason.
 */
export async function loadWorkspaceLead(
  db: SupabaseClient,
  args: { accountId: string; flowId: string; runId: string },
): Promise<TravelCrmLoadedLead | null> {
  const { accountId, flowId, runId } = args;

  const { data: flow, error: flowErr } = await db
    .from("flows")
    .select("id, account_id, entry_node_id, kind")
    .eq("id", flowId)
    .maybeSingle();
  if (flowErr || !flow) return null;
  if ((flow as { account_id: string }).account_id !== accountId) return null;
  const flowKind = (flow as { kind?: string | null }).kind ?? null;

  const { data: run, error: runErr } = await db
    .from("flow_runs")
    .select("id, flow_id, user_id, contact_id, vars")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !run) return null;
  const runRow = run as {
    id: string;
    flow_id: string;
    user_id: string | null;
    contact_id: string | null;
    vars: unknown;
  };
  if (runRow.flow_id !== flowId) return null;

  let contact = { name: null as string | null, phone: null as string | null, email: null as string | null };
  let adSourcePlatform: "facebook" | "instagram" | null = null;
  if (runRow.contact_id) {
    const { data: contactRow } = await db
      .from("contacts")
      .select("phone, name, email, source_url")
      .eq("id", runRow.contact_id)
      .maybeSingle();
    if (contactRow) {
      const c = contactRow as { phone?: unknown; name?: unknown; email?: unknown; source_url?: unknown };
      contact = {
        name: typeof c.name === "string" ? c.name : null,
        phone: typeof c.phone === "string" ? c.phone : null,
        email: typeof c.email === "string" ? c.email : null,
      };
      // Same derivation the Lead Source column icon uses — shared helper.
      const platform = resolveAdSourcePlatform(
        typeof c.source_url === "string" ? c.source_url : null,
      );
      adSourcePlatform = platform === "facebook" || platform === "instagram" ? platform : null;
    }
  }

  const { data: nodeRows } = await db
    .from("flow_nodes")
    .select("node_key, node_type, config, created_at")
    .eq("flow_id", flowId);
  const labelByKey = new Map<string, string>();
  for (const n of (nodeRows ?? []) as Array<{ node_key: string; config?: unknown }>) {
    const cfg = (n.config ?? {}) as Record<string, unknown>;
    for (const candidate of [cfg.header, cfg.label, cfg.title, cfg.var_key]) {
      if (typeof candidate === "string" && candidate.trim()) {
        labelByKey.set(n.node_key, candidate);
        break;
      }
    }
  }
  // Exact flow-derived Workspace "Name" column for this flow, via
  // the same derivation the table renders (read-only node reads —
  // no stored data changes). Null when the flow has no such column.
  const flowNodes = ((nodeRows ?? []) as Array<{
    node_key: string;
    node_type?: unknown;
    config?: unknown;
    created_at?: unknown;
  }>).map((n) => ({
    node_key: n.node_key,
    node_type: typeof n.node_type === "string" ? n.node_type : "",
    config: (n.config ?? {}) as Record<string, unknown>,
    created_at: typeof n.created_at === "string" ? n.created_at : null,
  }));
  const entryNodeId =
    typeof (flow as { entry_node_id?: unknown }).entry_node_id === "string"
      ? ((flow as { entry_node_id?: unknown }).entry_node_id as string)
      : null;
  const derivedColumns = buildFlowTableColumns(flowNodes, entryNodeId);
  const flowNameColumnKey = findFlowNameAnswerKey(derivedColumns.columns);
  const vars =
    runRow.vars && typeof runRow.vars === "object"
      ? { ...(runRow.vars as Record<string, unknown>) }
      : {};
  // Workspace flow overrides (agent edits in the table): the CURRENT
  // Workspace values Travel CRM must use — applied onto a COPY of
  // the submission vars, so flow_runs.vars (history) is never
  // mutated. Only keys that are still live answer columns apply;
  // overrides for deleted questions stay inert. flow_runs, Sheets,
  // and stored answers are untouched by this read.
  try {
    const { data: overrideRows } = await db
      .from("workspace_flow_overrides")
      .select("field_key, value_text")
      .eq("account_id", accountId)
      .eq("flow_id", flowId)
      .eq("flow_run_id", runId);
    const liveKeys = new Set(derivedColumns.answerKeys);
    for (const o of (overrideRows ?? []) as Array<{
      field_key: unknown;
      value_text: unknown;
    }>) {
      if (typeof o.field_key !== "string" || !liveKeys.has(o.field_key)) continue;
      vars[o.field_key] =
        typeof o.value_text === "string" ? o.value_text : null;
    }
  } catch {
    // Override read failure degrades to original answers — lead
    // creation still works, Travel CRM validates on send.
  }
  const answers: WacrmAnswerSource[] = Object.entries(vars).map(([key, raw]) => ({
    key,
    label: labelByKey.get(key) ?? null,
    value: textValue(raw),
  }));

  const { data: fieldRows } = await db
    .from("workspace_fields")
    .select("id, name, field_type, default_value")
    .eq("flow_id", flowId);
  const fields = (fieldRows ?? []) as Array<{
    id: string;
    name: string;
    field_type?: string | null;
    default_value?: unknown;
  }>;
  const { data: valueRows } = await db
    .from("workspace_values")
    .select("field_id, value_text")
    .eq("flow_run_id", runId);
  const valueByField = new Map<string, string | null>();
  for (const v of (valueRows ?? []) as Array<{ field_id: string; value_text: unknown }>) {
    valueByField.set(v.field_id, textValue(v.value_text));
  }
  const custom: WacrmCustomSource[] = fields.map((f) => ({
    id: f.id,
    name: f.name,
    value: valueByField.get(f.id) ?? null,
    defaultValue: typeof f.default_value === "string" ? f.default_value : null,
  }));

  // Assignment: the "Assigned To" custom value holds a member
  // user_id (or Unassigned/nothing). Anything else cannot resolve
  // to an owner email.
  let assignedUserId: string | null = null;
  let assignmentIssue: TravelCrmAssignmentIssue | null = null;
  let assignedUserName: string | null = null;
  let assignedOwnerEmail: string | null = null;
  const assigneeField = fields.find((f) => isAssigneeField({ name: f.name }));
  const stored = assigneeField
    ? (valueByField.get(assigneeField.id) ?? null)
    : null;
  const trimmed = typeof stored === "string" ? stored.trim() : "";
  if (!trimmed || trimmed === ASSIGNED_TO_UNASSIGNED) {
    assignmentIssue = "assignment-required";
  } else {
    assignedUserId = trimmed;
    const resolved = await resolveOwnerEmailByUserId(db, accountId, trimmed);
    if (resolved.status === "ok") {
      assignedUserName = resolved.name;
      assignedOwnerEmail = resolved.email;
    } else {
      assignmentIssue = "owner-email-missing";
    }
  }

  return {
    accountId,
    flowId,
    flowKind,
    runId,
    createdBy: runRow.user_id,
    contactId: runRow.contact_id,
    contact,
    answers,
    custom,
    adSourcePlatform,
    assignedUserId,
    assignedUserName,
    assignedOwnerEmail,
    assignmentIssue,
    flowNameColumnKey,
  };
}
