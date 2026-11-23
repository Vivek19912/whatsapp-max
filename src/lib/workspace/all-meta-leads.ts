// ============================================================
// All Meta Leads — virtual combined Workspace view (pure model).
//
// One virtual table combining leads from every Meta Lead Ads Instant
// Form table belonging to the authenticated account. No duplicate
// records, no copies, no flow/run rewrites: each row keeps its
// originating flowId + runId and all actions operate on the original.
//
// Identity: the virtual selector id is the non-UUID constant
// `ALL_META_LEADS_ID` (flow ids are UUIDs, so it can never collide).
// Backend canonical source is `meta_lead_submissions`
// (account_id + meta_lead_id), joined to the authoritative processed
// `flow_runs` row. Only `status = 'processed'` rows with a live
// `flow_run_id` surface; failed/ignored/NULL/deleted runs never do.
//
// Form Answers mapping: each lead displays answers through its OWN
// form's question definitions (meta_lead_forms.questions) aligned by
// the deterministic `questionVarKeys` derivation (same as virtual-flow
// materialization). Identity keys (name/phone) and Source are excluded
// from Form Answers — they have dedicated columns. Legacy/unmapped
// vars keys are preserved with a fallback question rather than dropped.
//
// Pure + dependency-free (except shared Meta helpers) — unit tested
// directly. Flow Tables and individual Meta tables never import this.
// ============================================================

import {
  EMAIL_KEYS,
  FULL_NAME_KEYS,
  PHONE_KEYS,
} from "@/lib/meta-lead-ads/normalize";
import {
  META_SOURCE_COLUMN_KEY,
} from "@/lib/meta-lead-ads/virtual-flow";
import type { FlowTableColumn } from "@/lib/flows/flow-tables";
import {
  CALL_STATUS_OPTIONS,
  FOLLOW_UP_STATUS_OPTIONS,
  LEAD_TYPE_DEFAULT_VALUE,
  LEAD_TYPE_OPTIONS,
  LEAD_STAGE_DEFAULT_VALUE,
  STAGE_OPTIONS,
} from "@/lib/flows/workspace-defaults";

/** Virtual selector id for the combined view (never a real flow UUID). */
export const ALL_META_LEADS_ID = "all-meta-leads";

/** Display label for the virtual selector option (first in the list). */
export const ALL_META_LEADS_LABEL = "All Meta Leads";

/** True when the Workspace selection is the combined view. */
export function isAllMetaLeadsId(flowId: string | null | undefined): boolean {
  return flowId === ALL_META_LEADS_ID;
}

/**
 * Answer keys that already have dedicated All-view columns and must
 * NOT duplicate inside Form Answers:
 *   - full name / phone variants → Name + Phone Number columns
 *   - source                     → Source column
 * Email has no dedicated column, so it stays in Form Answers.
 */
export const ALL_META_ANSWERS_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  ...FULL_NAME_KEYS,
  ...PHONE_KEYS,
  META_SOURCE_COLUMN_KEY,
]);

/** One displayed answer inside the single Form Answers column. */
export interface AllMetaFormAnswer {
  /** Stable answer key (vars key). */
  key: string;
  /** Original Meta form question text (or fallback when unavailable). */
  question: string;
  /** Complete display value (option-label mapped, never truncated). */
  answer: string;
  /** True when the question definition was missing (legacy/unmapped). */
  legacy: boolean;
}

export interface AllMetaQuestionInput {
  key?: string | null;
  label?: string | null;
  type?: string | null;
}

/**
 * Build the ordered Form Answers list for one lead.
 *
 * Inputs:
 *   vars          — flow_runs.vars (normalized answers + source)
 *   questions     — this lead's OWN form questions (stored, in order)
 *   questionKeys  — deterministic per-question storage keys, aligned by
 *                   index with `questions` (see questionVarKeys)
 *   displayFor    — resolves one raw value to its display text
 *                   (option-label mapping + choice fallback). Callers pass
 *                   a per-form resolver so different forms never share
 *                   definitions. When omitted, raw values render verbatim.
 *
 * Rules (display-only, never mutates inputs):
 *   - form order preserved; empties skipped (no answer to display)
 *   - identity + source keys excluded (dedicated columns)
 *   - legacy vars keys (not in the current form) appended with a
 *     humanized-key fallback question rather than dropped
 */
export function buildAllMetaFormAnswers(args: {
  vars: Record<string, unknown> | null | undefined;
  questions: ReadonlyArray<AllMetaQuestionInput> | null | undefined;
  questionKeys: readonly string[];
  displayFor?: (key: string, raw: string) => string;
}): AllMetaFormAnswer[] {
  const vars = args.vars ?? {};
  const questions = args.questions ?? [];
  const keys = args.questionKeys ?? [];
  const displayFor = args.displayFor ?? ((_key, raw) => raw);

  const out: AllMetaFormAnswer[] = [];
  const seen = new Set<string>();

  const textOf = (v: unknown): string | null => {
    if (typeof v === "string") {
      const t = v.trim();
      return t !== "" ? v : null;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      return s.trim() !== "" ? s : null;
    }
    return null;
  };

  questions.forEach((q, index) => {
    const key = keys[index];
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (ALL_META_ANSWERS_EXCLUDED_KEYS.has(key)) return;
    // Email keys are NOT excluded (no dedicated column) — they render here.
    const raw = textOf((vars as Record<string, unknown>)[key]);
    if (raw === null) return;
    const label =
      (typeof q?.label === "string" && q.label.trim() !== ""
        ? q.label.trim()
        : typeof q?.key === "string" && q.key.trim() !== ""
          ? q.key.trim()
          : key) ?? key;
    // Preserve raw spacing in the displayed answer; only the emptiness
    // check trims. Option mapping works on the trimmed form but must
    // not rewrite spacing for free text — callers' displayFor handles it.
    out.push({
      key,
      question: label,
      answer: displayFor(key, raw),
      legacy: false,
    });
  });

  // Legacy / unmapped vars keys: anything stored on the run that is not
  // part of the current form definition, not excluded, and non-empty.
  // Appended after form-ordered answers so nothing is ever dropped.
  for (const [key, value] of Object.entries(vars)) {
    if (seen.has(key)) continue;
    if (ALL_META_ANSWERS_EXCLUDED_KEYS.has(key)) continue;
    // Skip email identity? No — email stays (see above). Only the
    // excluded set is skipped.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const raw = textOf(value);
    if (raw === null) continue;
    seen.add(key);
    out.push({
      key,
      question: humanizeAnswerKey(key),
      answer: displayFor(key, raw),
      legacy: true,
    });
  }

  return out;
}

/** Fallback question text for legacy/unmapped keys: `foo_bar` → `foo bar`. */
export function humanizeAnswerKey(key: string): string {
  const clean = key.trim().replace(/_+/g, " ").trim();
  return clean !== "" ? clean : key;
}

/** True for email answer keys (informational; emails stay in Form Answers). */
export function isEmailAnswerKey(key: string): boolean {
  return (EMAIL_KEYS as readonly string[]).includes(key);
}

/** All-view fixed columns (stable visibility ids shared with the
 *  existing Workspace visibility scheme: `flow:<key>` for column
 *  slots and `core:*` for structural slots, so the Columns menu,
 *  pastel header paint, and localStorage prefs behave exactly like
 *  individual Meta tables. Business columns use per-view stable
 *  synthetic keys (one slot for the combined view — per-row values
 *  still resolve from each lead's OWN originating flow field). */
export const ALL_META_COLUMN_IDS = {
  row: "core:row",
  actions: "core:actions",
  name: "flow:name",
  phone: "flow:phone",
  submissionTime: "flow:submission_time",
  table: "flow:meta_table",
  source: "flow:meta_lead_source",
  answers: "flow:form_answers",
  assignedTo: "flow:all_assigned_to",
  type: "flow:all_lead_type",
  stage: "flow:all_stage",
  callStatus: "flow:all_call_status",
  followUp: "flow:all_follow_up",
} as const;

export type AllMetaColumnId =
  (typeof ALL_META_COLUMN_IDS)[keyof typeof ALL_META_COLUMN_IDS];

/** Default visible order for the All view (spec column order). */
export function defaultAllMetaColumnOrder(): string[] {
  return [
    ALL_META_COLUMN_IDS.actions,
    ALL_META_COLUMN_IDS.row,
    ALL_META_COLUMN_IDS.name,
    ALL_META_COLUMN_IDS.phone,
    ALL_META_COLUMN_IDS.submissionTime,
    ALL_META_COLUMN_IDS.table,
    ALL_META_COLUMN_IDS.source,
    ALL_META_COLUMN_IDS.answers,
    ALL_META_COLUMN_IDS.assignedTo,
    ALL_META_COLUMN_IDS.type,
    ALL_META_COLUMN_IDS.stage,
    ALL_META_COLUMN_IDS.callStatus,
    ALL_META_COLUMN_IDS.followUp,
  ];
}

/** Display labels for the All-view fixed columns. */
export const ALL_META_COLUMN_LABELS: Record<string, string> = {
  [ALL_META_COLUMN_IDS.row]: "No.",
  [ALL_META_COLUMN_IDS.name]: "Name",
  [ALL_META_COLUMN_IDS.phone]: "Phone Number",
  [ALL_META_COLUMN_IDS.submissionTime]: "Submission Time",
  [ALL_META_COLUMN_IDS.table]: "Meta Lead Ads Table",
  [ALL_META_COLUMN_IDS.source]: "Source",
  [ALL_META_COLUMN_IDS.answers]: "Form Answers",
  [ALL_META_COLUMN_IDS.assignedTo]: "Assigned To",
  [ALL_META_COLUMN_IDS.type]: "Type",
  [ALL_META_COLUMN_IDS.stage]: "Stage",
  [ALL_META_COLUMN_IDS.callStatus]: "Call Status",
  [ALL_META_COLUMN_IDS.followUp]: "Follow-up information",
  [ALL_META_COLUMN_IDS.actions]: "Actions",
};

/**
 * Fixed All-view columns as shared Workspace flow-column entries, in
 * spec order. Rendered through the SAME table primitives, header
 * paint, and cell styling as individual Meta tables — the only
 * special column is Form Answers (plain wrapped text, one answer
 * per line). Business slots reuse per-row originating-flow field
 * definitions at render time; these entries only drive header
 * paint, the Columns menu, and visibility identity.
 */
export function allMetaFlowColumns(): FlowTableColumn[] {
  const col = (
    key: string,
    label: string,
    system: boolean,
  ): FlowTableColumn => ({ key, label, system });
  return [
    col("submission_time", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.submissionTime], true),
    col("name", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.name], true),
    col("phone", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.phone], true),
    col("meta_table", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.table], false),
    col(META_SOURCE_COLUMN_KEY, ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.source], false),
    col("form_answers", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.answers], false),
    col("all_assigned_to", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.assignedTo], false),
    col("all_lead_type", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.type], false),
    col("all_stage", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.stage], false),
    col("all_call_status", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.callStatus], false),
    col("all_follow_up", ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.followUp], false),
  ];
}

/** Canonical All-view business column specs (fallback when a flow lacks its own field row). */
export interface AllMetaBusinessSpec {
  /** Stable key matching AllMetaLeadsRow.fieldIds entries. */
  key: "assignedTo" | "type" | "stage" | "callStatus" | "followUp";
  /** Canonical stored field name (same identity individual tables match by). */
  name: string;
  field_type: "single_select" | "datetime";
  options: string[] | null;
  default_value: string | null;
}

export const ALL_META_BUSINESS_SPECS: readonly AllMetaBusinessSpec[] = [
  { key: "assignedTo", name: "Assigned To", field_type: "single_select", options: ["Unassigned"], default_value: null },
  { key: "type", name: "Lead Type", field_type: "single_select", options: [...LEAD_TYPE_OPTIONS], default_value: LEAD_TYPE_DEFAULT_VALUE },
  { key: "stage", name: "Stage", field_type: "single_select", options: [...STAGE_OPTIONS], default_value: LEAD_STAGE_DEFAULT_VALUE },
  { key: "callStatus", name: "Call Status", field_type: "single_select", options: [...CALL_STATUS_OPTIONS], default_value: null },
  { key: "followUp", name: "Next Follow-up Date & Time", field_type: "datetime", options: null, default_value: null },
];

/** Follow-up Status options for the All-view column filter (canonical per-flow options). */
export const ALL_META_FOLLOW_UP_STATUS_OPTIONS: readonly string[] = FOLLOW_UP_STATUS_OPTIONS;

/** Query params for GET /api/workspace/all-meta-leads (client → server). */
export interface AllMetaLeadsQuery {
  search?: string | null;
  page: number;
  pageSize: number;
  dateFrom?: string | null;
  dateTo?: string | null;
  assignee?: string | null;
  tableId?: string | null;
  stage?: string[] | null;
  leadType?: string[] | null;
  callStatus?: string[] | null;
  followUpStatus?: string[] | null;
  /** Next-follow-up half-open [from, to) UTC ISO bounds (KPI bucket filter). */
  nextFollowUpFrom?: string | null;
  nextFollowUpTo?: string | null;
}

/** Compose the All-view table query string (server paginates the set). */
export function buildAllMetaLeadsQuery(q: AllMetaLeadsQuery): string {
  const qs = new URLSearchParams({
    page: String(q.page),
    pageSize: String(q.pageSize),
  });
  if (q.search && q.search.trim()) qs.set("search", q.search.trim().slice(0, 120));
  if (q.dateFrom) qs.set("dateFrom", q.dateFrom);
  if (q.dateTo) qs.set("dateTo", q.dateTo);
  if (q.assignee && q.assignee.trim() && q.assignee.trim().toLowerCase() !== "all") {
    qs.set("assignee", q.assignee.trim());
  }
  if (q.tableId && q.tableId.trim()) qs.set("tableId", q.tableId.trim());
  for (const v of q.stage ?? []) {
    if (v.trim() !== "") qs.append("stage", v.trim());
  }
  for (const v of q.leadType ?? []) {
    if (v.trim() !== "") qs.append("leadType", v.trim());
  }
  for (const v of q.callStatus ?? []) {
    if (v.trim() !== "") qs.append("callStatus", v.trim());
  }
  for (const v of q.followUpStatus ?? []) {
    if (v.trim() !== "") qs.append("followUpStatus", v.trim());
  }
  if (q.nextFollowUpFrom) qs.set("nextFollowUpFrom", q.nextFollowUpFrom);
  if (q.nextFollowUpTo) qs.set("nextFollowUpTo", q.nextFollowUpTo);
  return qs.toString();
}
