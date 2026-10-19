// ============================================================
// Meta Conversions API — catalog of valid events, action sources and
// (real) trigger sources. The trigger sources are the server-side
// domain operations that actually exist in WhatsApp Max — no invented
// workflow stages.
// ============================================================

export interface EventCatalogEntry {
  name: string;
  label: string;
  description: string;
  requiresValue?: boolean;
}

/** Meta standard events we expose, with plain-language meanings. */
export const STANDARD_EVENTS: EventCatalogEntry[] = [
  {
    name: "Lead",
    label: "Lead",
    description:
      "A person expressed interest in your business — e.g. an Instant Form was submitted or a WhatsApp lead was captured.",
  },
  {
    name: "Contact",
    label: "Contact",
    description: "A person contacted your business (e.g. reached out on WhatsApp).",
  },
  {
    name: "CompleteRegistration",
    label: "Complete registration",
    description: "A person completed a registration step or form.",
  },
  {
    name: "Schedule",
    label: "Schedule",
    description: "A person scheduled an appointment or consultation with your business.",
  },
  {
    name: "Purchase",
    label: "Purchase",
    description:
      "A real, confirmed transaction took place. Requires an amount and currency, and must ONLY be sent once the transaction is genuinely confirmed.",
    requiresValue: true,
  },
];

export interface ActionSourceEntry {
  value: string;
  label: string;
}

/** Meta accepted `action_source` values. */
export const ACTION_SOURCES: ActionSourceEntry[] = [
  { value: "business_messaging", label: "Business messaging (WhatsApp / Messenger)" },
  { value: "website", label: "Website" },
  { value: "app", label: "App" },
  { value: "phone_call", label: "Phone call" },
  { value: "chat", label: "Chat" },
  { value: "email", label: "Email" },
  { value: "physical_store", label: "Physical store" },
  { value: "system_generated", label: "System generated" },
  { value: "other", label: "Other" },
];

export type TriggerSource =
  | "meta_lead_received"
  | "flow_completed"
  | "workspace_field_changed";

export interface TriggerSourceEntry {
  value: TriggerSource;
  label: string;
  description: string;
  /** True when the mapping must specify a Workspace column name. */
  needsField: boolean;
  /** True when the mapping must specify the exact value to match. */
  needsValue: boolean;
}

/**
 * The ONLY trigger sources offered. Each maps to a server-side domain
 * operation that is actually persisted in WhatsApp Max.
 */
export const TRIGGER_SOURCES: TriggerSourceEntry[] = [
  {
    value: "meta_lead_received",
    label: "Meta Instant Form lead received",
    description:
      "Fires when a Facebook/Instagram Instant Form submission is ingested into the Workspace.",
    needsField: false,
    needsValue: false,
  },
  {
    value: "flow_completed",
    label: "WhatsApp flow completed",
    description:
      "Fires when a WhatsApp conversational flow run finishes successfully.",
    needsField: false,
    needsValue: false,
  },
  {
    value: "workspace_field_changed",
    label: "Workspace column set to a value",
    description:
      "Fires when a Workspace column is changed to a specific value — e.g. Stage = Booking Confirmed. Only fires on an actual change, never on re-saves of the same value.",
    needsField: true,
    needsValue: true,
  },
];

export function isTriggerSource(value: string): value is TriggerSource {
  return TRIGGER_SOURCES.some((t) => t.value === value);
}

/** Meta custom event names: alphanumeric/underscore, not starting with a digit. */
export function isValidEventName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(name.trim());
}

export function isStandardEvent(name: string): boolean {
  return STANDARD_EVENTS.some((e) => e.name === name);
}

/** Only Purchase genuinely requires a monetary value. */
export function eventRequiresValue(name: string): boolean {
  return name === "Purchase";
}

export function isValidActionSource(value: string): boolean {
  return ACTION_SOURCES.some((a) => a.value === value);
}
