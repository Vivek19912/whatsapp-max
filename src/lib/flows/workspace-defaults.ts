// ============================================================
// Workspace default business columns — the sales columns every
// flow's Workspace ships with (Assigned To … Final Remark, plus
// Lead Received).
//
// Design notes:
//   - Defaults are ORDINARY workspace_fields rows (same table,
//     same RLS, same visibility ids `custom:<uuid>`). After
//     provisioning they behave exactly like user-created columns:
//     hideable, editable, persistent — never locked, never core.
//   - Completed and Incomplete are views over the SAME flow's
//     fields, so one provisioning per (account, flow) serves both.
//     No per-view records are ever created.
//   - Recognition is deterministic: the canonical lowercase name
//     set below. An existing field with the same name
//     (case-insensitive) is treated as the user's own — it is
//     never overwritten, never duplicated.
//   - Renames are applied IN PLACE (same row id, position, and
//     values): "Lead Quality" → "Lead Type" and
//     "Quotation / Package" → "Stage" keep every stored value
//     readable — values outside the new option sets (e.g. "Fake",
//     "Sent") render as plain text, never deleted. No migration,
//     no data rewrite.
//   - Google Sheets is untouched: provisioning writes ONLY to
//     workspace_fields, which Sheets never reads (migration 088).
//   - "Assigned To" is single_select with a single structural
//     "Unassigned" option, mirroring the deals Assigned-To
//     convention (deal-form "Unassigned" default). The dropdown
//     itself is DYNAMIC: Workspace loads the live account roster
//     from GET /api/account/members (the Team Members source of
//     truth) and stores the stable member user_id per cell —
//     member names are never duplicated into field options.
//   - "No. of Calls Tried" is a single_select dropdown with
//     exactly the options 1–10 (strings "1" … "10"). Free numeric
//     entry is intentionally NOT allowed — one pick, no arbitrary
//     text. Pre-existing numeric values 1–10 already store in that
//     exact form, so they carry over untouched (migration 096
//     converts the column type and reports — never rewrites —
//     any out-of-range legacy values).
//   - "Lead Type" is a single_select dropdown with exactly
//     ["Fresh", "Hot", "Warm", "Cold", "Prospect"]. Pre-existing
//     "Lead Quality" values (Hot/Warm/Cold carry over as options;
//     anything else, e.g. "Fake") stay stored and readable.
//   - "Stage" is a single_select dropdown with exactly the 14
//     lifecycle options. Pre-existing "Quotation / Package"
//     values stay stored and readable.
//   - "Lead Received" is a single_select dropdown with exactly
//     the 12 source options. Cells with no stored value display
//     an auto-detected default (Facebook/Instagram ad platform,
//     derived read-only from the contact) without ever writing
//     it back; a manual pick is stored and never overwritten.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { WorkspaceFieldType } from "./workspace-fields";
import { isAssigneeField } from "./workspace-assignee";

export interface WorkspaceDefaultSpec {
  /** Display label. Uniqueness key (case-insensitive) per flow. */
  name: string;
  field_type: WorkspaceFieldType;
  /** Select options. Null for non-select types. */
  options: string[] | null;
  /**
   * Read-only display/select default for genuinely empty cells.
   * Applied ONLY at read time (displayWorkspaceValue fallback) —
   * provisioning writes it onto newly inserted rows, but existing
   * rows and stored values are never backfilled or overwritten.
   */
  default_value?: string | null;
}

/**
 * Exact dropdown options for "No. of Calls Tried": the strings
 * "1" … "10", in order. Stored cell values use this exact form
 * (single_select validates by equality), so pre-existing numeric
 * entries 1–10 need no conversion.
 */
export const CALLS_TRIED_OPTIONS: readonly string[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
];

/** Exact dropdown options for "Quotation / Package" (legacy — kept for reference). */
export const QUOTATION_OPTIONS: readonly string[] = ["Sent", "Not Yet"];

/** Exact dropdown options for "Lead Type", in order. */
export const LEAD_TYPE_OPTIONS: readonly string[] = [
  "Fresh",
  "Hot",
  "Warm",
  "Cold",
  "Prospect",
];

/** Exact dropdown options for "Stage", in order. */
export const STAGE_OPTIONS: readonly string[] = [
  "New Lead",
  "Contacted",
  "Qualified",
  "Quotation Required",
  "Quotation Sent",
  "In Negotiation",
  "Ready To Book",
  "Booking Confirmed",
  "Follow Up",
  "Amendment",
  "Lost",
  "Cancelled",
  "Invalid",
  "On Hold",
  "Not connected",
];

/** Exact dropdown options for "Lead Received", in order. */
export const LEAD_RECEIVED_OPTIONS: readonly string[] = [
  "Website",
  "Social Media",
  "Facebook Ads",
  "Instagram Ads",
  "Google Ads",
  "Whatsapp",
  "Phone Call",
  "Referral",
  "Walk In",
  "Repeat Customer",
  "Partner",
  "Other",
];

export const WORKSPACE_DEFAULT_FIELDS: readonly WorkspaceDefaultSpec[] = [
  { name: "Assigned To", field_type: "single_select", options: ["Unassigned"] },
  {
    name: "Call Status",
    field_type: "single_select",
    options: [
      "Connected",
      "Not Answering",
      "Switched Off",
      "Busy",
      "Call Back Later",
      "Invalid Number",
    ],
  },
  { name: "No. of Calls Tried", field_type: "single_select", options: [...CALLS_TRIED_OPTIONS] },
  {
    name: "Lead Type",
    field_type: "single_select",
    options: [...LEAD_TYPE_OPTIONS],
    default_value: "Fresh",
  },
  {
    name: "Stage",
    field_type: "single_select",
    options: [...STAGE_OPTIONS],
    default_value: "New Lead",
  },
  {
    name: "Follow-Up Status",
    field_type: "single_select",
    options: [
      "Follow-up Pending",
      "Negotiation Going On",
      "Booked",
      "Lost",
      "No Plan",
    ],
  },
  { name: "Last Contact Date", field_type: "date", options: null },
  { name: "Customer Response", field_type: "text", options: null },
  { name: "Next Follow-up Date & Time", field_type: "datetime", options: null },
  { name: "Next Action", field_type: "text", options: null },
  {
    name: "Reason for Lost Lead",
    field_type: "single_select",
    options: [
      "Budget Issue",
      "No Response",
      "Already Booked Elsewhere",
      "Date Issue",
      "Just Inquiry",
      "Travel Cancelled",
    ],
  },
  { name: "Final Remark", field_type: "text", options: null },
  {
    name: "Lead Received",
    field_type: "single_select",
    options: [...LEAD_RECEIVED_OPTIONS],
  },
];

/**
 * Canonical lookup of system-provided default names
 * (lowercased + trimmed). Used to recognize equivalents without
 * touching them — a user field with the same name suppresses the
 * corresponding default insert for that flow.
 */
export const WORKSPACE_DEFAULT_NAMES: ReadonlySet<string> = new Set(
  WORKSPACE_DEFAULT_FIELDS.map((f) => f.name.trim().toLowerCase()),
);

export function isWorkspaceDefaultName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    WORKSPACE_DEFAULT_NAMES.has(name.trim().toLowerCase())
  );
}

export interface WorkspaceDefaultEnsureResult {
  /** Names (display case) that were inserted by this call. */
  created: string[];
  /** Names (display case) renamed in place by this call. */
  renamed: string[];
}

/**
 * Display name of the "Lead Received" default column.
 * Case-insensitive matching follows the isAssigneeField convention.
 */
export const LEAD_RECEIVED_FIELD_NAME = "Lead Received";

/** True for the "Lead Received" Workspace column (case-insensitive). */
export function isLeadReceivedField(field: { name: string }): boolean {
  return (
    field.name.trim().toLowerCase() ===
    LEAD_RECEIVED_FIELD_NAME.trim().toLowerCase()
  );
}

/**
 * Stored name of the "Lead Type" default column (displayed as
 * "Type" — see column-label aliases). Case-insensitive matching
 * follows the isAssigneeField convention.
 */
export const LEAD_TYPE_FIELD_NAME = "Lead Type";

/** True for the "Lead Type" Workspace column (case-insensitive). */
export function isLeadTypeField(field: { name: string }): boolean {
  return (
    field.name.trim().toLowerCase() ===
    LEAD_TYPE_FIELD_NAME.trim().toLowerCase()
  );
}

/**
 * Stored name of the "Stage" default column. Case-insensitive
 * matching follows the isAssigneeField convention.
 */
export const STAGE_FIELD_NAME = "Stage";

/** True for the "Stage" Workspace column (case-insensitive). */
export function isStageField(field: { name: string }): boolean {
  return (
    field.name.trim().toLowerCase() ===
    STAGE_FIELD_NAME.trim().toLowerCase()
  );
}

/** Read-only display/select default for empty Type cells. */
export const LEAD_TYPE_DEFAULT_VALUE = "Fresh";

/** Read-only display/select default for empty Stage cells. */
export const LEAD_STAGE_DEFAULT_VALUE = "New Lead";

/**
 * Identity-based display default for the Type/Stage business
 * columns. Returns "Fresh" for Type fields and "New Lead" for
 * Stage fields (matched by stored-name identity, never display
 * labels), else null. Pure and read-only: callers apply it ONLY
 * when both the stored value and the field's own default_value
 * are empty, so saved picks (Hot, Qualified, …) always win and
 * nothing is ever written back. Fields provisioned after these
 * defaults shipped already carry them as default_value; this
 * covers rows whose field row predates that (default_value null).
 */
export function defaultBusinessValue(field: { name: string }): string | null {
  if (isLeadTypeField(field)) return LEAD_TYPE_DEFAULT_VALUE;
  if (isStageField(field)) return LEAD_STAGE_DEFAULT_VALUE;
  return null;
}

/**
 * Display order for business/workspace columns (Group 3 of the
 * Workspace table): Assigned To, Received ("Lead Received"), Type
 * ("Lead Type"), Stage first — matched by STABLE STORED-NAME
 * identity (case-insensitive matchers above), never by display
 * labels — then every remaining field in its existing relative
 * order. Pure and stable: the input array is never mutated, and
 * ties keep their original sequence (single-pass partition, no
 * alphabetical sort). Display-only: positions, visibility,
 * widths, values, Sheets, Travel CRM, filters, and search all
 * keep working on the original field identities.
 */
export function orderBusinessColumns<T extends { name: string }>(
  fields: readonly T[],
): T[] {
  const assigned: T[] = [];
  const received: T[] = [];
  const typed: T[] = [];
  const staged: T[] = [];
  const rest: T[] = [];
  for (const f of fields) {
    if (isAssigneeField(f)) assigned.push(f);
    else if (isLeadReceivedField(f)) received.push(f);
    else if (isLeadTypeField(f)) typed.push(f);
    else if (isStageField(f)) staged.push(f);
    else rest.push(f);
  }
  return [...assigned, ...received, ...typed, ...staged, ...rest];
}

/**
 * Auto-detected display default for "Lead Received" from an ad
 * platform. Read-only: callers show it when the cell has no stored
 * value and must never write it back — a manual pick is stored
 * and always wins.
 */
export function receivedDefaultLabel(
  platform: "facebook" | "instagram" | "other" | null | undefined,
): string | null {
  if (platform === "facebook") return "Facebook Ads";
  if (platform === "instagram") return "Instagram Ads";
  return null;
}

/**
 * Legacy default rows renamed in place to their successor spec.
 * The row keeps its id, position, and every stored value — only
 * the label and option set change. Stored values outside the new
 * options stay readable as plain text (never deleted).
 *
 * A rename fires ONLY when the existing row still carries the
 * legacy default options: a same-named field with different
 * options is the user's own customization and is left alone
 * (the successor is then provisioned fresh beside it).
 */
const RENAMED_DEFAULT_SPECS: ReadonlyArray<{
  from: string;
  legacyOptions: readonly string[];
  to: (typeof WORKSPACE_DEFAULT_FIELDS)[number];
}> = [
  {
    from: "Lead Quality",
    legacyOptions: ["Hot", "Warm", "Cold", "Fake"],
    to: WORKSPACE_DEFAULT_FIELDS.find((s) => s.name === "Lead Type")!,
  },
  {
    from: "Quotation / Package",
    legacyOptions: ["Sent", "Not Yet"],
    to: WORKSPACE_DEFAULT_FIELDS.find((s) => s.name === "Stage")!,
  },
];

function sameOptions(a: readonly string[] | null | undefined, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const left = [...a].map(String).sort();
  const right = [...b].map(String).sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * Provision the default business columns for one flow's
 * Workspace. Idempotent and safe to call on every Workspace load:
 *
 *   - legacy default rows ("Lead Quality", "Quotation / Package")
 *     are renamed in place to their successors ("Lead Type",
 *     "Stage") — same id, position, and stored values; only the
 *     label and option set change. Stored values outside the new
 *     options stay readable as plain text (never deleted);
 *   - every other existing field (user or default) is never
 *     modified;
 *   - a user field whose name matches a default (case-insensitive)
 *     suppresses that default — no duplicates, no overwrites;
 *   - missing defaults are appended after the current max
 *     position, so existing column order is never disturbed;
 *   - concurrent callers racing the same insert hit the
 *     (account, flow, lower(name)) unique index — the 23505
 *     conflict is swallowed, not surfaced.
 *
 * Only writes to `workspace_fields` (never values, flows, or
 * anything Sheets-related). Callers pass a client that can write
 * (service-role on the server); the (account_id, flow_id) scope
 * keeps tenant isolation explicit at the call site.
 */
export async function ensureWorkspaceDefaultFields(
  client: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<WorkspaceDefaultEnsureResult> {
  const { data: existing, error: readErr } = await client
    .from("workspace_fields")
    .select("id, name, position, options")
    .eq("account_id", accountId)
    .eq("flow_id", flowId);
  if (readErr) throw readErr;

  const seen = new Set<string>();
  const byLower = new Map<string, { id: string; options: readonly string[] | null }>();
  let maxPosition = -1;
  for (const row of (existing ?? []) as Array<{
    id: string;
    name: string;
    position: number | null;
    options?: readonly string[] | null;
  }>) {
    if (typeof row.name === "string") {
      seen.add(row.name.trim().toLowerCase());
      byLower.set(row.name.trim().toLowerCase(), {
        id: row.id,
        options: Array.isArray(row.options) ? row.options : null,
      });
    }
    if (typeof row.position === "number" && row.position > maxPosition) {
      maxPosition = row.position;
    }
  }

  // Rename-in-place first: legacy default rows adopt the successor
  // label + option set (same id, position, values). Skipped when
  // the successor already exists — never duplicated, never merged.
  const renamed: string[] = [];
  for (const { from, legacyOptions, to } of RENAMED_DEFAULT_SPECS) {
    const fromLower = from.trim().toLowerCase();
    const toLower = to.name.trim().toLowerCase();
    const fromRow = byLower.get(fromLower);
    if (!fromRow || seen.has(toLower)) continue;
    if (!sameOptions(fromRow.options, legacyOptions)) continue;
    const { error: renameErr } = await client
      .from("workspace_fields")
      .update({ name: to.name, options: to.options })
      .eq("id", fromRow.id);
    // Lost a race that created the successor meanwhile — the
    // unique index kept us duplicate-free; treat as success.
    if (renameErr && (renameErr as { code?: string }).code !== "23505") {
      throw renameErr;
    }
    if (!renameErr) {
      seen.add(toLower);
      byLower.set(toLower, fromRow);
      renamed.push(to.name);
    }
  }

  const missing = WORKSPACE_DEFAULT_FIELDS.filter(
    (spec) => !seen.has(spec.name.trim().toLowerCase()),
  );
  if (missing.length === 0) return { created: [], renamed };

  const { error: insertErr } = await client.from("workspace_fields").insert(
    missing.map((spec, i) => ({
      account_id: accountId,
      flow_id: flowId,
      name: spec.name,
      field_type: spec.field_type,
      position: maxPosition + 1 + i,
      options: spec.options,
      // Spec display defaults (Type → Fresh, Stage → New Lead) ride
      // along ONLY on newly inserted rows. Existing rows are never
      // touched here — no backfill, no overwrite.
      default_value: spec.default_value ?? null,
      currency_code: null,
    })),
  );
  // Lost a race with another provisioner — the unique index kept
  // us duplicate-free; treat as success with nothing new to show.
  if (insertErr && (insertErr as { code?: string }).code !== "23505") {
    throw insertErr;
  }
  return { created: missing.map((spec) => spec.name), renamed };
}
