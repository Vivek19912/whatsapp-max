-- ============================================================
-- 174_meta_crm_datasets.sql — Meta CRM Integration dataset registry.
--
-- Feature 2: permanent storage for Meta CRM datasets created (or
-- registered) from Settings → Meta → CRM Integration.
--
--   meta_crm_datasets — one row per (account, Meta dataset). Stores
--   ONLY non-secret metadata (ids + names + status). Access tokens
--   are NEVER stored here — they are used once server-side for the
--   Meta Graph call and then discarded.
--
-- Independent from the retired Conversions API (`meta_capi_*`)
-- tables, which remain untouched.
--
-- Tenant isolation: account_id + is_account_member(...). Reads are
-- member-scoped; writes are admin-scoped (same as other Meta setup
-- tables). The browser never supplies account_id — routes resolve it
-- server-side from the caller's profile.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. meta_crm_datasets -------------------------------
CREATE TABLE IF NOT EXISTS public.meta_crm_datasets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  business_portfolio_id TEXT NOT NULL,
  dataset_id            TEXT NOT NULL,
  dataset_name          TEXT NOT NULL,
  dataset_type          TEXT NOT NULL DEFAULT 'CRM',
  creation_status       TEXT NOT NULL DEFAULT 'Created',
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_crm_datasets_account_dataset_key UNIQUE (account_id, dataset_id)
);

COMMENT ON TABLE public.meta_crm_datasets IS
  'Meta CRM datasets registered in WhatsApp Max (Settings → Meta → CRM Integration). Non-secret metadata only; access tokens are never stored.';
COMMENT ON COLUMN public.meta_crm_datasets.dataset_id IS
  'Original Meta Dataset ID (numeric string). Preserved as text to avoid JS number precision issues.';
COMMENT ON COLUMN public.meta_crm_datasets.business_portfolio_id IS
  'Meta Business Portfolio ID the dataset was created under (numeric string, preserved as text).';

CREATE INDEX IF NOT EXISTS idx_meta_crm_datasets_account
  ON public.meta_crm_datasets(account_id, created_at DESC);

-- ---------- 2. updated_at trigger -----------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_crm_datasets;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_crm_datasets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 3. RLS --------------------------------------------
ALTER TABLE public.meta_crm_datasets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_crm_datasets_select ON public.meta_crm_datasets;
CREATE POLICY meta_crm_datasets_select ON public.meta_crm_datasets
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_crm_datasets_insert ON public.meta_crm_datasets;
CREATE POLICY meta_crm_datasets_insert ON public.meta_crm_datasets
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_crm_datasets_update ON public.meta_crm_datasets;
CREATE POLICY meta_crm_datasets_update ON public.meta_crm_datasets
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_crm_datasets_delete ON public.meta_crm_datasets;
CREATE POLICY meta_crm_datasets_delete ON public.meta_crm_datasets
  FOR DELETE USING (is_account_member(account_id, 'admin'));
