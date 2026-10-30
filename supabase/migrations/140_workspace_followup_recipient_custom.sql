-- Workspace per-reminder recipient override flag (additive only).
--
-- whatsapp_followups.recipient_phone already stores the destination
-- number per reminder. By default it is a snapshot of the creator's
-- Settings number, and the scheduler auto-refreshes it when the
-- creator changes their number ("refreshStaleRecipient").
--
-- When a salesperson explicitly overrides the destination inside the
-- Workspace Schedule Follow-up dialog, recipient_custom is set to
-- true so the scheduler NEVER re-points that row: the explicit
-- choice wins over later Settings changes, retries keep using it,
-- and historical rows are untouched.
--
-- Defaults to false, so every existing row keeps the exact legacy
-- refresh behavior. No backfill, no data rewrite, no RLS change
-- (same table, same policies), no new indexes (the flag is only
-- ever read on rows already claimed by id).
--
-- NOT APPLIED: pending migration, kept out of the database until
-- explicitly applied during a deployment.

ALTER TABLE public.whatsapp_followups
  ADD COLUMN IF NOT EXISTS recipient_custom BOOLEAN NOT NULL DEFAULT false;
