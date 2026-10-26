-- ============================================================
-- 136_meta_lead_sheets_import_jobs.sql — durable import jobs for
-- Meta Lead Ads → Google Sheets manual imports ONLY.
--
-- Scope protection: this migration touches ONLY the new
-- `meta_lead_sheets_import_jobs` table. It does NOT alter flows,
-- flow_runs, workspace_*, message_templates, whatsapp_config,
-- meta_lead_sheets_configs/queue/connections, or any Flow
-- Tables / All Sheets / Travel CRM state.
--
-- Why this exists: the Import Leads route used to classify,
-- enqueue, AND drain up to 2000 leads inside a single HTTP
-- request (60s+ of sequential Google API calls → gateway 504
-- with partial completion). Import jobs make that durable:
--   * POST creates one job row and enqueues its leads (DB-local,
--     bulk operations — returns in seconds), then runs a single
--     bounded worker pass.
--   * The job records the exact submission snapshot
--     (submission_ids + already-mapped ids), classification
--     totals, and live progress counters. Status polling is a
--     pure read — it never restarts work.
--   * A partial unique index allows only ONE active
--     (queued/running) job per (account, Meta form), so double
--     clicks, retries, and concurrent workers cannot start a
--     second import for the same table. Concurrent workers
--     serialize on the row's claimed_at claim.
--   * Matching stays Meta-Lead-ID based in the drain: re-pumps
--     update existing sheet rows in place, never duplicate.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.meta_lead_sheets_import_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id           TEXT NOT NULL,
  flow_id           UUID NULL,
  mode              TEXT NOT NULL DEFAULT 'all'
                      CHECK (mode IN ('all', 'range')),
  range_from        DATE NULL,
  range_to          DATE NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total             INT NOT NULL DEFAULT 0,
  skipped           INT NOT NULL DEFAULT 0,
  inserted_total    INT NOT NULL DEFAULT 0,
  updated_total     INT NOT NULL DEFAULT 0,
  sent_total        INT NOT NULL DEFAULT 0,
  failed_total      INT NOT NULL DEFAULT 0,
  truncated         BOOLEAN NOT NULL DEFAULT false,
  submission_ids    JSONB NOT NULL DEFAULT '[]',
  mapped_ids        JSONB NOT NULL DEFAULT '[]',
  consecutive_errors INT NOT NULL DEFAULT 0,
  last_error        TEXT NULL,
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NULL,
  finished_at       TIMESTAMPTZ NULL,
  claimed_at        TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active import per (account, form). Completed/failed/
-- cancelled jobs are history and never block a new import.
DROP INDEX IF EXISTS idx_meta_lead_sheets_import_jobs_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_lead_sheets_import_jobs_one_active
  ON public.meta_lead_sheets_import_jobs(account_id, form_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_meta_lead_sheets_import_jobs_active
  ON public.meta_lead_sheets_import_jobs(account_id, status, created_at DESC)
  WHERE status IN ('queued', 'running');

COMMENT ON TABLE public.meta_lead_sheets_import_jobs IS
  'Durable manual-import jobs for Meta Lead Ads Workspace tables. submission_ids is the exact lead snapshot; the drain matches by stable Meta Lead ID so re-pumps update in place and never duplicate.';

DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_sheets_import_jobs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_sheets_import_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.meta_lead_sheets_import_jobs ENABLE ROW LEVEL SECURITY;
-- Members may READ job status/progress (polling); writes are
-- service-role only after an owner check in the route.
DROP POLICY IF EXISTS meta_lead_sheets_import_jobs_select ON public.meta_lead_sheets_import_jobs;
CREATE POLICY meta_lead_sheets_import_jobs_select ON public.meta_lead_sheets_import_jobs
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_lead_sheets_import_jobs_insert ON public.meta_lead_sheets_import_jobs;
CREATE POLICY meta_lead_sheets_import_jobs_insert ON public.meta_lead_sheets_import_jobs
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_sheets_import_jobs_update ON public.meta_lead_sheets_import_jobs;
CREATE POLICY meta_lead_sheets_import_jobs_update ON public.meta_lead_sheets_import_jobs
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_sheets_import_jobs_delete ON public.meta_lead_sheets_import_jobs;
CREATE POLICY meta_lead_sheets_import_jobs_delete ON public.meta_lead_sheets_import_jobs
  FOR DELETE USING (is_account_member(account_id, 'admin'));
