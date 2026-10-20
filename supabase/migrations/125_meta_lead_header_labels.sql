-- ============================================================
-- 125_meta_lead_header_labels.sql — Meta Lead Ads custom header names.
--
-- One row per renamed Instant Form question column, keyed by the
-- STABLE flow column identity (the var_key-derived flow column key,
-- never the display label — renames must not orphan a customization).
-- The original question text stays untouched in flow_nodes config;
-- only the display override persists here, so new imports keep
-- feeding the same field mappings and restoring is a row delete.
--
-- Scope is (account_id, flow_id): one virtual Meta flow (one
-- enabled Instant Form) never leaks labels into another form's
-- table. Flow Tables (kind <> 'meta_lead_ads') never read or write
-- this table — the API rejects non-Meta flows outright.
--
-- Writes are agent+ (same bar as header colors / cell edits —
-- viewers stay read-only everywhere). Google Sheets never reads
-- this table.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.meta_lead_header_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant + virtual-flow scope: overrides belong to exactly one
  -- Meta Lead Ads table. Both cascade (account wipe, flow delete).
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  -- Stable flow column key (var_key), NOT the display label.
  column_key TEXT NOT NULL,
  -- Custom header text (validated by the API: non-blank, bounded).
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_header_labels_key_unique
    UNIQUE (account_id, flow_id, column_key)
);

-- Hot path: "all overrides for this Meta table".
CREATE INDEX IF NOT EXISTS idx_meta_lead_header_labels_flow
  ON public.meta_lead_header_labels (account_id, flow_id);

-- ============================================================
-- RLS — account isolation on every path.
-- ============================================================
ALTER TABLE public.meta_lead_header_labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_lead_header_labels_select ON public.meta_lead_header_labels;
CREATE POLICY meta_lead_header_labels_select ON public.meta_lead_header_labels FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_lead_header_labels_insert ON public.meta_lead_header_labels;
CREATE POLICY meta_lead_header_labels_insert ON public.meta_lead_header_labels FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS meta_lead_header_labels_update ON public.meta_lead_header_labels;
CREATE POLICY meta_lead_header_labels_update ON public.meta_lead_header_labels FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS meta_lead_header_labels_delete ON public.meta_lead_header_labels;
CREATE POLICY meta_lead_header_labels_delete ON public.meta_lead_header_labels FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_header_labels;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_header_labels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
