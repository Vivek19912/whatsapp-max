// ============================================================
// Meta Lead Ads — human-readable Instant Form option labels.
//
// Display-only: stored answers, field identifiers, and mappings are
// NEVER modified here. Meta defines a multiple-choice option as
// `{ value: "<text shown to the user>", key: "<short identifier>" }`,
// so a stored raw answer that exactly equals an option `key` renders
// as that option's `value` (preferred — the same reliable label the
// lead saw). When a known choice question has no matching key
// (options never synced, retired choices), underscore-separated
// values render with spaces instead of underscores
// (`davinci_resolve` → `davinci resolve`) — still display-only,
// never title-cased, never re-keyed.
//
// A question is a known choice question when it carries option
// metadata OR its persisted Meta type is CUSTOM (Meta's custom
// questions are the choice/free-select ones; standard prefill types
// like FULL_NAME, PHONE_NUMBER, and EMAIL are never choices).
// Free text, answers without underscores, standard-typed questions,
// and unknown question types render verbatim, never guessed.
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
 * Meta's persisted custom-question type. Custom questions are the
 * only ones that carry selectable options (standard prefill types
 * such as FULL_NAME, PHONE_NUMBER, or EMAIL never do), so a CUSTOM
 * question with no synced options is still a known choice question
 * for the display fallback — while standard or unknown types never
 * are.
 */
export function isChoiceQuestionType(type: string | null | undefined): boolean {
  return (type ?? "").trim().toUpperCase() === "CUSTOM";
}

/**
 * Answer keys of known choice questions, aligned by index with
 * `questions` (see questionVarKeys). A question qualifies when it
 * carries at least one usable option OR its persisted Meta type
 * marks it as custom. Callers pass this set alongside the label
 * map so the underscore fallback applies even when option metadata
 * was never synced — the exact production gap where labels are
 * absent but the question is still known to be a choice.
 */
export function choiceQuestionKeys(
  questions: StoredFormQuestion[] | null | undefined,
  questionKeys: readonly string[],
): Set<string> {
  const out = new Set<string>();
  (questions ?? []).forEach((question, index) => {
    const answerKey = questionKeys[index];
    if (!answerKey) return;
    const options = Array.isArray(question?.options) ? question.options : [];
    const hasOptions = options.some(
      (option) =>
        typeof option?.key === "string" &&
        option.key !== "" &&
        typeof option?.value === "string" &&
        option.value !== "",
    );
    if (hasOptions || isChoiceQuestionType(question?.type)) out.add(answerKey);
  });
  return out;
}

/**
 * Resolve one stored answer value to its display text. An exact
 * option-key match wins first (whole value, then per item for
 * multi-select answers stored joined with ", "). Any remaining item
 * with underscores renders with spaces — but only when
 * `isChoiceQuestion` is true (a known choice question, see
 * choiceQuestionKeys); anything else renders verbatim, never
 * guessed.
 *
 * Separators are preserved byte-for-byte: a value with nothing to
 * resolve returns the identical string (e.g. "a,b" never becomes
 * "a, b").
 */
export function mapAnswerValue(
  labels: ReadonlyMap<string, string> | undefined,
  value: string | null | undefined,
  isChoiceQuestion = false,
): string | null {
  if (value === null || value === undefined) return null;
  // Whole-value match first (an option key may itself contain a comma).
  const whole = labels?.get(value.trim());
  if (whole !== undefined) return whole;
  if (!isChoiceQuestion) return value;
  let changed = false;
  const mapped = value.split(/(\s*,\s*)/).map((token, index) => {
    // Odd tokens are the original separators — never touched.
    if (index % 2 === 1 || token === "") return token;
    const label = labels?.get(token);
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
 * Returns a new object; the input is never mutated. `choiceKeys`
 * (see choiceQuestionKeys) enables the underscore display fallback
 * for known choice questions without option metadata; omit it and
 * only exact label matches apply. Callers decide which keys are
 * eligible — system columns are never passed here.
 */
export function applyOptionLabelsToAnswers(
  answers: Record<string, string | null>,
  labelMap: ReadonlyMap<string, ReadonlyMap<string, string>>,
  choiceKeys?: ReadonlySet<string>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value === null) {
      out[key] = null;
      continue;
    }
    out[key] = mapAnswerValue(
      labelMap.get(key),
      value,
      choiceKeys?.has(key) ?? false,
    );
  }
  return out;
}
