// ============================================================
// Meta CRM Integration — Supabase persistence (Feature 2).
//
// Stores ONLY non-secret dataset metadata in `meta_crm_datasets`.
// Access tokens are NEVER written here — they are used once
// server-side for the Meta Graph call and discarded.
//
// All queries are account-scoped; callers pass the RLS client from
// requireRole/getCurrentAccount and the server-resolved accountId.
// Never trust a browser-supplied account_id.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CrmDatasetRow {
  id: string;
  account_id: string;
  business_portfolio_id: string;
  dataset_id: string;
  dataset_name: string;
  dataset_type: string;
  creation_status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicCrmDataset {
  id: string;
  datasetId: string;
  datasetName: string;
  businessPortfolioId: string;
  datasetType: string;
  creationStatus: string;
  createdAt: string;
}

export function toPublicCrmDataset(row: CrmDatasetRow): PublicCrmDataset {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    businessPortfolioId: row.business_portfolio_id,
    datasetType: row.dataset_type,
    creationStatus: row.creation_status,
    createdAt: row.created_at,
  };
}

/**
 * Normalize a raw datasets payload into dropdown-ready rows.
 *
 * Keeps every row with a usable internal `id` and Meta `datasetId`,
 * regardless of creation status — both `Created` (made in WhatsApp
 * Max) and `Registered` (added via Add Existing) datasets are
 * eligible for CRM Feedback. Malformed rows are skipped
 * individually so one bad record can never blank the whole list.
 */
export function normalizePublicDatasets(rows: unknown): PublicCrmDataset[] {
  if (!Array.isArray(rows)) return [];
  const out: PublicCrmDataset[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.trim() === "") continue;
    if (typeof row.dataset_id !== "string" || row.dataset_id.trim() === "") continue;
    out.push(toPublicCrmDataset(row as unknown as CrmDatasetRow));
  }
  return out;
}

export interface SaveCrmDatasetInput {
  accountId: string;
  businessPortfolioId: string;
  datasetId: string;
  datasetName: string;
  datasetType?: string;
  creationStatus?: string;
  createdBy?: string | null;
}

export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "23505";
}

/**
 * Insert one dataset metadata row. On a duplicate
 * (account_id, dataset_id) returns the existing row instead of
 * throwing, so retries and double-submits stay idempotent.
 */
export async function saveCrmDataset(
  db: SupabaseClient,
  input: SaveCrmDatasetInput,
): Promise<{ row: CrmDatasetRow; created: boolean }> {
  const payload = {
    account_id: input.accountId,
    business_portfolio_id: input.businessPortfolioId,
    dataset_id: input.datasetId,
    dataset_name: input.datasetName,
    dataset_type: input.datasetType ?? "CRM",
    creation_status: input.creationStatus ?? "Created",
    created_by: input.createdBy ?? null,
  };
  const { data, error } = await db
    .from("meta_crm_datasets")
    .insert(payload)
    .select("*")
    .single();
  if (!error && data) {
    return { row: data as CrmDatasetRow, created: true };
  }
  if (error && isUniqueViolation(error)) {
    const { data: existing, error: readError } = await db
      .from("meta_crm_datasets")
      .select("*")
      .eq("account_id", input.accountId)
      .eq("dataset_id", input.datasetId)
      .maybeSingle();
    if (!readError && existing) {
      return { row: existing as CrmDatasetRow, created: false };
    }
  }
  throw error ?? new Error("Failed to save CRM dataset.");
}

export async function listCrmDatasets(
  db: SupabaseClient,
  accountId: string,
  limit = 100,
): Promise<CrmDatasetRow[]> {
  const bounded = Math.max(1, Math.min(limit, 200));
  const { data, error } = await db
    .from("meta_crm_datasets")
    .select("*")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(bounded);
  if (error) throw error;
  return ((data ?? []) as CrmDatasetRow[]).filter(
    (r) => typeof r.id === "string" && typeof r.dataset_id === "string",
  );
}
