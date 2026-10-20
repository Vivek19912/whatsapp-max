// ============================================================
// Meta Lead Ads — human-readable Instant Form option labels.
//
// Display-only: stored answers, field identifiers, and mappings are
// NEVER modified here. Meta defines a multiple-choice option as
// `{ value: "<text shown to the user>", key: "<short identifier>" }`,
// so a stored raw answer that exactly equals an option `key` may be
// rendered as that option's `value`. Anything else — free text,
// unknown values, missing or empty labels — renders verbatim, never
// guessed and never underscore-munged.
//
// Pure and dependency-free — unit tested directly.
// ============================================================

export interface StoredFormOption {
  key?: string | null;
  value?: string | null;
}

export interface StoredFormQuestion {
  key?: string | null;
  label?: string | null;
  type?: string | null;
  options?: StoredFormOption[] | null;
}

/**
 * Build an answer-key → (raw value → display label) lookup from
 * stored form metadata. `questionKeys` must be the deterministic
 * per-question storage keys in form order (see questionVarKeys),
 * aligned by index with `questions`.
 */
export function buildOptionLabelMap(
  questions: StoredFormQuestion[] | null | undefined,
  questionKeys: readonly string[],
): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  (questions ?? []).forEach((question, index) => {
    const answerKey = questionKeys[index];
    if (!answerKey) return;
    const options = Array.isArray(question?.options) ? question.options : [];
    for (const option of options) {
      const raw = typeof option?.key === "string" ? option.key : "";
      const label = typeof option?.value === "string" ? option.value : "";
      if (raw === "" || label === "") continue;
      let perQuestion = map.get(answerKey);
      if (!perQuestion) {
        perQuestion = new Map<string, string>();
        map.set(answerKey, perQuestion);
      }
      if (!perQuestion.has(raw)) perQuestion.set(raw, label);
    }
  });
  return map;
}

/**
 * Resolve one stored answer value to its display text using an exact
 * option-key match only. Multi-select answers (stored joined with
 * ", ") are split and resolved per item; any item without an exact
 * match — including all free text — is returned verbatim.
 */
export function mapAnswerValue(
  labels: ReadonlyMap<string, string> | undefined,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (!labels || labels.size === 0) return value;
  // Whole-value match first (an option key may itself contain a comma).
  const whole = labels.get(value.trim());
  if (whole !== undefined) return whole;
  let changed = false;
  const mapped = value.split(/\s*,\s*/).map((part) => {
    if (part === "") return part;
    const label = labels.get(part);
    if (label === undefined) return part;
    changed = true;
    return label;
  });
  // Joining must never alter an unmatched value (e.g. "a,b" must not
  // become "a, b"): only rebuild when at least one item resolved.
  return changed ? mapped.join(", ") : value;
}

/**
 * Apply option labels to a row's dynamic answers (display layer).
 * Returns a new object; the input is never mutated. Callers decide
 * which keys are eligible — system columns are never passed here.
 */
export function applyOptionLabelsToAnswers(
  answers: Record<string, string | null>,
  labelMap: ReadonlyMap<string, ReadonlyMap<string, string>>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(answers)) {
    const labels = labelMap.get(key);
    out[key] = value === null ? null : mapAnswerValue(labels, value);
  }
  return out;
}
