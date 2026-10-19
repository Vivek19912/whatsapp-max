-- ============================================================
-- 123_meta_lead_manual_setup.sql — Trace-style manual Meta setup.
--
-- Meta Lead Ads no longer requires the Facebook OAuth consent flow.
-- An account admin pastes three values once:
--
--   * Dataset / Pixel ID
--   * System User access token (encrypted at rest)
--   * Facebook Page ID
--
-- This migration adds the small amount of state that setup and the
-- continuous sync need. Nothing here changes the lead model: a lead
-- is still a normal `flow_runs` row linked from
-- `meta_lead_submissions`.
--
--   * meta_lead_connections.dataset_id    — the customer's dataset id
--   * meta_lead_connections.setup_source  — how the token was added
--   * meta_lead_pages.last_synced_at      — last "Load My Forms"
--   * meta_lead_pages.last_polled_at      — last polling sweep
--   * meta_lead_forms.import_*            — historical import cursor
--   * meta_lead_forms.last_polled_at /
--     last_lead_at                        — polling bookkeeping
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. Manual credentials ---------------------------
ALTER TABLE public.meta_lead_connections
  ADD COLUMN IF NOT EXISTS dataset_id TEXT;

ALTER TABLE public.meta_lead_connections
  ADD COLUMN IF NOT EXISTS setup_source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE public.meta_lead_connections
  DROP CONSTRAINT IF EXISTS meta_lead_connections_setup_source_check;
ALTER TABLE public.meta_lead_connections
  ADD CONSTRAINT meta_lead_connections_setup_source_check
  CHECK (setup_source IN ('oauth', 'manual'));

COMMENT ON COLUMN public.meta_lead_connections.dataset_id IS
  'Meta dataset / pixel id supplied during the manual (Trace-style) setup. Not a secret.';
COMMENT ON COLUMN public.meta_lead_connections.setup_source IS
  'How the stored token was obtained: legacy OAuth or manual pasted System User token.';

-- ---------- 2. Per-Page sync bookkeeping --------------------
ALTER TABLE public.meta_lead_pages
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
ALTER TABLE public.meta_lead_pages
  ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ;

-- ---------- 3. Historical import + polling state ------------
ALTER TABLE public.meta_lead_forms
  ADD COLUMN IF NOT EXISTS import_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE public.meta_lead_forms
  ADD COLUMN IF NOT EXISTS import_cursor TEXT;
ALTER TABLE public.meta_lead_forms
  ADD COLUMN IF NOT EXISTS imported_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.meta_lead_forms
  ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ;
ALTER TABLE public.meta_lead_forms
  ADD COLUMN IF NOT EXISTS last_lead_at TIMESTAMPTZ;

ALTER TABLE public.meta_lead_forms
  DROP CONSTRAINT IF EXISTS meta_lead_forms_import_status_check;
ALTER TABLE public.meta_lead_forms
  ADD CONSTRAINT meta_lead_forms_import_status_check
  CHECK (import_status IN ('idle', 'importing', 'done', 'error'));

CREATE INDEX IF NOT EXISTS idx_meta_lead_forms_poll
  ON public.meta_lead_forms(account_id, last_polled_at)
  WHERE enabled;

COMMENT ON COLUMN public.meta_lead_forms.import_status IS
  'Historical import state: idle (not started), importing (cursor not exhausted), done, error.';
COMMENT ON COLUMN public.meta_lead_forms.import_cursor IS
  'Meta Graph pagination cursor for the historical import. NULL means start from the newest page.';
COMMENT ON COLUMN public.meta_lead_forms.imported_count IS
  'Number of NEW leads recorded by the historical import (duplicates are not counted).';
