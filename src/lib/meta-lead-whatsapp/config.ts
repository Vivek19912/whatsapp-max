// ============================================================
// Meta Lead Ads → WhatsApp auto-send — pure config validation.
//
// Meta-only. Nothing here is imported by Flow Tables, All Sheets,
// broadcasts, or the generic template sender. All functions are
// pure (no I/O) so they are trivially unit-testable.
//
// Policy:
//   * A table's auto-send sequence is an ordered list of approved
//     template identities (name + language). Empty list = send
//     nothing. Duplicates within one table are rejected (the
//     queue's UNIQUE key would collapse them anyway, but the UI
//     should never produce them).
//   * delay_seconds spaces CONSECUTIVE sends for one lead:
//     item N is due at lead-time + N * delay_seconds. 0 =
//     immediate (all items due at once, still sent in order).
//     Bounded to [0, 86400] (one day); the DB CHECK enforces the
//     same range server-side.
//   * Only APPROVED templates may be saved. The check itself needs
//     I/O (message_templates lookup) and lives in queue.ts; the
//     shape validation lives here.
// ============================================================

export const MAX_AUTO_SEND_TEMPLATES = 10;
export const MAX_AUTO_SEND_DELAY_SECONDS = 86400;
export const DEFAULT_TEMPLATE_LANGUAGE = "en_US";

/** BCP-47-ish language code: 2-3 lower letters, optional _REGION. */
const LANGUAGE_PATTERN = /^[a-z]{2,3}([-_][A-Za-z]{2,8})?$/;

export interface AutoSendTemplateInput {
  template_name: string;
  template_language?: string | null;
}

export interface ValidatedAutoSendTemplate {
  template_name: string;
  template_language: string;
  /** 0-based send order within the table. */
  position: number;
}

export interface AutoSendConfigInput {
  delay_seconds?: unknown;
  paused?: unknown;
  templates?: unknown;
}

/**
 * Validate + normalize a table's auto-send config payload.
 * Throws on the first problem with a human-readable message.
 * Pure — safe to call from routes and tests.
 */
export function validateAutoSendConfig(input: AutoSendConfigInput): {
  delay_seconds: number;
  paused: boolean;
  templates: ValidatedAutoSendTemplate[];
} {
  let delay_seconds = 0;
  if (input.delay_seconds !== undefined && input.delay_seconds !== null) {
    const n =
      typeof input.delay_seconds === "string"
        ? Number(input.delay_seconds)
        : input.delay_seconds;
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n < 0 ||
      n > MAX_AUTO_SEND_DELAY_SECONDS
    ) {
      throw new Error(
        `delay_seconds must be an integer between 0 and ${MAX_AUTO_SEND_DELAY_SECONDS}.`,
      );
    }
    delay_seconds = n;
  }

  const paused = input.paused === true;

  if (input.templates === undefined || input.templates === null) {
    throw new Error("templates must be an array of template references.");
  }
  if (!Array.isArray(input.templates)) {
    throw new Error("templates must be an array of template references.");
  }
  if (input.templates.length > MAX_AUTO_SEND_TEMPLATES) {
    throw new Error(
      `A table can auto-send at most ${MAX_AUTO_SEND_TEMPLATES} templates.`,
    );
  }

  const seen = new Set<string>();
  const templates: ValidatedAutoSendTemplate[] = [];
  input.templates.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`templates[${index}] must be an object.`);
    }
    const row = entry as Record<string, unknown>;
    const name =
      typeof row.template_name === "string" ? row.template_name.trim() : "";
    if (name === "" || name.length > 512) {
      throw new Error(
        `templates[${index}].template_name must be a non-empty string.`,
      );
    }
    const rawLang =
      typeof row.template_language === "string" &&
      row.template_language.trim() !== ""
        ? row.template_language.trim()
        : DEFAULT_TEMPLATE_LANGUAGE;
    if (!LANGUAGE_PATTERN.test(rawLang)) {
      throw new Error(
        `templates[${index}].template_language "${rawLang}" is not a valid language code.`,
      );
    }
    const key = `${name}\u0000${rawLang}`;
    if (seen.has(key)) {
      throw new Error(
        `templates[${index}]: duplicate template "${name}" (${rawLang}).`,
      );
    }
    seen.add(key);
    templates.push({
      template_name: name,
      template_language: rawLang,
      position: index,
    });
  });

  return { delay_seconds, paused, templates };
}

/**
 * Due time for item N of one lead's sequence: lead-time plus
 * N * delay. Pure — the delay between consecutive messages falls
 * out of the per-item schedule, and order is preserved because
 * the drain always processes a lead's rows by (scheduled_for,
 * position).
 */
export function scheduledForForPosition(
  baseIso: string,
  position: number,
  delaySeconds: number,
): string {
  const base = Date.parse(baseIso);
  const at = Number.isNaN(base) ? Date.now() : base;
  return new Date(at + position * delaySeconds * 1000).toISOString();
}

/** Bounded exponential backoff: 1m, 2m, 4m … capped at 30m. Pure. */
export function whatsappRetryDelayMs(attempt: number): number {
  const step = Math.max(0, attempt - 1);
  return Math.min(60_000 * 2 ** step, 30 * 60_000);
}
