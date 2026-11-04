-- ============================================================
-- 151_callvault_devices.sql — per-device CallVault sessions with
-- owner-driven remote logout.
--
-- Model:
--   callvault_devices — one row per (account, device). The phone
--     registers on login (POST /api/auth/callvault-devices/register)
--     with its device_id + the GoTrue session_id of the login.
--     A row is "revoked" when revoked_session_id equals its
--     session_id: the owner logged that session out remotely.
--     A fresh login (new session_id) heals the row.
--   callvault_device_audit — append-only log of revoke / revoke-all
--     actions (who logged out whom, when).
--
-- Enforcement (belt and suspenders):
--   1. HTTP gate: requireDeviceUser denies any bearer whose
--      session_id equals a row's revoked_session_id, even without
--      a device header (bypass-proof).
--   2. Sidecar: the dial-ws phone handshake closes 4403 for a
--      revoked (user, device) pair before registering the socket.
--   3. Status polling: the phone polls
--      GET /api/auth/callvault-devices/status for its own row.
--
-- RLS: enabled with NO policies (service_role only). All reads
-- and writes go through the service-role client; service_role
-- bypasses RLS anyway. No update/delete surface: the audit table
-- is append-only by convention (service path only).
--
-- 60-day rule: additive tables only. No auth-config changes, no
-- signIn/refresh flows, no global signOut — revocation never
-- touches GoTrue sessions, it only gates our own API + sidecar.
--
-- Idempotent — CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS throughout; safe to run multiple times. LOCAL ONLY: do
-- not apply in production without review (do NOT db push).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.callvault_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id UUID NULL,
  revoked_session_id UUID NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_by UUID NULL,
  device_name TEXT NULL,
  device_model TEXT NULL,
  app_version TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NULL,
  CONSTRAINT callvault_devices_account_device_unique
    UNIQUE (account_id, device_id)
);

CREATE INDEX IF NOT EXISTS callvault_devices_account_user_idx
  ON public.callvault_devices (account_id, user_id);

CREATE INDEX IF NOT EXISTS callvault_devices_session_idx
  ON public.callvault_devices (session_id);

ALTER TABLE public.callvault_devices ENABLE ROW LEVEL SECURITY;

-- Intentionally NO policies: service_role only. RLS enabled so
-- no other role can read or write these rows through PostgREST.

CREATE TABLE IF NOT EXISTS public.callvault_device_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NULL,
  revoked_session_id UUID NULL,
  action TEXT NOT NULL
    CHECK (action IN ('revoke_device', 'revoke_all')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.callvault_device_audit ENABLE ROW LEVEL SECURITY;

-- Intentionally NO policies (service_role only) and no
-- update/delete surface: append-only by convention.
