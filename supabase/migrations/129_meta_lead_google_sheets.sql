-- ============================================================
-- 129_meta_lead_google_sheets.sql — Live Google Sheets sync for
-- Meta Lead Ads ONLY.
--
-- Scope protection: this migration touches ONLY new
-- `meta_lead_sheets_*` tables. It does NOT alter flows,
-- flow_runs, workspace_*, google_connections,
-- flow_sheet_configs, or any Flow Tables / All Sheets state.
--
-- Design:
--   * One Google OAuth connection per account, stored encrypted
--     (AES-256-GCM, same helper as whatsapp_config /
--     google_connections). Separate table so Flow Tables creds
--     can never be used for Meta leads and vice versa.
--   * One sync config per account: the target spreadsheet + tab,
--     auto_sync flag, last success/error. A single worksheet holds
--     ALL enabled forms' leads (Form Name column disambiguates);
--     the stable Meta lead id is the dedup key.
--   * Durable outbox `meta_lead_sheets_queue`: one row per
--     (account, submission) — UNIQUE prevents duplicates from
--     polling/import/retry races. Workers claim rows, write to
--     Sheets, then record the sheet row number for in-place
--     updates. Google failures use bounded exponential backoff
--     and never roll back lead ingestion.
--   * Tenant isolation: every table carries account_id and is
--     guarded by is_account_member(...). Queue writes happen
--     server-side (service role); members get SELECT-only on the
--     queue, admins manage connection/config.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. OAuth one-time states --------------------------
CREATE TABLE IF NOT EXISTS public.meta_lead_sheets_oauth_states (
  state_hash  TEXT PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_sheets_oauth_states_account
  ON public.meta_lead_sheets_oauth_states(account_id);

-- ---------- 2. Google connection (per account) ----------------
CREATE TABLE IF NOT EXISTS public.meta_lead_sheets_connections (
  account_id    UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  google_email  TEXT,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry  TIMESTAMPTZ NOT NULL,
  scope         TEXT,
  connected_by  UUID REFERENCES auth.users(id),
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.meta_lead_sheets_connections.access_token IS
  'AES-256-GCM encrypted Google access token for Meta Lead Ads Sheets sync. Never exposed to the browser.';

-- ---------- 3. Sync config (per account) ----------------------
CREATE TABLE IF NOT EXISTS public.meta_lead_sheets_configs (
  account_id               UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  spreadsheet_id           TEXT NOT NULL,
  spreadsheet_url          TEXT,
  spreadsheet_title        TEXT,
  sheet_tab                TEXT NOT NULL DEFAULT 'Meta Leads',
  auto_sync                BOOLEAN NOT NULL DEFAULT true,
  last_success_at          TIMESTAMPTZ,
  last_error               TEXT,
  historical_import_status TEXT NOT NULL DEFAULT 'idle'
                      CHECK (historical_import_status IN ('idle', 'importing', 'done', 'error')),
  historical_imported_count INT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 4. Durable outbox + row mapping -------------------
CREATE TABLE IF NOT EXISTS public.meta_lead_sheets_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  submission_id    UUID NOT NULL REFERENCES public.meta_lead_submissions(id) ON DELETE CASCADE,
  flow_run_id      UUID REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  meta_lead_id     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts         INT NOT NULL DEFAULT 0,
  max_attempts     INT NOT NULL DEFAULT 8,
  last_error       TEXT,
  next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at       TIMESTAMPTZ,
  sheet_row_number INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_sheets_queue_account_submission_key
    UNIQUE (account_id, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_sheets_queue_due
  ON public.meta_lead_sheets_queue(status, next_retry_at)
  WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_meta_sheets_queue_account
  ON public.meta_lead_sheets_queue(account_id, status);
CREATE INDEX IF NOT EXISTS idx_meta_sheets_queue_lead
  ON public.meta_lead_sheets_queue(account_id, meta_lead_id);

-- ---------- 5. updated_at triggers ----------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_sheets_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_sheets_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_sheets_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_sheets_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_sheets_queue;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_sheets_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 6. RLS --------------------------------------------
ALTER TABLE public.meta_lead_sheets_oauth_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_sheets_oauth_states_admin ON public.meta_lead_sheets_oauth_states;
CREATE POLICY meta_sheets_oauth_states_admin ON public.meta_lead_sheets_oauth_states
  FOR ALL USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_sheets_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_sheets_connections_select ON public.meta_lead_sheets_connections;
CREATE POLICY meta_sheets_connections_select ON public.meta_lead_sheets_connections
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_sheets_connections_admin ON public.meta_lead_sheets_connections;
CREATE POLICY meta_sheets_connections_admin ON public.meta_lead_sheets_connections
  FOR ALL USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_sheets_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_sheets_configs_select ON public.meta_lead_sheets_configs;
CREATE POLICY meta_sheets_configs_select ON public.meta_lead_sheets_configs
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_sheets_configs_admin ON public.meta_lead_sheets_configs;
CREATE POLICY meta_sheets_configs_admin ON public.meta_lead_sheets_configs
  FOR ALL USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_sheets_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_sheets_queue_select ON public.meta_lead_sheets_queue;
CREATE POLICY meta_sheets_queue_select ON public.meta_lead_sheets_queue
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_sheets_queue_admin_insert ON public.meta_lead_sheets_queue;
CREATE POLICY meta_sheets_queue_admin_insert ON public.meta_lead_sheets_queue
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
