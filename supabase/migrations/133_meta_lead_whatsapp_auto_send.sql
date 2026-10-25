-- ============================================================
-- 133_meta_lead_whatsapp_auto_send.sql — per-Workspace-table
-- WhatsApp auto-send templates for Meta Lead Ads ONLY.
--
-- Scope protection: this migration touches ONLY new
-- `meta_lead_whatsapp_*` tables. It does NOT alter flows,
-- flow_runs, workspace_*, message_templates, whatsapp_config,
-- or any Flow Tables / All Sheets / Travel CRM state.
--
-- Design (mirrors 131_meta_lead_sheets_per_table.sql):
--   * Each Meta Workspace table is backed by exactly one Meta
--     Instant Form (flows.meta_form_id), so each table gets its
--     own auto-send config keyed by (account, Meta form id):
--     paused flag, delay between consecutive template sends,
--     and an ordered list of approved template items.
--   * `meta_lead_whatsapp_queue` is the durable idempotency
--     ledger: one row per (account, submission, template name,
--     template language). UNIQUE prevents duplicates from
--     polling/webhook retries/concurrent workers/job re-runs.
--     Workers claim rows, send via the WhatsApp Cloud API, and
--     record the provider message id + inbox message id.
--     Failures use bounded exponential backoff and never roll
--     back lead ingestion.
--   * Tenant isolation: every table carries account_id and is
--     guarded by is_account_member(...). Queue writes happen
--     server-side (service role); members get SELECT-only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. Per-table auto-send config ---------------------
-- One row per (account, Meta form). Absent row = feature never
-- configured for this table = send nothing.
CREATE TABLE IF NOT EXISTS public.meta_lead_whatsapp_configs (
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id       TEXT NOT NULL,
  paused        BOOLEAN NOT NULL DEFAULT false,
  delay_seconds INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_whatsapp_configs_account_form_key
    PRIMARY KEY (account_id, form_id),
  CONSTRAINT meta_lead_whatsapp_configs_delay_check
    CHECK (delay_seconds >= 0 AND delay_seconds <= 86400)
);

COMMENT ON TABLE public.meta_lead_whatsapp_configs IS
  'Per-Workspace-table WhatsApp auto-send config for Meta Lead Ads. One row per (account, Meta form id); each Workspace table syncs only its own form. paused=true stops new sends; delay_seconds spaces consecutive template sends (0 = immediate).';

-- ---------- 2. Ordered template items ------------------------
-- Each row is one approved template in a table's send sequence.
-- `position` is the 0-based send order within (account, form).
CREATE TABLE IF NOT EXISTS public.meta_lead_whatsapp_templates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id           TEXT NOT NULL,
  template_name     TEXT NOT NULL,
  template_language TEXT NOT NULL DEFAULT 'en_US',
  position          INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_whatsapp_templates_account_form_name_lang_key
    UNIQUE (account_id, form_id, template_name, template_language),
  CONSTRAINT meta_lead_whatsapp_templates_position_check
    CHECK (position >= 0 AND position < 100)
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_whatsapp_templates_account_form
  ON public.meta_lead_whatsapp_templates(account_id, form_id, position);

COMMENT ON TABLE public.meta_lead_whatsapp_templates IS
  'Ordered approved templates auto-sent for one Meta Lead Ads Workspace table. Deduplicated per (account, form, name, language); position sets the send order.';

-- ---------- 3. Durable idempotency ledger / outbox ------------
-- One row per (account, submission, template name, language).
-- `scheduled_for` enforces the configured order + delay:
-- item N is due at lead-time + N * delay_seconds.
CREATE TABLE IF NOT EXISTS public.meta_lead_whatsapp_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  submission_id       UUID NOT NULL REFERENCES public.meta_lead_submissions(id) ON DELETE CASCADE,
  flow_run_id         UUID REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  form_id             TEXT NOT NULL,
  template_name       TEXT NOT NULL,
  template_language   TEXT NOT NULL DEFAULT 'en_US',
  position            INT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts            INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 8,
  last_error          TEXT,
  next_retry_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_for       TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at          TIMESTAMPTZ,
  provider_message_id TEXT,
  conversation_id     UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  inbox_message_id    UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_whatsapp_queue_account_submission_template_key
    UNIQUE (account_id, submission_id, template_name, template_language)
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_whatsapp_queue_due
  ON public.meta_lead_whatsapp_queue(status, scheduled_for, next_retry_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_meta_lead_whatsapp_queue_account
  ON public.meta_lead_whatsapp_queue(account_id, status);
CREATE INDEX IF NOT EXISTS idx_meta_lead_whatsapp_queue_submission
  ON public.meta_lead_whatsapp_queue(account_id, submission_id);

COMMENT ON TABLE public.meta_lead_whatsapp_queue IS
  'Idempotency ledger for Meta Lead Ads WhatsApp auto-sends. UNIQUE(account, submission, template, language) guarantees a template is never sent twice for the same lead, across polling/webhook retries, concurrent workers, and job re-runs.';

-- ---------- 4. updated_at triggers -----------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_whatsapp_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_whatsapp_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_whatsapp_templates;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_whatsapp_queue;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_whatsapp_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 5. RLS ----------------------------------------------
ALTER TABLE public.meta_lead_whatsapp_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_lead_whatsapp_configs_select ON public.meta_lead_whatsapp_configs;
CREATE POLICY meta_lead_whatsapp_configs_select ON public.meta_lead_whatsapp_configs
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_lead_whatsapp_configs_insert ON public.meta_lead_whatsapp_configs;
CREATE POLICY meta_lead_whatsapp_configs_insert ON public.meta_lead_whatsapp_configs
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_whatsapp_configs_update ON public.meta_lead_whatsapp_configs;
CREATE POLICY meta_lead_whatsapp_configs_update ON public.meta_lead_whatsapp_configs
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_whatsapp_configs_delete ON public.meta_lead_whatsapp_configs;
CREATE POLICY meta_lead_whatsapp_configs_delete ON public.meta_lead_whatsapp_configs
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_whatsapp_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_lead_whatsapp_templates_select ON public.meta_lead_whatsapp_templates;
CREATE POLICY meta_lead_whatsapp_templates_select ON public.meta_lead_whatsapp_templates
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_lead_whatsapp_templates_insert ON public.meta_lead_whatsapp_templates;
CREATE POLICY meta_lead_whatsapp_templates_insert ON public.meta_lead_whatsapp_templates
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_whatsapp_templates_update ON public.meta_lead_whatsapp_templates;
CREATE POLICY meta_lead_whatsapp_templates_update ON public.meta_lead_whatsapp_templates
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_whatsapp_templates_delete ON public.meta_lead_whatsapp_templates;
CREATE POLICY meta_lead_whatsapp_templates_delete ON public.meta_lead_whatsapp_templates
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_whatsapp_queue ENABLE ROW LEVEL SECURITY;
-- Members may READ the queue (send history / statuses); writes are
-- service-role only (ingestion hook + drain worker), so no write policy.
DROP POLICY IF EXISTS meta_lead_whatsapp_queue_select ON public.meta_lead_whatsapp_queue;
CREATE POLICY meta_lead_whatsapp_queue_select ON public.meta_lead_whatsapp_queue
  FOR SELECT USING (is_account_member(account_id));
