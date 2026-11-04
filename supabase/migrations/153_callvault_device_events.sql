-- ============================================================
-- 153_callvault_device_events.sql — disconnect/reconnect log
-- for CallVault presence monitoring.
--
-- Model:
--   callvault_device_events — one row per disconnect episode of
--     a (account, device) pair. The presence cron
--     (GET /api/callvault/presence-cron) inserts a row when a
--     non-revoked, non-expired device goes stale (no heartbeat /
--     last_seen for DISCONNECT_TIMEOUT_S, mirrored in
--     src/lib/callvault/presence.ts). The row stays OPEN
--     (reconnected_at IS NULL) until the device is seen again
--     (sidecar handshake / heartbeat resolves it), so the owner
--     sees "disconnected since" and a live duration.
--   reason is 'disconnect' for a stale-device alert and
--     'session_expired' for a silent close of a row whose
--     session aged past 60 days (no banner, history only).
--
-- Concurrency: the partial unique index
--   (account_id, device_id) WHERE reconnected_at IS NULL
-- keeps exactly one open event per device, so concurrent cron
-- runs / workers dedupe via INSERT ... 23505-ignore instead of
-- app locks. The monitor NEVER revokes, NEVER touches tokens
-- or GoTrue sessions — 60-day handling is display/close only.
--
-- RLS: enabled with NO policies (service_role only), same as
-- migration 151. All reads/writes go through the service-role
-- client; service_role bypasses RLS anyway.
--
-- Idempotent — CREATE TABLE / INDEX IF NOT EXISTS; safe to run
-- multiple times. LOCAL ONLY: do not apply in production
-- without review (do NOT db push).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.callvault_device_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id UUID NULL,
  last_seen_at TIMESTAMPTZ NULL,
  disconnected_at TIMESTAMPTZ NOT NULL,
  reconnected_at TIMESTAMPTZ NULL,
  reason TEXT NOT NULL DEFAULT 'disconnect'
    CHECK (reason IN ('disconnect', 'session_expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one OPEN event per device: concurrent cron sweeps
-- dedupe on this index (duplicate INSERT raises 23505, which
-- the sweeper ignores) instead of taking app-level locks.
CREATE UNIQUE INDEX IF NOT EXISTS callvault_device_events_open_unique
  ON public.callvault_device_events (account_id, device_id)
  WHERE reconnected_at IS NULL;

CREATE INDEX IF NOT EXISTS callvault_device_events_account_user_idx
  ON public.callvault_device_events (account_id, user_id);

CREATE INDEX IF NOT EXISTS callvault_device_events_disconnected_idx
  ON public.callvault_device_events (disconnected_at);

ALTER TABLE public.callvault_device_events ENABLE ROW LEVEL SECURITY;

-- Intentionally NO policies: service_role only. RLS enabled so
-- no other role can read or write these rows through PostgREST.
