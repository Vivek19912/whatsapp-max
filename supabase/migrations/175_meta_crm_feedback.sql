-- ============================================================
-- 175_meta_crm_feedback.sql — Meta Instant Form → WhatsApp Max CRM →
-- Meta Conversions API lead-quality feedback.
--
-- Independent CRM-feedback layer. Does NOT touch the retired
-- `meta_capi_*` tables, lead capture (`meta_lead_*`), Workspace
-- values, or Sheets/WhatsApp queues.
--
--   meta_crm_config — one row per account: CRM feedback on/off +
--     the selected Meta CRM dataset (FK to meta_crm_datasets).
--     Tokens are NEVER stored here; sends reuse the account's
--     existing encrypted Meta connection token server-side.
--   meta_crm_events — durable per-transition event ledger +
--     retries. UNIQUE(account, run, event, from, to) makes the
--     same transition idempotent; CAPI `event_id` reuses the
--     row UUID so retries preserve event identity.
--
-- Tenant isolation: account_id + is_account_member(...). Reads are
-- member-scoped; writes are admin-gated (all runtime writes go
-- through the service role after server-side authZ, mirroring the
-- Sheets queue pattern). The browser never supplies account_id.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. config -----------------------------------------
CREATE TABLE IF NOT EXISTS public.meta_crm_config (
  account_id            UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  dataset_ref           UUID REFERENCES public.meta_crm_datasets(id) ON DELETE SET NULL,
  dataset_id            TEXT,
  business_portfolio_id TEXT,
  dataset_name          TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT false,
  verified_at           TIMESTAMPTZ,
  last_error            TEXT,
  last_event_at         TIMESTAMPTZ,
  updated_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.meta_crm_config IS
  'Per-account Meta CRM feedback configuration (Settings → Meta → CRM Integration). Points at one meta_crm_datasets row; tokens are never stored here.';
COMMENT ON COLUMN public.meta_crm_config.enabled IS
  'CRM feedback on/off. Events are only enqueued and sent while true with a dataset configured.';

-- ---------- 2. events ledger -----------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meta_crm_event_status') THEN
    CREATE TYPE meta_crm_event_status AS ENUM (
      'pending',
      'sent',
      'failed',
      'skipped'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.meta_crm_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  flow_id               UUID REFERENCES public.flows(id) ON DELETE SET NULL,
  flow_run_id           UUID REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  submission_id         UUID REFERENCES public.meta_lead_submissions(id) ON DELETE SET NULL,
  meta_lead_id          TEXT NOT NULL,
  event_name            TEXT NOT NULL
                          CHECK (event_name IN (
                            'Lead',
                            'InterestedLead',
                            'QualifiedLead',
                            'BookingConfirmed',
                            'DisqualifiedLead'
                          )),
  from_quality          TEXT NOT NULL DEFAULT '',
  to_quality            TEXT NOT NULL DEFAULT '',
  event_time            TIMESTAMPTZ NOT NULL,
  event_uuid            UUID NOT NULL DEFAULT gen_random_uuid(),
  dataset_id            TEXT NOT NULL,
  status                meta_crm_event_status NOT NULL DEFAULT 'pending',
  attempts              INT NOT NULL DEFAULT 0,
  max_attempts          INT NOT NULL DEFAULT 8,
  last_error            TEXT,
  meta_response         JSONB,
  next_retry_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at               TIMESTAMPTZ,
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_crm_events_transition_key
    UNIQUE (account_id, flow_run_id, event_name, from_quality, to_quality)
);

COMMENT ON TABLE public.meta_crm_events IS
  'Durable Meta CRM feedback event ledger. One row per genuine quality transition; retries reuse event_uuid as the Meta event_id so Meta never sees duplicates.';
COMMENT ON COLUMN public.meta_crm_events.meta_lead_id IS
  'Original Meta Lead ID (leadgen_id) from meta_lead_submissions. Never generated or substituted.';

CREATE INDEX IF NOT EXISTS idx_meta_crm_events_drain
  ON public.meta_crm_events (account_id, status, next_retry_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_meta_crm_events_account
  ON public.meta_crm_events (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_crm_events_run
  ON public.meta_crm_events (flow_run_id);

-- Lookup used by the Lead Quality save path: run -> submission.
CREATE INDEX IF NOT EXISTS idx_meta_lead_submissions_flow_run
  ON public.meta_lead_submissions (flow_run_id)
  WHERE flow_run_id IS NOT NULL;

-- ---------- 3. updated_at triggers -----------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_crm_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_crm_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_crm_events;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_crm_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 4. RLS ----------------------------------------------
ALTER TABLE public.meta_crm_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_crm_config_select ON public.meta_crm_config;
CREATE POLICY meta_crm_config_select ON public.meta_crm_config
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_crm_config_insert ON public.meta_crm_config;
CREATE POLICY meta_crm_config_insert ON public.meta_crm_config
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_crm_config_update ON public.meta_crm_config;
CREATE POLICY meta_crm_config_update ON public.meta_crm_config
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_crm_config_delete ON public.meta_crm_config;
CREATE POLICY meta_crm_config_delete ON public.meta_crm_config
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_crm_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_crm_events_select ON public.meta_crm_events;
CREATE POLICY meta_crm_events_select ON public.meta_crm_events
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_crm_events_insert ON public.meta_crm_events;
CREATE POLICY meta_crm_events_insert ON public.meta_crm_events
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_crm_events_update ON public.meta_crm_events;
CREATE POLICY meta_crm_events_update ON public.meta_crm_events
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_crm_events_delete ON public.meta_crm_events;
CREATE POLICY meta_crm_events_delete ON public.meta_crm_events
  FOR DELETE USING (is_account_member(account_id, 'admin'));
