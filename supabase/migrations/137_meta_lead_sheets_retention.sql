-- ============================================================
-- 137_meta_lead_sheets_retention.sql — safe retention for Meta
-- Lead Ads Google Sheets auth states + import-job history.
--
-- Scope protection: this migration touches ONLY
-- meta_lead_sheets_* tables. It does NOT alter flows,
-- flow_runs, workspace_*, google_connections, flow_sheet_configs,
-- message_templates, whatsapp_config, travel CRM, or any Flow
-- Tables / All Sheets state.
--
-- What it does (additive, idempotent — safe to run multiple
-- times):
--   * One-time cleanup: delete one-time OAuth states that can
--     never be used again (already consumed, or expired more
--     than 7 days ago). Active (unconsumed, unexpired) states are
--     untouched. Going forward the cron sweep purges these
--     continuously (see purgeExpiredSheetsOAuthStates).
--   * Terminal import jobs (completed/failed/cancelled) are
--     RETAINED — never auto-deleted: they are the audit trail for
--     manual imports and the recovery source for resume/revive.
--     An index on (account_id, created_at) keeps history reads
--     and any future retention window cheap.
--   * An index on oauth_states(expires_at) keeps the ongoing
--     purge scan cheap.
--
-- No production data mutation beyond deleting provably unusable
-- one-time states. Do NOT run destructive cleanup of queue rows
-- or spreadsheet contents from here.
-- ============================================================

-- One-time purge of unusable OAuth states (consumed, or expired
-- more than 7 days ago). Active states are preserved.
DELETE FROM public.meta_lead_sheets_oauth_states
WHERE consumed_at IS NOT NULL
   OR expires_at < now() - interval '7 days';

CREATE INDEX IF NOT EXISTS idx_meta_sheets_oauth_states_expires
  ON public.meta_lead_sheets_oauth_states(expires_at);

-- Retention/audit reads for import-job history (terminal jobs are
-- kept; this index keeps per-account history cheap).
CREATE INDEX IF NOT EXISTS idx_meta_lead_sheets_import_jobs_retention
  ON public.meta_lead_sheets_import_jobs(account_id, created_at DESC);
