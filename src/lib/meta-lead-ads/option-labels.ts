// ============================================================
// Meta Lead Ads — human-readable Instant Form option labels.
//
// Display-only: stored answers, field identifiers, and mappings are
// NEVER modified here. Meta defines a multiple-choice option as
// `{ value: "<text shown to the user>", key: "<short identifier>" }`,
// so a stored raw answer that exactly equals an option `key` renders
// as that option's `value` (preferred — the same reliable label the
// lead saw). When a choice question has option metadata but the
// stored value matches no key (unsynced options, retired choices),
// underscore-separated values render with spaces instead of
// underscores (`davinci_resolve` → `davinci resolve`) — still
// display-only, never title-cased, never re-keyed.
//
// Free text, answers without underscores, and questions with no
// option metadata at all render verbatim, never guessed.
//
// Pure and dependency-free — unit tested directly. Flow Tables never
// import this module; the fallback cannot reach them.
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
 * Resolve one stored answer value to its display text. An exact
 * option-key match wins first (whole value, then per item for
 * multi-select answers stored joined with ", "). Any remaining item
 * with underscores renders with spaces — but only for questions
 * that actually have option metadata (a known choice question); a
 * missing/empty label map means free text or an unknown question,
 * which renders verbatim, never guessed.
 *
 * Separators are preserved byte-for-byte: a value with nothing to
 * resolve returns the identical string (e.g. "a,b" never becomes
 * "a, b").
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
  const mapped = value.split(/(\s*,\s*)/).map((token, index) => {
    // Odd tokens are the original separators — never touched.
    if (index % 2 === 1 || token === "") return token;
    const label = labels.get(token);
    if (label !== undefined) {
      changed = true;
      return label;
    }
    if (token.includes("_")) {
      changed = true;
      return token.replace(/_/g, " ");
    }
    return token;
  });
  return changed ? mapped.join("") : value;
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
