-- ============================================================
-- 150_lead_assignment_multi_whatsapp.sql — multiple WhatsApp
-- notification recipients per assignee, each with its own template.
--
-- Model (additive only — no columns dropped, no rows rewritten):
--   lead_assignment_table_assignees.whatsapp_numbers JSONB
--     Array of { phone, template_name, template_language }.
--     Empty array = legacy behavior: the single `phone` column
--     with the config-level template. Existing single-number
--     configurations keep working with zero data movement.
--   lead_assignment_notifications.recipient_key TEXT
--     Normalized recipient phone for WhatsApp rows ('' for email
--     rows). The dedup unique key grows from
--     (account, run, assignee, channel) to (account, run,
--     assignee, channel, recipient_key): one row per recipient
--     number, so retries collapse per recipient, deliveries are
--     tracked separately, and email dedup is unchanged ('' key).
--
-- Enforcement (belt and suspenders):
--   * App validation caps the array, normalizes E.164 numbers,
--     and rejects duplicates within an assignee (see
--     validateTableAssignee in table-validation.ts).
--   * The notify path re-validates name + APPROVED at send time
--     per recipient row, so one bad recipient never blocks the
--     others (see table-notify.ts).
--   * RLS is untouched: the new column rides the existing
--     assignee policies; the new notification column rides the
--     existing outbox policy.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS / DROP + CREATE
-- throughout; safe to run multiple times. LOCAL ONLY: do not
-- apply in production without review.
-- ============================================================

-- ---- per-assignee recipient list -----------------------------
ALTER TABLE public.lead_assignment_table_assignees
  ADD COLUMN IF NOT EXISTS whatsapp_numbers JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---- per-recipient dedup key on the outbox --------------------
ALTER TABLE public.lead_assignment_notifications
  ADD COLUMN IF NOT EXISTS recipient_key TEXT NOT NULL DEFAULT '';

-- One alert per (lead, assignee, channel, recipient): retries and
-- duplicate deliveries collapse to a single row PER NUMBER, while
-- email rows (recipient_key = '') keep exactly the old dedup.
-- (Dropping the constraint also drops its backing index.)
ALTER TABLE public.lead_assignment_notifications
  DROP CONSTRAINT IF EXISTS uq_lead_assignment_notification;
ALTER TABLE public.lead_assignment_notifications
  ADD CONSTRAINT uq_lead_assignment_notification
  UNIQUE (account_id, flow_run_id, assignee_id, channel, recipient_key);
