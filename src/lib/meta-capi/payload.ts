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
 * so Meta de-duplicates. A workspace_field_changed transition is
 * timestamped so two genuine transitions are distinct events while a
 * concurrent double-fire of the SAME transition collapses.
 */
export function buildEventId(
  mapping: MetaCapiMappingRow,
  event: CapiActionEvent,
  occurredAt: Date,
): string {
  const basis = event.flowRunId ?? event.contactId ?? "unknown";
  if (event.action === "meta_lead_received") return `${mapping.id}:${basis}:meta_lead`;
  if (event.action === "flow_completed") return `${mapping.id}:${basis}:completed`;
  const field = event.fieldName ?? "";
  const value = event.value ?? "";
  return `${mapping.id}:${basis}:${field}:${value}:${occurredAt.getTime()}`;
}

export function buildCustomData(mapping: MetaCapiMappingRow): Record<string, unknown> {
  const custom: Record<string, unknown> = {};
  if (mapping.event_value !== null && mapping.event_value !== undefined) {
    custom.value = Number(mapping.event_value);
  }
  if (mapping.currency) custom.currency = mapping.currency;
  return custom;
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
