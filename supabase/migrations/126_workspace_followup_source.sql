-- ============================================================
-- 126_workspace_followup_source.sql — link workspace follow-up
-- reminders to their lead row.
--
-- Workspace Meta Lead Ads Tables let agents set a
-- "Next Follow-up Date & Time" per lead and schedule exactly one
-- linked reminder in the existing whatsapp_followups system (same
-- table, same lifecycle, same scheduler/delivery — no second
-- mechanism). These two nullable columns carry the association:
--
--   source_kind   — linkage discriminator. Workspace-linked rows
--                   store 'meta_workspace_followup'; every other
--                   row (manual reminders, legacy rows) stays NULL
--                   and is never matched by the link queries.
--   source_run_id — the flow_runs.id (lead row) the reminder was
--                   created from. Plain UUID, no FK: the API
--                   verifies the run (account + flow) at request
--                   time, and lead deletion must not implicitly
--                   rewrite reminder rows.
--
-- The partial unique index makes re-saving the same follow-up an
-- idempotent in-place update (no duplicates), including under
-- concurrent requests — the second inserter hits the unique
-- violation and the API falls back to updating the existing open
-- row. Only open rows (scheduled/processing/failed) participate:
-- once a reminder is sent or cancelled the link is free, so a
-- later follow-up creates a fresh reminder and sent/cancelled
-- history is never rewritten.
--
-- Idempotent — safe to run multiple times. Backward compatible:
-- nullable columns, no backfill, no RLS change (existing table
-- policies already scope agent+ writes by account_id).
-- ============================================================

ALTER TABLE public.whatsapp_followups
  ADD COLUMN IF NOT EXISTS source_kind TEXT,
  ADD COLUMN IF NOT EXISTS source_run_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_followups_source_open
  ON public.whatsapp_followups (account_id, source_kind, source_run_id)
  WHERE source_kind IS NOT NULL
    AND source_run_id IS NOT NULL
    AND status IN ('scheduled', 'processing', 'failed');

COMMENT ON COLUMN public.whatsapp_followups.source_kind IS
  'Linkage discriminator for workspace-created reminders (meta_workspace_followup). NULL = manual/legacy row, never auto-managed.';
COMMENT ON COLUMN public.whatsapp_followups.source_run_id IS
  'flow_runs.id the reminder was created from. Verified per request; no FK so lead lifecycle never rewrites reminders.';
