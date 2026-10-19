// ============================================================
// Meta Conversions API — persistence helpers.
//
// Every read/write is account-scoped (tenant isolation) and every
// token is encrypted/decrypted in exactly one place. Callers pass a
// service-role client for server-side delivery paths and the RLS
// client for user-initiated reads.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import type { TriggerSource } from "./catalog";
import type {
  MetaCapiConfigRow,
  MetaCapiDeliveryRow,
  MetaCapiMappingRow,
} from "./types";

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

export async function getConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<MetaCapiConfigRow | null> {
  const { data, error } = await db
    .from("meta_capi_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as MetaCapiConfigRow | null) ?? null;
}

/** Decrypted service token, or null when none is stored. */
export async function getDecryptedToken(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const row = await getConfig(db, accountId);
  if (!row?.access_token) return null;
  return decrypt(row.access_token);
}

/**
 * Decrypted App Secret of the Meta app that issued the token, or null.
 * Used only to compute appsecret_proof; never exposed to the browser.
 */
export async function getDecryptedAppSecret(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const row = await getConfig(db, accountId);
  if (!row?.app_secret) return null;
  return decrypt(row.app_secret);
}

async function upsertConfig(
  db: SupabaseClient,
  accountId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("meta_capi_config").upsert(
    {
      account_id: accountId,
      updated_at: new Date().toISOString(),
      ...patch,
    },
    { onConflict: "account_id" },
  );
  if (error) throw error;
}

export async function saveDataset(
  db: SupabaseClient,
  accountId: string,
  datasetId: string,
): Promise<void> {
  await upsertConfig(db, accountId, {
    dataset_id: datasetId,
    last_verified_at: new Date().toISOString(),
    last_error: null,
  });
}

export async function saveToken(
  db: SupabaseClient,
  accountId: string,
  token: string,
): Promise<void> {
  await upsertConfig(db, accountId, {
    access_token: encrypt(token),
    token_updated_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
    last_error: null,
  });
}

/** Forget just the stored token (keeps the dataset id). */
export async function clearToken(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  await upsertConfig(db, accountId, {
    access_token: null,
    token_updated_at: null,
    status: "incomplete",
    last_error: null,
  });
}

/** Store the optional, encrypted App Secret that matches the token. */
export async function saveAppSecret(
  db: SupabaseClient,
  accountId: string,
  appSecret: string,
): Promise<void> {
  await upsertConfig(db, accountId, {
    app_secret: encrypt(appSecret),
    last_error: null,
  });
}

/** Forget the stored App Secret (token and dataset are kept). */
export async function clearAppSecret(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  await upsertConfig(db, accountId, { app_secret: null });
}

export async function markConfigStatus(
  db: SupabaseClient,
  accountId: string,
  status: MetaCapiConfigRow["status"],
  lastError: string | null,
): Promise<void> {
  await upsertConfig(db, accountId, { status, last_error: lastError });
}

export async function saveTestEventCode(
  db: SupabaseClient,
  accountId: string,
  code: string | null,
): Promise<void> {
  await upsertConfig(db, accountId, { test_event_code: code });
}

export async function saveActionSource(
  db: SupabaseClient,
  accountId: string,
  actionSource: string,
): Promise<void> {
  await upsertConfig(db, accountId, { action_source: actionSource });
}

export async function saveSetupStep(
  db: SupabaseClient,
  accountId: string,
  step: number,
): Promise<void> {
  await upsertConfig(db, accountId, { setup_step: step });
}

/** Remove the customer's CAPI credentials (keeps mappings). */
export async function clearCredentials(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  await upsertConfig(db, accountId, {
    access_token: null,
    app_secret: null,
    dataset_id: null,
    status: "incomplete",
    test_event_code: null,
    last_verified_at: null,
    last_error: null,
    setup_step: 1,
  });
}

// ---------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------

export async function listMappings(
  db: SupabaseClient,
  accountId: string,
): Promise<MetaCapiMappingRow[]> {
  const { data, error } = await db
    .from("meta_capi_event_mappings")
    .select("*")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MetaCapiMappingRow[];
}

export async function getMapping(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<MetaCapiMappingRow | null> {
  const { data, error } = await db
    .from("meta_capi_event_mappings")
    .select("*")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as MetaCapiMappingRow | null) ?? null;
}

export async function listEnabledMappingsForAction(
  db: SupabaseClient,
  accountId: string,
  action: TriggerSource,
): Promise<MetaCapiMappingRow[]> {
  const { data, error } = await db
    .from("meta_capi_event_mappings")
    .select("*")
    .eq("account_id", accountId)
    .eq("source_action", action)
    .eq("enabled", true);
  if (error) throw error;
  return (data ?? []) as MetaCapiMappingRow[];
}

export async function insertMapping(
  db: SupabaseClient,
  row: Omit<MetaCapiMappingRow, "id" | "created_at" | "updated_at">,
): Promise<MetaCapiMappingRow> {
  const { data, error } = await db
    .from("meta_capi_event_mappings")
    .insert(row)
    .select("*")
    .single();
  if (error || !data) throw error ?? new Error("mapping insert failed");
  return data as MetaCapiMappingRow;
}

export async function updateMapping(
  db: SupabaseClient,
  accountId: string,
  id: string,
  patch: Partial<MetaCapiMappingRow>,
): Promise<MetaCapiMappingRow | null> {
  const { data, error } = await db
    .from("meta_capi_event_mappings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("account_id", accountId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as MetaCapiMappingRow | null) ?? null;
}

export async function deleteMapping(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<boolean> {
  const { error } = await db
    .from("meta_capi_event_mappings")
    .delete()
    .eq("id", id)
    .eq("account_id", accountId);
  if (error) throw error;
  return true;
}

// ---------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------

export interface NewDelivery {
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
  status: MetaCapiDeliveryRow["status"];
  last_error?: string | null;
  request_payload: Record<string, unknown> | null;
}

/**
 * Insert a delivery ledger row. Returns null when the
 * (account_id, event_id) key already exists — the idempotency signal
 * that this logical conversion has already been enqueued.
 */
export async function insertDelivery(
  db: SupabaseClient,
  row: NewDelivery,
): Promise<MetaCapiDeliveryRow | null> {
  const { data, error } = await db
    .from("meta_capi_deliveries")
    .insert(row)
    .select("*")
    .single();
  if (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
  return data as MetaCapiDeliveryRow;
}

export async function getDelivery(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<MetaCapiDeliveryRow | null> {
  const { data, error } = await db
    .from("meta_capi_deliveries")
    .select("*")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as MetaCapiDeliveryRow | null) ?? null;
}

export async function listDeliveries(
  db: SupabaseClient,
  accountId: string,
  limit = 25,
): Promise<MetaCapiDeliveryRow[]> {
  const { data, error } = await db
    .from("meta_capi_deliveries")
    .select("*")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as MetaCapiDeliveryRow[];
}

const STALE_CLAIM_MS = 5 * 60_000;

/** Atomically claim a retryable delivery (serializes concurrent workers). */
export async function claimDelivery(
  db: SupabaseClient,
  id: string,
): Promise<MetaCapiDeliveryRow | null> {
  const staleIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data, error } = await db
    .from("meta_capi_deliveries")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "failed")
    .or(`claimed_at.is.null,claimed_at.lt.${staleIso}`)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as MetaCapiDeliveryRow | null) ?? null;
}

export async function markDeliverySent(
  db: SupabaseClient,
  id: string,
  response: Record<string, unknown>,
  attempts: number,
): Promise<void> {
  const { error } = await db
    .from("meta_capi_deliveries")
    .update({
      status: "sent",
      attempts,
      response_payload: response,
      delivered_at: new Date().toISOString(),
      next_retry_at: null,
      claimed_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

export async function markDeliveryFailed(
  db: SupabaseClient,
  id: string,
  attempts: number,
  error: string,
  nextRetryAt: string | null,
): Promise<void> {
  const { error: dbErr } = await db
    .from("meta_capi_deliveries")
    .update({
      status: "failed",
      attempts,
      last_error: error.slice(0, 500),
      next_retry_at: nextRetryAt,
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (dbErr) throw dbErr;
}

export async function markDeliverySkipped(
  db: SupabaseClient,
  accountId: string,
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await db
    .from("meta_capi_deliveries")
    .update({
      status: "skipped",
      last_error: reason.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("account_id", accountId);
  if (error) throw error;
}

export async function listDueDeliveries(
  db: SupabaseClient,
  limit = 25,
  accountId?: string,
): Promise<MetaCapiDeliveryRow[]> {
  let query = db
    .from("meta_capi_deliveries")
    .select("*")
    .eq("status", "failed")
    .lte("next_retry_at", new Date().toISOString())
    .is("claimed_at", null)
    .order("next_retry_at", { ascending: true })
    .limit(limit);
  if (accountId) query = query.eq("account_id", accountId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as MetaCapiDeliveryRow[];
}
