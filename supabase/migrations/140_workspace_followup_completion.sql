-- Workspace follow-up manual completion (additive only).
--
-- WhatsApp delivery status (scheduled/processing/sent/failed/cancelled)
-- describes the REMINDER. Manual completion describes the actual SALES
-- WORK (the salesperson contacted the customer). The two concepts stay
-- separate columns on the same per-instance row:
--
--   * followup_completed_at / followup_completed_by record the manual
--     Complete action. NULL = pending.
--   * Completing a row with a still-scheduled reminder cancels that
--     reminder (status -> cancelled) via the normal guarded update;
--     sent/failed history is never rewritten.
--   * Reopening clears ONLY these two columns; it never recreates a
--     reminder (a new schedule goes through the existing dialog).
--   * Historic sent rows are NOT backfilled: NULL means pending, and
--     no migration marks old reminders completed.
--
-- RLS: unchanged (existing whatsapp_followups policies cover the row;
-- no new table, no policy change). Tenant scoping stays account_id.

ALTER TABLE public.whatsapp_followups
  ADD COLUMN IF NOT EXISTS followup_completed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS followup_completed_by UUID NULL;

-- Follow-ups view: pending vs completed per table-scoped link, newest
-- completions first. Partial index keeps the hot actionable query
-- (pending workspace links) small.
CREATE INDEX IF NOT EXISTS idx_whatsapp_followups_pending_source
  ON public.whatsapp_followups (account_id, source_kind, scheduled_for ASC)
  WHERE source_kind IS NOT NULL AND followup_completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_followups_completed
  ON public.whatsapp_followups (account_id, source_kind, followup_completed_at DESC)
  WHERE followup_completed_at IS NOT NULL;
