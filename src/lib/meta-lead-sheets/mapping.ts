// ============================================================
// Meta Lead Ads → Google Sheets — row mapping.
//
// Pure: Workspace submission + run + roster → the 12 fixed sheet
// cells in META_SHEETS_HEADERS order. Column A (Meta Lead ID) is
// the stable unique key — never phone/name. All fields come from
// the real Meta Workspace records; nothing is invented.
//
//   * Submitted At is IST ("2:25 PM, 14 Jul 2026"), same format as
//     Flow Tables sheets.
//   * Assigned To resolves the stored member user_id to the current
//     roster name; "Unassigned"/unknown stays as-is, empty → "".
//   * Lead Type / Stage fall back to the Workspace display defaults
//     ("Fresh" / "New Lead") so the sheet matches the table.
// ============================================================

import { standardContactFromAnswers } from "@/lib/meta-lead-ads/normalize";

import {
  answerFieldKey,
  DEFAULT_SHEETS_COLUMNS,
  projectRowValues,
} from "./columns";

/**
 * Format a timestamp as India Standard Time for the "Submitted At"
 * cell, time first, e.g. "2:25 PM, 14 Jul 2026". Local duplicate of
 * the Flow Tables formatter (which we deliberately do not import so
 * this stack stays independent of Flow Tables). Falls back to empty
 * string on a bad input.
 */
function formatSubmittedAtIST(input: string | null): string {
  if (!input) return "";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  const date = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
  return `${time}, ${date}`;
}

export interface SheetsLeadInput {
  metaLeadId: string;
  submittedAt: string | null;
  answers: Record<string, string>;
  formName: string | null;
  campaignName: string | null;
  adName: string | null;
  source: string | null;
  assigneeDisplay: string | null;
  leadType: string | null;
  stage: string | null;
}

/** Build the 12-cell row in header order (legacy default layout). */
export function buildSheetsRow(input: SheetsLeadInput): string[] {
  return projectRowValues(buildLeadFieldMap(input), DEFAULT_SHEETS_COLUMNS);
}

/**
 * Full field map for one lead: standard keys plus `answer:<key>`
 * entries for every stored answer. Projection onto the visible
 * columns happens separately, so renaming/reordering labels never
 * affects mapping. Pure.
 */
export function buildLeadFieldMap(input: SheetsLeadInput): Record<string, string> {
  const standard = standardContactFromAnswers(input.answers);
  const map: Record<string, string> = {
    meta_lead_id: input.metaLeadId,
    submitted_at: input.submittedAt ? formatSubmittedAtIST(input.submittedAt) : "",
    name: standard.name ?? "",
    phone: standard.phone ?? "",
    email: standard.email ?? "",
    form_name: input.formName ?? "",
    campaign_name: input.campaignName ?? "",
    ad_name: input.adName ?? "",
    source: input.source ?? "",
    assignee: input.assigneeDisplay ?? "",
    lead_type: input.leadType ?? "Fresh",
    stage: input.stage ?? "New Lead",
  };
  for (const [key, value] of Object.entries(input.answers)) {
    if (typeof value === "string" && key.trim() !== "") {
      map[answerFieldKey(key)] = value;
    }
  }
  return map;
}

/** Display label for the stored source enum. */
export function sheetsSourceLabel(source: string | null): string {
  if (source === "facebook") return "Facebook";
  if (source === "instagram") return "Instagram";
  if (source === "unknown" || !source) return "Other";
  const trimmed = source.trim();
  return trimmed === "" ? "Other" : trimmed;
}

export interface WorkspaceFieldLite {
  id: string;
  name: string;
}

export interface WorkspaceValueLite {
  field_id: string;
  value_text: string | null;
}

function fieldValueByName(
  fields: WorkspaceFieldLite[],
  values: WorkspaceValueLite[],
  matcher: (name: string) => boolean,
): string | null {
  const field = fields.find((f) => matcher(f.name ?? ""));
  if (!field) return null;
  const row = values.find((v) => v.field_id === field.id);
  const text = (row?.value_text ?? "").trim();
  return text === "" ? null : text;
}

const isAssigneeName = (name: string) =>
  name.trim().toLowerCase() === "assigned to";
const isLeadTypeName = (name: string) =>
  name.trim().toLowerCase() === "lead type";
const isStageName = (name: string) => name.trim().toLowerCase() === "stage";

/**
 * Resolve Assigned To / Lead Type / Stage display values from the
 * run's workspace_values + account roster. Pure and Meta-scoped by
 * the caller (only Meta flow ids are passed in).
 */
export function resolveBusinessDisplays(args: {
  fields: WorkspaceFieldLite[];
  values: WorkspaceValueLite[];
  roster: Array<{ user_id: string; full_name: string | null }>;
}): { assigneeDisplay: string | null; leadType: string | null; stage: string | null } {
  const storedAssignee = fieldValueByName(args.fields, args.values, isAssigneeName);
  let assigneeDisplay: string | null = null;
  if (storedAssignee) {
    if (storedAssignee === "Unassigned") {
      assigneeDisplay = "Unassigned";
    } else {
      const member = args.roster.find((m) => m.user_id === storedAssignee);
      assigneeDisplay = member
        ? (member.full_name ?? "").trim() || "Unnamed"
        : storedAssignee;
    }
  }
  const leadType =
    fieldValueByName(args.fields, args.values, isLeadTypeName) ?? "Fresh";
  const stage = fieldValueByName(args.fields, args.values, isStageName) ?? "New Lead";
  return { assigneeDisplay, leadType, stage };
}
