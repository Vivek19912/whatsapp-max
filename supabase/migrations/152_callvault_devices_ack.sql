-- ============================================================
-- 152_callvault_devices_ack.sql — phone logout acknowledgement.
--
-- Adds logout_ack_at: set when the phone confirms remote logout
-- via POST /api/auth/callvault-devices/ack. Lets the owner tell
-- "pending" (revoked, phone hasn't confirmed) from "logged out"
-- (phone confirmed) in GET /api/callvault/devices.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS; safe to run multiple
-- times. LOCAL ONLY: do not apply in production without review
-- (do NOT db push).
-- ============================================================

ALTER TABLE public.callvault_devices
  ADD COLUMN IF NOT EXISTS logout_ack_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.callvault_devices.logout_ack_at IS
  'When the phone acknowledged remote logout (ack endpoint); null until confirmed.';
