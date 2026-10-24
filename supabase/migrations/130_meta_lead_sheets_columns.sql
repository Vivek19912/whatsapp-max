-- ============================================================
-- 130_meta_lead_sheets_columns.sql — per-account form selection +
-- custom spreadsheet columns for Meta Lead Ads Sheets sync.
--
-- Scope protection: this migration touches ONLY the
-- `meta_lead_sheets_configs` table created in migration 129. No
-- other table (flows, Flow Tables, All Sheets, CAPI, Meta Lead
-- Ads lead tables) is altered.
--
--   * form_ids       — Meta form_ids selected for sync. NULL =
--                      legacy (no filter, sync all forms).
--                      Empty array = sync nothing.
--   * column_config  — ordered JSONB [{key, label}] of visible
--                      columns. NULL = legacy fixed 12-column layout.
--                      The stable Meta Lead ID is always pinned to
--                      column A (hidden via the API when deselected)
--                      so row matching never depends on visibility.
--   * pending_remap  — a header/layout change is being rolled out
--                      to already-written managed rows; the drain
--                      resumes it in bounded chunks.
--   * remap_cursor   — last sheet row number remapped (resume point).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.meta_lead_sheets_configs
  ADD COLUMN IF NOT EXISTS form_ids TEXT[] NULL;

ALTER TABLE public.meta_lead_sheets_configs
  ADD COLUMN IF NOT EXISTS column_config JSONB NULL;

ALTER TABLE public.meta_lead_sheets_configs
  ADD COLUMN IF NOT EXISTS pending_remap BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.meta_lead_sheets_configs
  ADD COLUMN IF NOT EXISTS remap_cursor INT NULL;

COMMENT ON COLUMN public.meta_lead_sheets_configs.form_ids IS
  'Meta form_ids selected for Sheets sync. NULL = legacy (all forms). Empty array = sync nothing.';
COMMENT ON COLUMN public.meta_lead_sheets_configs.column_config IS
  'Ordered visible columns [{key, label}]. NULL = legacy fixed 12-column layout. The lead ID stays pinned to column A.';
COMMENT ON COLUMN public.meta_lead_sheets_configs.pending_remap IS
  'A layout change is being rolled out to managed rows; the drain resumes it in bounded chunks.';
COMMENT ON COLUMN public.meta_lead_sheets_configs.remap_cursor IS
  'Last sheet row number remapped (resume point for pending_remap).';
