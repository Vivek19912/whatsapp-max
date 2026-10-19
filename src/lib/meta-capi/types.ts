// ============================================================
// Meta Conversions API — persistence row shapes.
// ============================================================

import type { TriggerSource } from "./catalog";

export interface MetaCapiConfigRow {
  id: string;
  account_id: string;
  dataset_id: string | null;
  access_token: string | null;
  /** Optional, encrypted App Secret of the app that issued access_token. */
  app_secret: string | null;
  status: "incomplete" | "connected" | "error";
  test_event_code: string | null;
  action_source: string;
  setup_step: number;
  last_error: string | null;
  last_verified_at: string | null;
  token_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaCapiMappingRow {
  id: string;
  account_id: string;
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
  created_at: string;
  updated_at: string;
}

export type MetaCapiDeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export interface MetaCapiDeliveryRow {
  id: string;
  account_id: string;
  mapping_id: string | null;
  flow_run_id: string | null;
  contact_id: string | null;
  source_action: string;
  source_value: string | null;
  event_name: string;
  event_id: string;
  action_source: string;
  is_test: boolean;
  status: MetaCapiDeliveryStatus;
  attempts: number;
  last_error: string | null;
  request_payload: Record<string, unknown> | null;
  response_payload: Record<string, unknown> | null;
  next_retry_at: string | null;
  claimed_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}
