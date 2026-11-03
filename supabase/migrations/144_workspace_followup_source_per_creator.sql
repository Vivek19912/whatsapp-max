-- ============================================================
-- 144_workspace_followup_source_per_creator.sql — allow one open
-- workspace-linked reminder PER LEAD PER CREATOR.
--
-- 126_workspace_followup_source.sql made the workspace follow-up
-- link unique per lead (account_id, source_kind, source_run_id).
-- That assumed the lead's reminder always belongs to whoever opens
-- the cell next, so a newly assigned salesperson saving a follow-up
-- could run into the previous owner's open reminder (and, before the
-- matching API fix, into the creator-only edit check).
--
-- Reminders are personal: the creator is the WhatsApp recipient, and
-- only the creator (or an admin) may change their reminder. Adding
-- created_by to the uniqueness key lets each salesperson keep their
-- own open reminder for a lead while a previous owner's reminder is
-- left untouched. Admin management keeps its own-first / any-owner
-- behaviour in the API.
--
-- Only open rows (scheduled/processing/failed) participate: once a
-- reminder is sent or cancelled the link is free, so a later
-- follow-up still creates a fresh row and sent/cancelled history is
-- never rewritten. Re-saving the same follow-up by the same creator
-- stays an idempotent in-place update, including concurrent requests.
--
-- Legacy workspace rows with created_by IS NULL remain valid; in
-- Postgres NULLs are distinct in a plain unique index, so they never
-- block a real creator's row. No backfill, no data rewrite, no RLS
-- change.
--
-- Idempotent — safe to run multiple times. REVIEW AND RUN MANUALLY;
-- this migration is intentionally NOT applied by the agent.
-- ============================================================

DROP INDEX IF EXISTS public.uq_whatsapp_followups_source_open;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_followups_source_open_per_creator
  ON public.whatsapp_followups (
    account_id,
    source_kind,
    source_run_id,
    created_by
  )
  WHERE source_kind IS NOT NULL
    AND source_run_id IS NOT NULL
    AND status IN ('scheduled', 'processing', 'failed');

COMMENT ON INDEX public.uq_whatsapp_followups_source_open_per_creator IS
  'One open workspace-linked reminder per lead per creator (account_id, source_kind, source_run_id, created_by); sent/cancelled history is excluded.';
