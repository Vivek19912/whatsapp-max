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

/** Full template content for the rich hover preview. Pure data. */
export interface TemplateDetail {
  name: string;
  language: string;
  status: string;
  category: string | null;
  headerType: string | null;
  headerContent: string | null;
  headerMediaUrl: string | null;
  bodyText: string;
  footerText: string | null;
  buttons: Array<{ type: string; text: string }>;
  sampleValues: Record<string, string[]>;
}

/** Key (name + language) shared by the picker value encoding. */
export function templateDetailKey(template: { name: string; language: string }): string {
  return encodeTemplateKey({ name: template.name, language: template.language });
}

/**
 * Index full template rows by (name, language) for preview lookup.
 * First row wins on duplicates; rows without a name are skipped.
 * Never throws on malformed rows — they are filtered, not guessed.
 */
export function toTemplateDetails(
  rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, TemplateDetail> {
  const out = new Map<string, TemplateDetail>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const name = typeof row.name === "string" ? row.name : "";
    const language = typeof row.language === "string" ? row.language : "";
    if (name === "" || language === "") continue;
    const key = encodeTemplateKey({ name, language });
    if (out.has(key)) continue;
    const buttonsRaw = Array.isArray(row.buttons) ? row.buttons : [];
    const buttons = buttonsRaw
      .filter(
        (b): b is { type: unknown; text: unknown } =>
          !!b && typeof b === "object" && !Array.isArray(b),
      )
      .map((b) => ({
        type: typeof b.type === "string" ? b.type : "",
        text: typeof b.text === "string" ? b.text : "",
      }))
      .filter((b) => b.text !== "");
    const sampleRaw =
      row.sample_values && typeof row.sample_values === "object" && !Array.isArray(row.sample_values)
        ? (row.sample_values as Record<string, unknown>)
        : {};
    const sampleValues: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(sampleRaw)) {
      if (Array.isArray(v)) {
        const vals = v.filter((x): x is string => typeof x === "string");
        if (vals.length > 0) sampleValues[k] = vals;
      }
    }
    out.set(key, {
      name,
      language,
      status: typeof row.status === "string" ? row.status : "",
      category: typeof row.category === "string" ? row.category : null,
      headerType: typeof row.header_type === "string" ? row.header_type : null,
      headerContent: typeof row.header_content === "string" ? row.header_content : null,
      headerMediaUrl: typeof row.header_media_url === "string" ? row.header_media_url : null,
      bodyText: typeof row.body_text === "string" ? row.body_text : "",
      footerText: typeof row.footer_text === "string" ? row.footer_text : null,
      buttons,
      sampleValues,
    });
  }
  return out;
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
