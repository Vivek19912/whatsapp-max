-- ============================================================
-- 158_profiles_reminder_fallback_template.sql — per-agent reminder
-- fallback template (personal configuration isolation)
--
-- The account-level fallback (`accounts.reminder_template_name/_language`,
-- migration 099) stays the Owner/Admin default and the scheduler
-- fallback. Agents get their OWN columns on `profiles` so one
-- agent's selection can never overwrite another's:
--   profiles.reminder_template_name / reminder_template_language
--
-- Resolution order for an agent's reminder send:
--   1. the creator's own profiles.* (when set)
--   2. the accounts.* default (back-compat with previously saved config)
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS reminder_template_name TEXT,
  ADD COLUMN IF NOT EXISTS reminder_template_language TEXT;

-- No RLS change: the existing `profiles_select` (self + account
-- members) and `profiles_update` (own row only, migration 017)
-- policies already isolate personal settings — an agent can read
-- the roster but only ever write their own row, so Agent A's
-- template can never overwrite Agent B's.
