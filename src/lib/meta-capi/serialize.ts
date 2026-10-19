// ============================================================
// Meta Conversions API — safe public projections.
//
// These shapes are what the browser is allowed to see. The access
// token is NEVER included: the UI only ever learns whether a token is
// stored (`hasToken`), never its value.
// ============================================================

import type { MetaCapiConfigRow, MetaCapiDeliveryRow, MetaCapiMappingRow } from "./types";

export interface PublicCapiConfig {
  hasDataset: boolean;
  datasetId: string | null;
  hasToken: boolean;
  status: MetaCapiConfigRow["status"];
  testEventCode: string | null;
  actionSource: string;
  setupStep: number;
  lastError: string | null;
  lastVerifiedAt: string | null;
  tokenUpdatedAt: string | null;
}

export function toPublicConfig(row: MetaCapiConfigRow | null): PublicCapiConfig {
  return {
    hasDataset: Boolean(row?.dataset_id),
    datasetId: row?.dataset_id ?? null,
    hasToken: Boolean(row?.access_token),
    status: row?.status ?? "incomplete",
    testEventCode: row?.test_event_code ?? null,
    actionSource: row?.action_source ?? "business_messaging",
    setupStep: row?.setup_step ?? 1,
    lastError: row?.last_error ?? null,
    lastVerifiedAt: row?.last_verified_at ?? null,
    tokenUpdatedAt: row?.token_updated_at ?? null,
  };
}

export function toPublicMapping(row: MetaCapiMappingRow) {
  return {
    id: row.id,
    name: row.name,
    sourceAction: row.source_action,
    sourceField: row.source_field,
    sourceValue: row.source_value,
    metaEventName: row.meta_event_name,
    actionSource: row.action_source,
    requiresValue: row.requires_value,
    eventValue: row.event_value,
    currency: row.currency,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicDelivery(row: MetaCapiDeliveryRow) {
  return {
    id: row.id,
    eventName: row.event_name,
    eventId: row.event_id,
    sourceAction: row.source_action,
    sourceValue: row.source_value,
    status: row.status,
    attempts: row.attempts,
    isTest: row.is_test,
    lastError: row.last_error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}
