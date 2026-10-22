// ============================================================
// Meta Conversions API — event construction + mapping evaluation.
//
// Pure functions only (no IO): deciding whether a configured mapping
// applies to a domain action, deriving a STABLE event id (so retries
// de-duplicate), building the `custom_data` value/currency block, and
// assembling the final CAPI request payload. Kept separate so the
// tricky bits are directly unit-testable.
// ============================================================

import type { TriggerSource } from "./catalog";
import type { UserDataInput } from "./hash";
import type { MetaCapiMappingRow } from "./types";

/** A real server-side domain action that may map to a Meta event. */
export interface CapiActionEvent {
  accountId: string;
  action: TriggerSource;
  flowRunId?: string | null;
  contactId?: string | null;
  /** Workspace column name (workspace_field_changed only). */
  fieldName?: string | null;
  /** New cell value (workspace_field_changed only). */
  value?: string | null;
  /**
   * Stored value before this change (workspace_field_changed only).
   * Part of the stable event id so each distinct from → to transition
   * fires at most once per mapping + lead, while concurrent duplicates
   * of the SAME transition collapse to one delivery.
   */
  previousValue?: string | null;
  occurredAt?: Date;
  matchData?: UserDataInput | null;
}

/**
 * Whether a mapping is even applicable to this action. A
 * workspace_field_changed mapping only applies when the changed column
 * matches AND the new value matches the configured value (if any).
 * Non-matching mappings are silently not-applicable (not "skipped").
 */
export function matchesMapping(
  mapping: MetaCapiMappingRow,
  event: CapiActionEvent,
): boolean {
  if (mapping.source_action !== event.action) return false;
  if (event.action === "workspace_field_changed") {
    if (!mapping.source_field) return false;
    if ((event.fieldName ?? "") !== mapping.source_field) return false;
    const value = event.value ?? "";
    if (!value) return false;
    if (mapping.source_value && value !== mapping.source_value) return false;
  }
  return true;
}

/** True for events that MUST carry a monetary value (only Purchase). */
export function requiresValue(mapping: MetaCapiMappingRow): boolean {
  return mapping.requires_value || mapping.meta_event_name === "Purchase";
}

/**
 * Guard against firing a value-bearing event with no real amount — we
 * never invent a value or send a zero/negative Purchase.
 */
export function valueCriteriaMet(mapping: MetaCapiMappingRow): boolean {
  if (!requiresValue(mapping)) return true;
  const value = mapping.event_value;
  if (value === null || value === undefined) return false;
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return false;
  return Boolean(mapping.currency);
}

/**
 * Stable event id. Retries reuse it (they re-send the stored payload),
 * so Meta de-duplicates. A workspace_field_changed transition is keyed
 * by its from → to values (never by wall-clock time), so concurrent
 * double-fires of the SAME transition collapse to one delivery.
 *
 * Trade-off: repeating an identical transition later (e.g. Qualified →
 * Lost → Qualified) resolves to the same id and does NOT send again.
 * To report a re-qualification, configure a distinct value (for example
 * a "Re-Qualified" stage) or a separate mapping.
 */
export function buildEventId(
  mapping: MetaCapiMappingRow,
  event: CapiActionEvent,
  _occurredAt: Date,
): string {
  void _occurredAt;
  const basis = event.flowRunId ?? event.contactId ?? "unknown";
  if (event.action === "meta_lead_received") return `${mapping.id}:${basis}:meta_lead`;
  if (event.action === "flow_completed") return `${mapping.id}:${basis}:completed`;
  const field = event.fieldName ?? "";
  const from = event.previousValue ?? "";
  const to = event.value ?? "";
  return `${mapping.id}:${basis}:${field}:${from}:${to}`;
}

export function buildCustomData(mapping: MetaCapiMappingRow): Record<string, unknown> {
  const custom: Record<string, unknown> = {};
  if (mapping.event_value !== null && mapping.event_value !== undefined) {
    custom.value = Number(mapping.event_value);
  }
  if (mapping.currency) custom.currency = mapping.currency;
  return custom;
}

/**
 * CRM lifecycle events (e.g. a Workspace Stage change to Qualified
 * on a Meta Lead Ads table) are NOT messaging conversions: Meta
 * rejects them with `business_messaging` unless a messaging_channel
 * is present, which a CRM UI edit never has. The validated shape is
 * `action_source: "system_generated"` plus the CRM markers below.
 * Per requirement, `lead_event_source` identifies the originating
 * CRM ("WhatsApp Max"). Value/currency handling is unchanged.
 */
export const CRM_EVENT_SOURCE = "crm";
export const CRM_LEAD_EVENT_SOURCE = "WhatsApp Max";

export function buildCrmCustomData(mapping: MetaCapiMappingRow): Record<string, unknown> {
  return {
    ...buildCustomData(mapping),
    event_source: CRM_EVENT_SOURCE,
    lead_event_source: CRM_LEAD_EVENT_SOURCE,
  };
}

export interface CapiEventObject {
  event_name: string;
  event_time: number;
  action_source: string;
  event_id: string;
  user_data: Record<string, string>;
  custom_data?: Record<string, unknown>;
}

export function buildCapiEvent(args: {
  eventName: string;
  eventId: string;
  actionSource: string;
  eventTime: Date;
  userData: Record<string, string>;
  customData?: Record<string, unknown>;
}): CapiEventObject {
  const event: CapiEventObject = {
    event_name: args.eventName,
    event_time: Math.floor(args.eventTime.getTime() / 1000),
    action_source: args.actionSource,
    event_id: args.eventId,
    user_data: args.userData,
  };
  if (args.customData && Object.keys(args.customData).length > 0) {
    event.custom_data = args.customData;
  }
  return event;
}

export function buildRequestPayload(
  event: CapiEventObject,
  testEventCode?: string | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { data: [event] };
  if (testEventCode) payload.test_event_code = testEventCode;
  return payload;
}
