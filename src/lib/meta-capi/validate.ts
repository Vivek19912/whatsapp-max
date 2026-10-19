// ============================================================
// Meta Conversions API — mapping input validation.
//
// One shared parser so the create (POST) and update (PATCH) routes
// agree on exactly what a valid mapping is. Pure + unit-testable.
// ============================================================

import {
  eventRequiresValue,
  isStandardEvent,
  isTriggerSource,
  isValidActionSource,
  isValidEventName,
  type TriggerSource,
} from "./catalog";
import type { MetaCapiMappingRow } from "./types";

export interface MappingInput {
  name: string;
  source_action: TriggerSource;
  source_field: string | null;
  source_value: string | null;
  meta_event_name: string;
  action_source: string;
  requires_value: boolean;
  event_value: number | null;
  currency: string | null;
  enabled: boolean;
}

export type ParsedMapping =
  | { ok: true; value: MappingInput }
  | { ok: false; error: string };

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export function parseMappingInput(
  body: Record<string, unknown>,
  base?: Partial<MappingInput>,
): ParsedMapping {
  const pick = (key: keyof MappingInput): unknown =>
    has(body, key) ? body[key] : base?.[key];

  const nameRaw = pick("name");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name) return { ok: false, error: "Give this event a name." };
  if (name.length > 80) {
    return { ok: false, error: "The event name is too long (max 80 characters)." };
  }

  const sourceRaw = pick("source_action");
  if (typeof sourceRaw !== "string" || !isTriggerSource(sourceRaw)) {
    return { ok: false, error: "Choose when this event should fire." };
  }
  const source_action = sourceRaw;

  const eventNameRaw = pick("meta_event_name");
  const meta_event_name =
    typeof eventNameRaw === "string" ? eventNameRaw.trim() : "";
  if (!meta_event_name || !isValidEventName(meta_event_name)) {
    return { ok: false, error: "Choose a valid Meta event name." };
  }

  const actionRaw = pick("action_source");
  const action_source =
    typeof actionRaw === "string" && actionRaw ? actionRaw : "business_messaging";
  if (!isValidActionSource(action_source)) {
    return { ok: false, error: "Choose a valid action source." };
  }

  let source_field: string | null = null;
  let source_value: string | null = null;
  if (source_action === "workspace_field_changed") {
    const fieldRaw = pick("source_field");
    if (typeof fieldRaw !== "string" || !fieldRaw.trim()) {
      return { ok: false, error: "Choose the Workspace column to watch." };
    }
    source_field = fieldRaw.trim();
    const valueRaw = pick("source_value");
    if (typeof valueRaw !== "string" || !valueRaw.trim()) {
      return {
        ok: false,
        error: "Enter the value that should trigger this event.",
      };
    }
    source_value = valueRaw.trim();
  }

  const requiresRaw = pick("requires_value");
  const requires_value = requiresRaw === true || requiresRaw === "true";

  let event_value: number | null = null;
  const valueRaw = pick("event_value");
  if (valueRaw !== null && valueRaw !== undefined && valueRaw !== "") {
    const n = Number(valueRaw);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: "Value must be a positive number." };
    }
    event_value = n;
  }

  let currency: string | null = null;
  const currencyRaw = pick("currency");
  if (typeof currencyRaw === "string" && currencyRaw.trim()) {
    const code = currencyRaw.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      return { ok: false, error: "Currency must be a 3-letter code (e.g. USD)." };
    }
    currency = code;
  }

  // Purchase (and any mapping explicitly flagged) must carry a real
  // amount + currency — we never invent one.
  const mustValue = requires_value || eventRequiresValue(meta_event_name);
  if (mustValue) {
    if (event_value === null || event_value <= 0) {
      return {
        ok: false,
        error: "Purchases need a value greater than 0. Enter the amount to send.",
      };
    }
    if (!currency) {
      return { ok: false, error: "Purchases need a currency (e.g. USD)." };
    }
  }

  const enabledRaw = pick("enabled");
  const enabled = enabledRaw === true || enabledRaw === "true";

  return {
    ok: true,
    value: {
      name,
      source_action,
      source_field,
      source_value,
      meta_event_name,
      action_source,
      requires_value: mustValue,
      event_value,
      currency,
      enabled,
    },
  };
}

export function toMappingInput(row: MetaCapiMappingRow): MappingInput {
  return {
    name: row.name,
    source_action: row.source_action,
    source_field: row.source_field,
    source_value: row.source_value,
    meta_event_name: row.meta_event_name,
    action_source: row.action_source,
    requires_value: row.requires_value,
    event_value: row.event_value,
    currency: row.currency,
    enabled: row.enabled,
  };
}

export { isStandardEvent };
