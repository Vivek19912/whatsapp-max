-- ============================================================
-- 160_user_recording_phone_enabled.sql — explicit owner opt-in
-- for phone call recording.
--
-- Adds `phone_recording_enabled` to `user_recording_settings`:
-- the Owner's explicit Enabled/Disabled choice for phone call
-- recording, stored as its own boolean rather than inferred from
-- whether a number happens to be present. This makes the owner's
-- intent authoritative and lets CallVault distinguish "disabled"
-- (explicit off) from "never configured" (absent row).
--
-- Backfill preserves the effective behaviour that exists today:
-- rows that already carry an assigned number keep recording
-- enabled; rows without one (or new rows) default to disabled.
-- No row is ever granted recording it did not already have.
--
-- No RLS change: the 112 policies already gate reads to members
-- and writes to owners, and they apply to the whole row.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE user_recording_settings
  ADD COLUMN IF NOT EXISTS phone_recording_enabled boolean NOT NULL DEFAULT false;

-- Backfill from the stored numbers so existing explicit
-- assignments keep working exactly as before this column existed.
UPDATE user_recording_settings
SET phone_recording_enabled = true
WHERE phone_recording_number IS NOT NULL
  AND phone_recording_number <> ''
  AND phone_recording_enabled = false;
