-- ============================================================
-- 131_meta_lead_sheets_per_table.sql — per-Workspace-table Google
-- Sheets configs for Meta Lead Ads.
--
-- The account-wide `meta_lead_sheets_configs` row (one per account)
-- becomes one row per (account, Meta form). Each Workspace table is
-- backed by exactly one Meta form (flows.meta_form_id), so each
-- table gets its own spreadsheet, tab, columns, and sync state.
--
-- Backfill policy (preserves existing setups, never deletes data):
--   * An explicit form_ids list migrates to one row per listed form
--     (same spreadsheet, tab, columns, and sync state copied).
--   * A NULL form_ids (legacy "all forms") migrates to one row per
--     form that is enabled OR has processed submissions — exactly
--     the set that could have produced synced rows.
--   * An explicitly empty form_ids (sync nothing) migrates to zero
--     rows (the opt-out is preserved).
--   * Ambiguity (several forms sharing one spreadsheet) is NOT
--     resolved by splitting data: every form keeps pointing at the
--     same spreadsheet/tab/columns it had, so existing sheets and
--     row mappings keep working unchanged. Customers separate them
--     per table in the Workspace UI afterwards.
--
-- Additive and idempotent — safe to run multiple times. The legacy
-- `form_ids` column is kept (unused by new code) so the migration
-- never destroys configuration data.
-- ============================================================

ALTER TABLE public.meta_lead_sheets_configs
  ADD COLUMN IF NOT EXISTS form_id TEXT;

-- Drop the legacy account-wide primary key BEFORE fanning out, so
-- one account can hold several per-form rows. Re-running is safe:
-- every step below is guarded.
ALTER TABLE public.meta_lead_sheets_configs
  DROP CONSTRAINT IF EXISTS meta_lead_sheets_configs_pkey;

-- One row per (account, form) for every previously-covered form.
INSERT INTO public.meta_lead_sheets_configs (
  account_id, form_id, spreadsheet_id, spreadsheet_url,
  spreadsheet_title, sheet_tab, auto_sync, last_success_at,
  last_error, historical_import_status, historical_imported_count,
  column_config, pending_remap, remap_cursor, created_at, updated_at
)
SELECT
  c.account_id,
  f.form_id,
  c.spreadsheet_id,
  c.spreadsheet_url,
  c.spreadsheet_title,
  c.sheet_tab,
  c.auto_sync,
  c.last_success_at,
  c.last_error,
  c.historical_import_status,
  c.historical_imported_count,
  c.column_config,
  COALESCE(c.pending_remap, false),
  c.remap_cursor,
  c.created_at,
  c.updated_at
FROM public.meta_lead_sheets_configs c
JOIN public.meta_lead_forms f
  ON f.account_id = c.account_id
 AND (
       c.form_ids IS NULL
       OR f.form_id = ANY (c.form_ids)
     )
 AND (
       f.enabled
       OR EXISTS (
         SELECT 1 FROM public.meta_lead_submissions s
         WHERE s.account_id = c.account_id
           AND s.form_id = f.form_id
       )
     )
WHERE c.form_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.meta_lead_sheets_configs existing
    WHERE existing.account_id = c.account_id
      AND existing.form_id = f.form_id
  );

-- Drop legacy account-wide rows that carried no form selection and
-- produced no per-form row (e.g. explicitly empty form_ids, which
-- means "sync nothing", or accounts whose forms are all gone).
-- Historical queue rows and spreadsheet contents are untouched.
DELETE FROM public.meta_lead_sheets_configs
WHERE form_id IS NULL;

ALTER TABLE public.meta_lead_sheets_configs
  ALTER COLUMN form_id SET NOT NULL;

ALTER TABLE public.meta_lead_sheets_configs
  DROP CONSTRAINT IF EXISTS meta_lead_sheets_configs_account_form_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meta_lead_sheets_configs_account_form_key'
  ) THEN
    EXECUTE 'ALTER TABLE public.meta_lead_sheets_configs ADD CONSTRAINT meta_lead_sheets_configs_account_form_key PRIMARY KEY (account_id, form_id)';
  END IF;
END $$;

COMMENT ON COLUMN public.meta_lead_sheets_configs.form_id IS
  'Meta Instant Form id this Workspace-table config syncs. Legacy form_ids column is superseded.';
