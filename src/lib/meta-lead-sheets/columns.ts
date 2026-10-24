// ============================================================
// Meta Lead Ads → Google Sheets — selectable forms + columns.
//
// Meta-only. Pure functions (no DB, no network):
//
//   * Standard fields: the 12 fixed keys, defaulting to the legacy
//     header labels so a NULL column_config reproduces the old
//     layout byte-for-byte.
//   * Dynamic fields: `answer:<sanitizedKey>` derived from the
//     selected forms' stored questions with the SAME derivation the
//     ingestion path uses (`questionVarKeys`), so a selected field
//     always maps to the stored answer. Labels are display-only;
//     identity is always the key.
//   * Layout rule: the stable Meta Lead ID is pinned to column A
//     (hidden via the API when deselected) so row matching never
//     depends on visibility, naming, or position of other columns.
//     Visible columns follow the user's saved order.
// ============================================================

import {
  parseFormQuestions,
  questionVarKeys,
} from "@/lib/meta-lead-ads/virtual-flow";

export interface SheetsColumnDef {
  /** Stable identity: standard key or `answer:<key>`. Never a label. */
  key: string;
  /** Display header text (user-customizable). */
  label: string;
}

export const META_LEAD_ID_FIELD_KEY = "meta_lead_id";

export const STANDARD_SHEETS_FIELDS: ReadonlyArray<SheetsColumnDef> = [
  { key: "meta_lead_id", label: "Meta Lead ID" },
  { key: "submitted_at", label: "Submitted At" },
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "form_name", label: "Form Name" },
  { key: "campaign_name", label: "Campaign" },
  { key: "ad_name", label: "Ad" },
  { key: "source", label: "Source" },
  { key: "assignee", label: "Assigned To" },
  { key: "lead_type", label: "Lead Type" },
  { key: "stage", label: "Stage" },
];

/** Legacy layout: all 12 standard fields in the historical order. */
export const DEFAULT_SHEETS_COLUMNS: SheetsColumnDef[] =
  STANDARD_SHEETS_FIELDS.map((f) => ({ ...f }));

export function isStandardFieldKey(key: string): boolean {
  return STANDARD_SHEETS_FIELDS.some((f) => f.key === key);
}

/** Dynamic answer namespace. Bare keys are reserved for standard fields. */
export function answerFieldKey(sanitizedKey: string): string {
  return `answer:${sanitizedKey}`;
}

/** Extract the sanitized answer key, or null when not dynamic. */
export function parseAnswerFieldKey(key: string): string | null {
  if (!key.startsWith("answer:")) return null;
  const inner = key.slice("answer:".length);
  return inner === "" ? null : inner;
}

/**
 * Validate a saved column_config value into ordered defs. Anything
 * malformed falls back to the legacy default (never throws).
 */
export function resolveEffectiveColumns(saved: unknown): SheetsColumnDef[] {
  if (!Array.isArray(saved) || saved.length === 0) {
    return DEFAULT_SHEETS_COLUMNS.map((f) => ({ ...f }));
  }
  const seen = new Set<string>();
  const out: SheetsColumnDef[] = [];
  for (const entry of saved) {
    if (!entry || typeof entry !== "object") return DEFAULT_SHEETS_COLUMNS.map((f) => ({ ...f }));
    const row = entry as Record<string, unknown>;
    if (typeof row.key !== "string" || typeof row.label !== "string") {
      return DEFAULT_SHEETS_COLUMNS.map((f) => ({ ...f }));
    }
    const key = row.key.trim();
    const label = row.label.trim();
    if (key === "" || label === "" || label.length > 100 || seen.has(key)) {
      return DEFAULT_SHEETS_COLUMNS.map((f) => ({ ...f }));
    }
    seen.add(key);
    out.push({ key, label });
  }
  if (out.length === 0 || out.length > 100) {
    return DEFAULT_SHEETS_COLUMNS.map((f) => ({ ...f }));
  }
  return out;
}

export interface ManagedLayout {
  /** Full header row cells (row 1), ID pinned at index 0. */
  headers: string[];
  /** Visible columns in user order (may include the ID key). */
  visibleKeys: string[];
  /** Whether the ID column is a selected visible column. */
  idVisible: boolean;
}

/**
 * Compute the managed header from the visible column selection.
 * The Meta Lead ID is always pinned to column A (hidden via the
 * API when not selected) so matching never depends on visibility.
 */
export function computeManagedLayout(columns: SheetsColumnDef[]): ManagedLayout {
  const idCol = columns.find((c) => c.key === META_LEAD_ID_FIELD_KEY);
  const rest = columns.filter((c) => c.key !== META_LEAD_ID_FIELD_KEY);
  return {
    headers: [idCol ? idCol.label : "Meta Lead ID", ...rest.map((c) => c.label)],
    visibleKeys: columns.map((c) => c.key),
    idVisible: !!idCol,
  };
}

/**
 * Project a full field map onto a managed data row (ID pinned at
 * index 0 to match `computeManagedLayout`). Missing fields stay
 * blank — a form that does not provide a field simply leaves it
 * empty. Never throws for unknown keys.
 */
export function projectRowValues(
  fieldMap: Record<string, string>,
  columns: SheetsColumnDef[],
): string[] {
  const rest = columns.filter((c) => c.key !== META_LEAD_ID_FIELD_KEY);
  return [
    fieldMap[META_LEAD_ID_FIELD_KEY] ?? "",
    ...rest.map((c) => fieldMap[c.key] ?? ""),
  ];
}

export interface DynamicFieldOption {
  key: string;
  label: string;
  /** Form names providing this question, in first-seen order. */
  formNames: string[];
}

/**
 * Union of dynamic answer fields across forms. Keys use the exact
 * derivation ingestion uses, so selection always maps to stored
 * answers. Pure.
 */
export function buildDynamicFieldOptions(
  forms: ReadonlyArray<{ form_name: string | null; questions: unknown }>,
): DynamicFieldOption[] {
  const byKey = new Map<string, DynamicFieldOption>();
  for (const form of forms) {
    const questions = parseFormQuestions(form.questions);
    const keys = questionVarKeys(questions);
    const formName = (form.form_name ?? "").trim() || "Untitled form";
    questions.forEach((q, index) => {
      const key = keys[index];
      if (!key) return;
      const label =
        (q.label ?? "").trim() || (q.key ?? "").trim() || `Question ${index + 1}`;
      const existing = byKey.get(answerFieldKey(key));
      if (existing) {
        if (!existing.formNames.includes(formName)) existing.formNames.push(formName);
        return;
      }
      byKey.set(answerFieldKey(key), {
        key: answerFieldKey(key),
        label,
        formNames: [formName],
      });
    });
  }
  return [...byKey.values()];
}

/**
 * Validate a user-supplied column list against the allowed key set
 * (standard + dynamic union of the SELECTED forms). Returns the
 * normalized defs or a human-readable error. Pure.
 */
export function validateColumnConfig(
  input: unknown,
  allowedKeys: ReadonlySet<string>,
): { columns: SheetsColumnDef[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "Select at least one column." };
  }
  if (input.length > 100) {
    return { error: "Select at most 100 columns." };
  }
  const seen = new Set<string>();
  const columns: SheetsColumnDef[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") {
      return { error: "Each column needs a key and a label." };
    }
    const row = entry as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (key === "" || !allowedKeys.has(key)) {
      return { error: `Unknown or unavailable column: "${key || "(empty)"}".` };
    }
    if (label === "" || label.length > 100) {
      return { error: "Each column label must be 1–100 characters." };
    }
    if (seen.has(key)) {
      return { error: `Duplicate column: "${key}".` };
    }
    seen.add(key);
    columns.push({ key, label });
  }
  return { columns };
}
