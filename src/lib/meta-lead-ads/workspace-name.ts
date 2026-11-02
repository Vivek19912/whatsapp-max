// ============================================================
// Meta Lead Ads — Workspace display-name projection (pure, no I/O).
//
// Applies ONLY to virtual Meta Lead Ads tables
// (flows.kind = 'meta_lead_ads'). Flow Tables never consult these
// helpers and their rendering path is untouched.
//
// Two Meta-only presentation rules live here:
//   1. The system Name column shows the current submission's own
//      Instant Form Full Name answer — never the shared contact's
//      WhatsApp profile name — with the existing normalized
//      standard-name and contact fallbacks when the submission
//      carries no usable Full Name.
//   2. The separate Full name question column is excluded from the
//      table column list. The answer itself stays stored exactly as
//      before (flow_runs.vars, meta_lead_submissions answers /
//      field_data, Sheets, variables, notifications all read the
//      stored data, never this projection).
//
// Identity is by stable answer key (the canonical `full_name` key
// and/or a stored FULL_NAME question type), never by display
// label — a rename must not change which column is suppressed,
// and unrelated questions are never affected.
// ============================================================

import {
  FULL_NAME_KEYS,
  standardContactFromAnswers,
} from "./normalize";

/** Meta's stored standard-question type for the Full Name field. */
export const META_FULL_NAME_QUESTION_TYPE = "FULL_NAME";

/** Canonical answer key for the Instant Form Full Name question. */
export const META_FULL_NAME_ANSWER_KEY = "full_name";

/**
 * Whether a stored form-question type marks the Full Name field.
 * Normalized (trimmed, case-insensitive) so `FULL_NAME`,
 * `full_name`, and padded variants all match; every other type —
 * including CUSTOM and unknown — never does.
 */
export function isMetaFullNameQuestionType(
  type: string | null | undefined,
): boolean {
  return (
    (type ?? "").trim().toUpperCase() === META_FULL_NAME_QUESTION_TYPE
  );
}

export interface MetaFullNameQuestionRef {
  key?: string | null;
  label?: string | null;
  type?: string | null;
}

/**
 * Answer keys whose columns are the Full Name twin of the system
 * Name column, aligned by index with `questionKeys` (the same
 * `questionVarKeys` derivation the virtual flow was built with, see
 * choiceQuestionKeys for the established pattern).
 *
 * The canonical `full_name` key is always included as a safety net
 * for forms whose question metadata was never synced (older
 * enabled forms store `questions: []` yet still ingest
 * `field_data: [{ name: "full_name", ... }]`), so the twin can
 * never leak through as a separate column on metadata grounds
 * alone. Phone/e-mail identity keys are deliberately NOT included
 * — Phone Number and other fields are never suppressed here.
 */
export function metaFullNameAnswerKeys(
  questions: ReadonlyArray<MetaFullNameQuestionRef> | null | undefined,
  questionKeys: readonly string[],
): Set<string> {
  const out = new Set<string>();
  (questions ?? []).forEach((question, index) => {
    if (!isMetaFullNameQuestionType(question?.type)) return;
    const answerKey = questionKeys[index];
    if (answerKey) out.add(answerKey);
  });
  out.add(META_FULL_NAME_ANSWER_KEY);
  return out;
}

/**
 * Effective system-Name cell for ONE Meta lead submission.
 *
 * Priority (per submission, never cross-row):
 *   1. The submission's own `vars["full_name"]` answer, when
 *      non-empty after trimming.
 *   2. The existing normalized standard-name fallback for that
 *      submission (other full-name keys, then first+last) — shared
 *      with ingestion, Inbox, and WhatsApp variables.
 *   3. The linked contact's name (WhatsApp profile or previously
 *      stored lead name).
 *   4. Null when nothing usable exists — nothing is invented, and
 *      phone fallback behavior is unchanged (the contact insert
 *      already stores `name || phone`, and the phone column keeps
 *      its own contact-then-submission fallback).
 *
 * Values pass through byte-for-byte (Unicode, emoji, punctuation
 * preserved); only surrounding whitespace is trimmed for the
 * emptiness check. Pure — stored data is never touched.
 */
export function metaWorkspaceDisplayName(
  vars: Record<string, unknown> | null | undefined,
  contactName: string | null | undefined,
): string | null {
  const record = (vars ?? {}) as Record<string, unknown>;
  const direct = record[META_FULL_NAME_ANSWER_KEY];
  if (typeof direct === "string" && direct.trim() !== "") {
    return direct.trim();
  }
  const standard = standardContactFromAnswers(
    record as Record<string, string | null | undefined>,
  );
  if (standard.name) return standard.name;
  if (typeof contactName === "string" && contactName.trim() !== "") {
    return contactName.trim();
  }
  return null;
}

/**
 * Exclude the Full Name twin column(s) from a Meta table column
 * list. Only NON-SYSTEM columns whose stable key is a Full Name
 * answer key are removed — the system `sys:name` column, Phone
 * Number, Submission Time, every other question column, and every
 * custom Workspace column pass through untouched, in their
 * existing order. Pure: the input array is never mutated, and
 * `answerKeys`/stored answers are intentionally left intact (the
 * answer stays available to Sheets, variables, notifications, and
 * Restore Original Answer).
 */
export function excludeMetaFullNameColumns<
  T extends { key: string; system: boolean },
>(columns: readonly T[], fullNameKeys: ReadonlySet<string>): T[] {
  return columns.filter((c) => c.system || !fullNameKeys.has(c.key));
}

/**
 * Keys treated as the Full Name identity across the Meta
 * Workspace surface (exported for tests and documentation).
 */
export const META_FULL_NAME_KEYS: readonly string[] = FULL_NAME_KEYS;
