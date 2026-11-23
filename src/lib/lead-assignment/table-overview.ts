// ============================================================
// Table Assignments — overview model (pure, no React, no I/O).
//
// Central management page for the owner: one row per Meta Lead Ads
// Workspace table with its assignment configuration summarized.
// Every rule below mirrors the existing assignment system — nothing
// is invented here:
//
// - Source of truth: lead_assignment_table_configs (one row per
//   (account_id, flow_id)) + lead_assignment_table_assignees.
//   Method is `mode` ('round_robin' | 'percentage'); there is no
//   stored "manual" mode.
// - "Manual" is the dialog's own convention for a DISABLED config
//   (TableAssignmentDialog renders `enabled ? "Automatic" :
//   "Manual"` and Active/Paused in the review footer). The
//   management page follows the same convention.
// - Status: Active = enabled config with at least one saved
//   recipient. Paused = an existing config that is explicitly
//   disabled (enabled=false). Not Configured = no config row, or a
//   config with zero saved recipients (nothing can be assigned).
//   There is no table-level "inactive" state in the backend; the
//   red third-state pill renders the spec's "Not Configured".
// - Assigned Tables KPI = config exists AND >= 1 saved recipient
//   (paused configs with recipients still count — pausing stops
//   future assignment but the configuration exists). Unassigned =
//   Total - Assigned.
// - Distinct assignees are deduplicated by the same stable
//   salesperson identity the engine uses (user_id, else
//   lowercased email, else phone digits). External (user_id NULL)
//   recipients count exactly like members; legacy rows are never
//   dropped by the listing.
// ============================================================

import { salespersonKeyFor } from "@/lib/meta-lead-whatsapp/assignee-sequences";

export type TableAssignmentStatus = "active" | "paused" | "not_configured";

export type TableAssignmentMethod = "percentage" | "round_robin" | "manual" | null;

export interface OverviewAssignee {
  id: string;
  user_id: string | null;
  display_name: string;
  weight: number;
  is_active: boolean;
  email?: string | null;
  phone?: string | null;
}

export interface OverviewTableInput {
  flowId: string;
  tableName: string;
  formName?: string | null;
  config: {
    enabled: boolean;
    mode: "round_robin" | "percentage";
    whatsapp_template_name: string | null;
    updated_at: string | null;
  } | null;
  assignees: OverviewAssignee[];
}

/** True when the table counts as Assigned for the KPI + Assigned bucket. */
export function hasConfiguredRecipients(input: Pick<OverviewTableInput, "config" | "assignees">): boolean {
  return input.config !== null && input.assignees.length > 0;
}

export function deriveTableStatus(input: Pick<OverviewTableInput, "config" | "assignees">): TableAssignmentStatus {
  if (input.config === null) return "not_configured";
  if (!input.config.enabled) return "paused";
  if (input.assignees.length === 0) return "not_configured";
  return "active";
}

export function statusLabel(status: TableAssignmentStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "not_configured":
      return "Not Configured";
  }
}

/**
 * Display method for the Method column. Follows the dialog's own
 * convention: a disabled config reads "Manual" (the dialog header
 * shows Automatic vs Manual from the same enabled flag). No config
 * (or nothing usable to distribute to) renders "—".
 */
export function deriveMethodLabel(input: Pick<OverviewTableInput, "config" | "assignees">): string {
  if (input.config === null) return "—";
  if (!input.config.enabled) return "Manual";
  if (input.assignees.length === 0) return "—";
  return input.config.mode === "percentage" ? "Percentage" : "Round Robin";
}

/** Raw method key for the Method filter (null = no stored method applies). */
export function deriveMethodKey(
  input: Pick<OverviewTableInput, "config" | "assignees">,
): "percentage" | "round_robin" | "manual" | null {
  if (input.config === null) return null;
  if (!input.config.enabled) return "manual";
  if (input.assignees.length === 0) return null;
  return input.config.mode;
}

/**
 * "Equal (X% each)" for round robin with n recipients — the same
 * share every member converges to. Trimmed (50%, 33.3%, 16.7%)
 * rather than repeating decimals.
 */
export function equalShareLabel(count: number): string {
  if (count <= 0) return "Equal";
  const share = 100 / count;
  const text = Number.isInteger(share)
    ? String(share)
    : String(Math.round(share * 10) / 10);
  return `Equal (${text}% each)`;
}

/**
 * Allocation cell text. Active percentage tables show actual saved
 * shares ("Pooja: 40% · Rishita: 30%"); active round robin shows
 * the equal share; anything not actively assigning shows the
 * honest reason instead of an invented split.
 */
export function allocationText(input: Pick<OverviewTableInput, "config" | "assignees">): string {
  const status = deriveTableStatus(input);
  if (status !== "active" || input.config === null) {
    return status === "paused" ? "No auto assignment" : "—";
  }
  if (input.config.mode === "round_robin") {
    return equalShareLabel(input.assignees.length);
  }
  return input.assignees
    .map((a) => `${a.display_name}: ${a.weight}%`)
    .join(" · ");
}

/** Stable dedupe key for one assignee (engine identity; null when unidentifiable). */
export function assigneeDedupeKey(a: Pick<OverviewAssignee, "user_id"> & { email?: string | null; phone?: string | null }): string | null {
  return salespersonKeyFor({ user_id: a.user_id, email: a.email ?? null, phone: a.phone ?? null });
}

export interface TableAssignmentKpis {
  total: number;
  assigned: number;
  unassigned: number;
  distinctAssignees: number;
}

export function computeKpis(tables: ReadonlyArray<Pick<OverviewTableInput, "config" | "assignees">>): TableAssignmentKpis {
  const total = tables.length;
  let assigned = 0;
  const seen = new Set<string>();
  for (const t of tables) {
    if (hasConfiguredRecipients(t)) assigned += 1;
    for (const a of t.assignees) {
      const key = assigneeDedupeKey(a);
      if (key !== null) seen.add(key);
    }
  }
  return { total, assigned, unassigned: total - assigned, distinctAssignees: seen.size };
}

export type AssignmentMethodFilter = "all" | "percentage" | "round_robin" | "manual";
export type AssignmentStatusFilter = "all" | TableAssignmentStatus;

export interface OverviewTableFilters {
  search: string;
  method: AssignmentMethodFilter;
  status: AssignmentStatusFilter;
}

/**
 * One normalized listing row for the Table Assignments page.
 * The page model is camelCase (flowId/tableName/formName); the
 * listing endpoint returns exactly this shape. The normalizer
 * below additionally accepts the legacy snake_case wire shape
 * (flow_id/flow_name/table_name) so a key mismatch can never
 * blank the table column again — it always resolves a display
 * name or drops the row when the flow identity is missing.
 */
export interface NormalizedAssignmentTable {
  flowId: string;
  tableName: string;
  formName: string | null;
  config: {
    id: string;
    enabled: boolean;
    mode: "round_robin" | "percentage";
    whatsapp_template_name: string | null;
    whatsapp_template_language: string;
    updated_at: string | null;
  } | null;
  assignees: OverviewAssignee[];
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalize one raw listing payload row into the page model.
 * Returns null when the flow identity is missing (a row without
 * a flow id can never be displayed, edited, or paused — the page
 * drops it instead of firing requests against an undefined id).
 * The display name prefers the verbatim Workspace table name and
 * never surfaces a form UUID.
 */
export function normalizeAssignmentTableRow(raw: unknown): NormalizedAssignmentTable | null {
  const r = asRecord(raw);
  if (!r) return null;
  const flowId =
    nonBlankString(r.flowId) ?? nonBlankString(r.flow_id);
  if (flowId === null) return null;

  const tableName =
    nonBlankString(r.tableName) ??
    nonBlankString(r.flow_name) ??
    nonBlankString(r.flowName) ??
    nonBlankString(r.table_name) ??
    nonBlankString(r.formName) ??
    nonBlankString(r.form_name) ??
    "Untitled table";
  const formName =
    nonBlankString(r.formName) ?? nonBlankString(r.form_name) ?? null;

  let config: NormalizedAssignmentTable["config"] = null;
  const c = asRecord(r.config);
  if (c) {
    const id = nonBlankString(c.id);
    if (id !== null) {
      config = {
        id,
        enabled: c.enabled === true,
        mode: c.mode === "percentage" ? "percentage" : "round_robin",
        whatsapp_template_name: nonBlankString(c.whatsapp_template_name),
        whatsapp_template_language:
          nonBlankString(c.whatsapp_template_language) ?? "en_US",
        updated_at:
          typeof c.updated_at === "string" ? c.updated_at : null,
      };
    }
  }

  const assignees: OverviewAssignee[] = [];
  if (Array.isArray(r.assignees)) {
    for (const entry of r.assignees) {
      const a = asRecord(entry);
      if (!a) continue;
      const id = nonBlankString(a.id);
      if (id === null) continue;
      assignees.push({
        id,
        user_id:
          a.user_id === null || typeof a.user_id === "string" ? a.user_id : null,
        display_name: nonBlankString(a.display_name) ?? "Unnamed",
        weight: typeof a.weight === "number" ? a.weight : 0,
        is_active: a.is_active !== false,
      });
    }
  }

  return { flowId, tableName, formName, config, assignees };
}

/** Client-side search/filter over the (small, bounded) table list. */
export function filterOverviewTables<T extends OverviewTableInput>(
  tables: readonly T[],
  filters: OverviewTableFilters,
): T[] {
  const q = filters.search.trim().toLowerCase();
  return tables.filter((t) => {
    if (q !== "") {
      const hay = `${t.tableName} ${t.formName ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filters.method !== "all" && deriveMethodKey(t) !== filters.method) return false;
    if (filters.status !== "all" && deriveTableStatus(t) !== filters.status) return false;
    return true;
  });
}

const AVATAR_TONES = [
  "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
  "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300",
];

/** Initials for the compact assignee avatar (first letters of first two words). */
export function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

/** Deterministic pastel tone per assignee identity (display only). */
export function avatarToneFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}
