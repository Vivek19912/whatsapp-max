-- ============================================================
-- 121_meta_capi.sql — Meta Conversions API (CAPI) per-tenant config.
--
-- Separate from the Direct Meta Lead Capture tables (119/120). This
-- holds each customer's OWN Conversions API assets so they can be
-- configured from Settings without touching env vars:
--
--   meta_capi_config      — dataset/pixel id + encrypted system-user
--                           token + setup-wizard progress (one row/account)
--   meta_capi_event_mappings — configurable "when X happens send event Y"
--   meta_capi_deliveries  — durable, idempotent delivery ledger + retries
--
-- Tenant isolation: every table carries account_id and is guarded by
-- is_account_member(...). Config/mappings are readable by any member
-- and writable by admins; deliveries are SELECT-only to members
-- (writes happen server-side with the service role).
--
-- Credentials are NEVER stored in plaintext: access_token is
-- AES-256-GCM encrypted by the app (same helper as whatsapp_config).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. meta_capi_config -----------------------------
CREATE TABLE IF NOT EXISTS public.meta_capi_config (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  dataset_id        TEXT,
  access_token      TEXT,
  status            TEXT NOT NULL DEFAULT 'incomplete'
                      CHECK (status IN ('incomplete', 'connected', 'error')),
  test_event_code   TEXT,
  action_source     TEXT NOT NULL DEFAULT 'business_messaging',
  setup_step        INTEGER NOT NULL DEFAULT 1,
  last_error        TEXT,
  last_verified_at  TIMESTAMPTZ,
  token_updated_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_capi_config_account_key UNIQUE (account_id)
);

COMMENT ON COLUMN public.meta_capi_config.access_token IS
  'AES-256-GCM encrypted Meta Conversions API (system user) access token. Never exposed to the browser.';
COMMENT ON COLUMN public.meta_capi_config.dataset_id IS
  'The customer''s Meta Dataset / Pixel id that events are sent to.';

-- ---------- 2. meta_capi_event_mappings ---------------------
-- Each mapping = "when <source_action> (matching source_field/value)
-- occurs for this account, send <meta_event_name>". `enabled` gates
-- it; `requires_value` + `event_value`/`currency` gate Purchase.
CREATE TABLE IF NOT EXISTS public.meta_capi_event_mappings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  source_action     TEXT NOT NULL
                      CHECK (source_action IN (
                        'meta_lead_received',
                        'flow_completed',
                        'workspace_field_changed'
                      )),
  source_field      TEXT,
  source_value      TEXT,
  meta_event_name   TEXT NOT NULL,
  action_source     TEXT NOT NULL DEFAULT 'business_messaging',
  requires_value    BOOLEAN NOT NULL DEFAULT false,
  event_value       NUMERIC,
  currency          TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_capi_event_mappings_account_name_key UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_meta_capi_mappings_account_action
  ON public.meta_capi_event_mappings(account_id, source_action)
  WHERE enabled;

-- ---------- 3. meta_capi_deliveries -------------------------
-- Durable idempotency + retry ledger. UNIQUE(account_id, event_id)
-- makes a logical conversion fire at most once; retries reuse the
-- same event_id. `is_test` distinguishes Events Manager test events
-- from real production deliveries.
CREATE TABLE IF NOT EXISTS public.meta_capi_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  mapping_id        UUID REFERENCES public.meta_capi_event_mappings(id) ON DELETE SET NULL,
  flow_run_id       UUID REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  contact_id        UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  source_action     TEXT NOT NULL,
  source_value      TEXT,
  event_name        TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  action_source     TEXT NOT NULL,
  is_test           BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  request_payload   JSONB,
  response_payload  JSONB,
  next_retry_at     TIMESTAMPTZ,
  claimed_at        TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_capi_deliveries_account_event_key
    UNIQUE (account_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_capi_deliveries_account
  ON public.meta_capi_deliveries(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_capi_deliveries_retry
  ON public.meta_capi_deliveries(account_id, next_retry_at)
  WHERE status = 'failed' AND claimed_at IS NULL;

-- ---------- 4. updated_at triggers --------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_capi_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_capi_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_capi_event_mappings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_capi_event_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_capi_deliveries;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_capi_deliveries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 5. RLS ------------------------------------------
ALTER TABLE public.meta_capi_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_capi_config_select ON public.meta_capi_config;
CREATE POLICY meta_capi_config_select ON public.meta_capi_config
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_capi_config_insert ON public.meta_capi_config;
CREATE POLICY meta_capi_config_insert ON public.meta_capi_config
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_capi_config_update ON public.meta_capi_config;
CREATE POLICY meta_capi_config_update ON public.meta_capi_config
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_capi_config_delete ON public.meta_capi_config;
CREATE POLICY meta_capi_config_delete ON public.meta_capi_config
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_capi_event_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_capi_event_mappings_select ON public.meta_capi_event_mappings;
CREATE POLICY meta_capi_event_mappings_select ON public.meta_capi_event_mappings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_capi_event_mappings_insert ON public.meta_capi_event_mappings;
CREATE POLICY meta_capi_event_mappings_insert ON public.meta_capi_event_mappings
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_capi_event_mappings_update ON public.meta_capi_event_mappings;
CREATE POLICY meta_capi_event_mappings_update ON public.meta_capi_event_mappings
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_capi_event_mappings_delete ON public.meta_capi_event_mappings;
CREATE POLICY meta_capi_event_mappings_delete ON public.meta_capi_event_mappings
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_capi_deliveries ENABLE ROW LEVEL SECURITY;
-- Members may READ the delivery log; writes are service-role only.
DROP POLICY IF EXISTS meta_capi_deliveries_select ON public.meta_capi_deliveries;
CREATE POLICY meta_capi_deliveries_select ON public.meta_capi_deliveries
  FOR SELECT USING (is_account_member(account_id));
