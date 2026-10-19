-- ============================================================
-- 124_meta_lead_oauth.sql — customer-controlled Meta OAuth.
--
-- Adds the short-lived OAuth handshake/session state used by the
-- per-tenant Facebook Login flow, plus token provenance on the
-- connection row. Nothing here changes the existing lead model or
-- the manual System User connection path.
--
-- Security:
--   * OAuth state and session tables are service-role-only. They are
--     never readable with the anon/authenticated Supabase clients.
--   * Raw OAuth state is never stored; only a SHA-256 hash.
--   * Page tokens are NOT stored in the OAuth session. The session
--     keeps only page metadata until the customer selects Pages.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. Connection token provenance ------------------
ALTER TABLE public.meta_lead_connections
  ADD COLUMN IF NOT EXISTS token_app_id TEXT;
ALTER TABLE public.meta_lead_connections
  ADD COLUMN IF NOT EXISTS token_type TEXT;

COMMENT ON COLUMN public.meta_lead_connections.token_app_id IS
  'Meta app id that issued the stored token. Required for the shared-app webhook path.';
COMMENT ON COLUMN public.meta_lead_connections.token_type IS
  'Meta token type reported by debug_token (e.g. USER, SYSTEM_USER, PAGE).';

-- ---------- 2. OAuth state (CSRF + browser binding) ----------
CREATE TABLE IF NOT EXISTS public.meta_lead_oauth_states (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state_hash        TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_oauth_states_hash_key UNIQUE (state_hash)
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_oauth_states_account
  ON public.meta_lead_oauth_states(account_id, expires_at DESC);

ALTER TABLE public.meta_lead_oauth_states ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (server routes) may use this table.
REVOKE ALL ON TABLE public.meta_lead_oauth_states FROM anon, authenticated;

-- ---------- 3. OAuth session (post-callback, pre-Page selection) ----------
CREATE TABLE IF NOT EXISTS public.meta_lead_oauth_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token      TEXT NOT NULL,
  token_expiry      TIMESTAMPTZ,
  scopes            TEXT,
  meta_user_id      TEXT,
  meta_user_name    TEXT,
  pages             JSONB NOT NULL DEFAULT '[]',
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_oauth_sessions_account
  ON public.meta_lead_oauth_sessions(account_id, expires_at DESC);

COMMENT ON COLUMN public.meta_lead_oauth_sessions.access_token IS
  'AES-256-GCM encrypted user token from the OAuth code exchange. Never returned to the browser.';
COMMENT ON COLUMN public.meta_lead_oauth_sessions.pages IS
  'Page metadata discovered during the callback: [{id,name,tasks}]. Page access tokens are not stored here.';

ALTER TABLE public.meta_lead_oauth_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (server routes) may use this table.
REVOKE ALL ON TABLE public.meta_lead_oauth_sessions FROM anon, authenticated;

-- ---------- 4. Fair polling selector ------------------------
-- Returns one row per account per round (row_number = 1), then round
-- two, etc. This stops a single tenant with a large backlog from
-- consuming every global polling slot. The function is service-role
-- only because the cron uses it across tenants.
CREATE OR REPLACE FUNCTION public.meta_lead_forms_for_poll(p_limit INTEGER DEFAULT 20)
RETURNS SETOF public.meta_lead_forms
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ranked AS (
    SELECT
      f.*,
      row_number() OVER (
        PARTITION BY f.account_id
        ORDER BY f.last_polled_at ASC NULLS FIRST, f.id ASC
      ) AS account_round
    FROM public.meta_lead_forms f
    WHERE f.enabled = true
  )
  SELECT
    id, account_id, page_id, form_id, form_name, status, locale, questions,
    enabled, last_synced_at, last_error, created_at, updated_at,
    import_status, import_cursor, imported_count, last_polled_at, last_lead_at
  FROM ranked
  ORDER BY account_round ASC, last_polled_at ASC NULLS FIRST, id ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;

REVOKE ALL ON FUNCTION public.meta_lead_forms_for_poll(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meta_lead_forms_for_poll(INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.meta_lead_forms_for_poll(INTEGER) IS
  'Service-role-only fair polling selector: accounts are served round-robin by oldest last_polled_at.';
