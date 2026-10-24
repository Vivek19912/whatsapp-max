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
//   * Layout rule: headers and values follow the configured column
//     order exactly; the stable Meta Lead ID sits at its configured
//     position (last by default, first for legacy selections) and is
//     hidden via the API when deselected, so row matching never
//     depends on visibility, naming, or position of other columns.
//     A NULL column_config reproduces the legacy ID-first layout.
// ============================================================

import {
  EMAIL_KEYS,
  FULL_NAME_KEYS,
  PHONE_KEYS,
} from "@/lib/meta-lead-ads/normalize";
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

/**
 * Remove duplicate column keys, keeping the first occurrence in
 * order. Used to normalize user selections before saving and
 * rendering so one Workspace header can never appear twice.
 * Pure.
 */
export function dedupeSheetsColumns<T extends SheetsColumnDef>(
  columns: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const col of columns) {
    if (!col || typeof col.key !== 'string' || seen.has(col.key)) continue;
    seen.add(col.key);
    out.push(col);
  }
  return out;
}

/**
 * The standard Sheets key a dynamic `answer:<key>` option
 * duplicates, or null when it carries its own data. Identity comes
 * from the same sanitized answer-key sets ingestion derives the
 * standard name/phone/email from (normalize.ts) — never from
 * labels, so a custom question that merely looks similar (a
 * different key) is always preserved. Pure.
 */
export function equivalentStandardKey(
  sheetsKey: string,
): "name" | "phone" | "email" | null {
  const inner = parseAnswerFieldKey(sheetsKey);
  if (inner === null) return null;
  if ((FULL_NAME_KEYS as readonly string[]).includes(inner)) return "name";
  if ((PHONE_KEYS as readonly string[]).includes(inner)) return "phone";
  if ((EMAIL_KEYS as readonly string[]).includes(inner)) return "email";
  return null;
}

/**
 * Drop dynamic options shadowed by an offered standard counterpart
 * (`Full name` when `Name` is offered, `Phone number` when `Phone`
 * is offered, …). The standard entry already syncs the same
 * underlying Workspace data, so offering both would only produce
 * duplicate headers with identical values. A twin whose standard
 * counterpart is absent is kept — offering something beats
 * offering nothing. Order-preserving. Pure.
 */
export function withoutShadowedDynamicColumns<T extends SheetsColumnDef>(
  options: readonly T[],
  offered: readonly SheetsColumnDef[],
): T[] {
  const offeredKeys = new Set(offered.map((c) => c.key));
  return options.filter((c) => {
    const std = equivalentStandardKey(c.key);
    return std === null || !offeredKeys.has(std);
  });
}

/**
 * Normalize a column selection to unique underlying fields,
 * preferring the standard key when both it and an equivalent
 * dynamic twin are selected (`Name` over `Full name`). Exact
 * duplicates collapse too. Order-preserving (the survivor keeps
 * the first occurrence's position). Pure.
 */
export function dedupeEquivalentColumns<T extends SheetsColumnDef>(
  columns: readonly T[],
): T[] {
  const winners = new Map<string, T>();
  const order: string[] = [];
  for (const col of columns) {
    if (!col || typeof col.key !== "string" || col.key === "") continue;
    const group = equivalentStandardKey(col.key) ?? col.key;
    const existing = winners.get(group);
    if (!existing) {
      winners.set(group, col);
      order.push(group);
      continue;
    }
    // Prefer the standard key: it carries the canonical Workspace
    // display label and resolves the full derivation (including
    // first+last-name fallbacks the raw answer lacks).
    const existingIsStandard =
      existing.key === "name" || existing.key === "phone" || existing.key === "email";
    const colIsStandard =
      col.key === "name" || col.key === "phone" || col.key === "email";
    if (!existingIsStandard && colIsStandard) {
      winners.set(group, col);
    }
  }
  return order.map((group) => winners.get(group) as T);
}

/**
 * Default column selection for a first-time table configuration:
 * every available Workspace table header, in Workspace table
 * order, with the Meta Lead ID last. Each key appears exactly
 * once. When no Workspace header list is available (offline table
 * read), falls back to the standard + dynamic option order (ID
 * still last). Labels prefer the Workspace display text so the
 * selection matches the table exactly. Pure.
 */
export function defaultSheetsColumns(args: {
  workspace: readonly SheetsColumnDef[];
  standard: readonly SheetsColumnDef[];
  dynamic: readonly SheetsColumnDef[];
}): SheetsColumnDef[] {
  const { workspace, standard, dynamic } = args;
  const labelFor = (key: string, fallback: string): string => {
    const hit =
      workspace.find((c) => c.key === key) ?? standard.find((c) => c.key === key);
    return hit ? hit.label : fallback;
  };
  const source =
    workspace.length > 0 ? workspace : [...standard, ...dynamic];
  const out: SheetsColumnDef[] = [];
  for (const col of source) {
    if (col.key === META_LEAD_ID_FIELD_KEY) continue;
    out.push({ key: col.key, label: col.label });
  }
  out.push({ key: META_LEAD_ID_FIELD_KEY, label: labelFor(META_LEAD_ID_FIELD_KEY, 'Meta Lead ID') });
  return dedupeEquivalentColumns(dedupeSheetsColumns(out));
}

export interface ManagedLayout {
  /** Full header row cells (row 1), in the configured column order. */
  headers: string[];
  /** Visible columns in user order (may include the ID key). */
  visibleKeys: string[];
  /** Whether the ID column is a selected visible column. */
  idVisible: boolean;
  /** 0-based position of the ID cell within headers/rows. */
  idColumnIndex: number;
}

/**
 * Compute the managed header from the visible column selection.
 * Headers and values follow the configured column order exactly —
 * the Meta Lead ID sits wherever the selection puts it (last by
 * default for new configurations, first for legacy ID-first ones,
 * so existing sheets are byte-identical until the user reorders).
 * When the ID is not selected it is still written (hidden via the
 * API) after the last visible column so row matching never depends
 * on visibility.
 */
export function computeManagedLayout(columns: SheetsColumnDef[]): ManagedLayout {
  const idCol = columns.find((c) => c.key === META_LEAD_ID_FIELD_KEY);
  const headers = columns.map((c) => c.label);
  if (!idCol) headers.push("Meta Lead ID");
  return {
    headers,
    visibleKeys: columns.map((c) => c.key),
    idVisible: !!idCol,
    idColumnIndex: idCol ? columns.findIndex((c) => c.key === META_LEAD_ID_FIELD_KEY) : headers.length - 1,
  };
}

/**
 * Project a full field map onto a managed data row, aligned with
 * `computeManagedLayout` for the same selection: the ID value
 * sits at the ID's configured position (last by default, first
 * for legacy ID-first selections). Missing fields stay blank — a
 * form that does not provide a field simply leaves it empty.
 * Never throws for unknown keys.
 */
export function projectRowValues(
  fieldMap: Record<string, string>,
  columns: SheetsColumnDef[],
): string[] {
  const idValue = fieldMap[META_LEAD_ID_FIELD_KEY] ?? "";
  const at = columns.findIndex((c) => c.key === META_LEAD_ID_FIELD_KEY);
  const rest = columns.filter((c) => c.key !== META_LEAD_ID_FIELD_KEY);
  const restValues = rest.map((c) => fieldMap[c.key] ?? "");
  if (at === -1) return [...restValues, idValue];
  return [...restValues.slice(0, at), idValue, ...restValues.slice(at)];
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
