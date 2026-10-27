// Shared, pure template-selection helpers for the Workspace
// Assignment surfaces. Nothing here performs I/O: these helpers
// turn send-eligible template rows into searchable selector options
// and validate selections against the loaded approved list. Shared
// by the Assignment dialog (salesperson notification template) and
// the per-assignee customer-facing sequence editor, so one
// selector keeps the same category/language/status presentation
// and (name, language) identity everywhere.

/** One send-eligible WhatsApp template from the templates endpoint. */
export interface AssignmentTemplateOption {
  name: string;
  language: string;
  status: string;
  /** Meta category as stored by the sync (`Utility`/`Marketing`/`Authentication`); null when unknown. */
  category: string | null;
}

/**
 * Display category for a template option: the actual stored
 * category uppercased to Meta's style (`UTILITY`, `MARKETING`,
 * `AUTHENTICATION`). Anything missing or unrecognized falls back
 * to "Category unavailable" — never guessed. Pure.
 */
export function formatTemplateCategory(category: unknown): string {
  const normalized = typeof category === "string" ? category.trim().toUpperCase() : "";
  if (
    normalized === "UTILITY" ||
    normalized === "MARKETING" ||
    normalized === "AUTHENTICATION"
  ) {
    return normalized;
  }
  return "Category unavailable";
}

/**
 * Opaque selector value for a (name, language) template identity.
 * Names and languages never contain NUL, so the join is
 * unambiguous without escaping. Pure.
 */
const TEMPLATE_KEY_SEP = "\0";

export function encodeTemplateKey(template: { name: string; language: string }): string {
  return `${template.name}${TEMPLATE_KEY_SEP}${template.language}`;
}

/** Inverse of {@link encodeTemplateKey}; null when malformed. Pure. */
export function decodeTemplateKey(value: string): { name: string; language: string } | null {
  const sep = value.indexOf(TEMPLATE_KEY_SEP);
  if (sep <= 0 || sep === value.length - 1) return null;
  const name = value.slice(0, sep);
  const language = value.slice(sep + 1);
  if (!name || !language) return null;
  return { name, language };
}

/**
 * SearchableSelect options from endpoint rows: one entry per
 * (name, language) pair (first wins on duplicates), label =
 * template name, hint = `CATEGORY · language · status`. The
 * selector filters over label, value, and hint, so name,
 * language, and category search all work. Pure.
 */
export function toTemplateOptions(
  templates: readonly AssignmentTemplateOption[],
): Array<{ value: string; label: string; hint: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string; hint: string }> = [];
  for (const t of templates) {
    if (typeof t.name !== "string" || t.name === "") continue;
    if (typeof t.language !== "string" || t.language === "") continue;
    const value = encodeTemplateKey({ name: t.name, language: t.language });
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({
      value,
      label: t.name,
      hint: `${formatTemplateCategory(t.category)} · ${t.language} · ${t.status}`,
    });
  }
  return options;
}

/**
 * True when the dialog's current (name, language) matches a loaded
 * approved template. A saved template that no longer matches —
 * renamed, removed, or unapproved — needs a valid replacement.
 * Pure.
 */
export function isTemplateSelectionValid(
  templates: readonly AssignmentTemplateOption[] | null,
  name: string,
  language: string,
): boolean {
  if (name.trim() === "") return true;
  if (templates === null) return true;
  const trimmedName = name.trim();
  const trimmedLanguage = language.trim();
  return templates.some((t) => t.name === trimmedName && t.language === trimmedLanguage);
}
