-- ============================================================
-- 119_meta_lead_ads.sql — Meta Lead Ads integration.
--
-- Lets an account connect Meta (Facebook/Instagram) Pages, pick
-- their Instant Forms, subscribe to the `leadgen` webhook, and
-- receive submissions in the existing Workspace.
--
-- Design (agreed with the product owner):
--   * Each ENABLED Instant Form is represented in the existing
--     Workspace as a "virtual flow" — a `flows` row with
--     kind = 'meta_lead_ads' plus one synthesized collect_input
--     node per form question. A submission is stored as a normal
--     `flow_runs` row (vars = normalized answers) so the entire
--     Workspace stack (columns, overrides, custom columns,
--     filters, drawer) works unchanged.
--   * `meta_lead_submissions` is the idempotency ledger + Meta
--     metadata (page/form/lead id/source/processing status). It
--     is NOT a second lead-management system: the Workspace row
--     remains the single source of truth for the lead itself.
--
-- Tenant isolation: every table carries account_id and is guarded
-- by is_account_member(...). Writes to submissions happen from the
-- server (service role) — RLS exposes them SELECT-only to members.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. flows.kind + Meta form link ------------------
-- kind distinguishes Workspace "virtual" source flows (Meta
-- Instant Forms) from real WhatsApp conversational flows. Default
-- 'whatsapp_flow' keeps every existing row and query valid.
ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'whatsapp_flow';
ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS meta_form_id UUID;

ALTER TABLE public.flows
  DROP CONSTRAINT IF EXISTS flows_kind_check;
ALTER TABLE public.flows
  ADD CONSTRAINT flows_kind_check
  CHECK (kind IN ('whatsapp_flow', 'meta_lead_ads'));

CREATE INDEX IF NOT EXISTS idx_flows_account_kind
  ON public.flows(account_id, kind);

COMMENT ON COLUMN public.flows.kind IS
  'Source of this Workspace flow: whatsapp_flow (conversational) or meta_lead_ads (virtual flow for a Meta Instant Form).';

-- ---------- 2. meta_lead_connections ------------------------
-- One Meta user authorization per account. Tokens are AES-256-GCM
-- encrypted (same helper as whatsapp_config / google_connections).
CREATE TABLE IF NOT EXISTS public.meta_lead_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  meta_user_id      TEXT,
  meta_user_name    TEXT,
  access_token      TEXT NOT NULL,
  token_expiry      TIMESTAMPTZ,
  scopes            TEXT,
  status            TEXT NOT NULL DEFAULT 'connected'
                      CHECK (status IN ('connected', 'needs_reauth', 'revoked')),
  last_error        TEXT,
  connected_by      UUID REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_connections_account_key UNIQUE (account_id)
);

COMMENT ON COLUMN public.meta_lead_connections.access_token IS
  'AES-256-GCM encrypted long-lived Meta user access token. Never exposed to the browser.';

-- ---------- 3. meta_lead_pages ------------------------------
-- Pages the account selected to integrate. Each carries its own
-- (encrypted) Page access token used for lead retrieval + webhook
-- subscription.
CREATE TABLE IF NOT EXISTS public.meta_lead_pages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id           TEXT NOT NULL,
  page_name         TEXT,
  access_token      TEXT,
  tasks             JSONB,
  subscribed        BOOLEAN NOT NULL DEFAULT false,
  subscribed_at     TIMESTAMPTZ,
  webhook_verified  BOOLEAN NOT NULL DEFAULT false,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_pages_account_page_key UNIQUE (account_id, page_id)
);

COMMENT ON COLUMN public.meta_lead_pages.access_token IS
  'AES-256-GCM encrypted Page access token. Never exposed to the browser.';

-- ---------- 4. meta_lead_forms ------------------------------
-- Discovered Instant Forms per Page. `enabled` forms get a
-- virtual Workspace flow (flows.meta_form_id → here).
CREATE TABLE IF NOT EXISTS public.meta_lead_forms (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id           TEXT NOT NULL,
  form_id           TEXT NOT NULL,
  form_name         TEXT,
  status            TEXT,
  locale            TEXT,
  questions         JSONB NOT NULL DEFAULT '[]',
  enabled           BOOLEAN NOT NULL DEFAULT false,
  last_synced_at    TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_forms_account_form_key UNIQUE (account_id, form_id)
);

-- ---------- 5. webhook subscription back-reference ----------
-- flows → meta_lead_forms link (added after the forms table).
ALTER TABLE public.flows
  DROP CONSTRAINT IF EXISTS flows_meta_form_id_fkey;
ALTER TABLE public.flows
  ADD CONSTRAINT flows_meta_form_id_fkey
  FOREIGN KEY (meta_form_id) REFERENCES public.meta_lead_forms(id) ON DELETE SET NULL;

-- Exactly one virtual flow per form.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flows_meta_form_unique
  ON public.flows(meta_form_id)
  WHERE meta_form_id IS NOT NULL;

-- ---------- 6. meta_lead_submissions ------------------------
-- Idempotency ledger + Meta metadata for one retrieved lead.
-- UNIQUE(account_id, meta_lead_id) makes repeated webhook
-- deliveries a no-op. The lead's DATA lives in the linked
-- flow_runs row; this table stores provenance + processing state.
CREATE TABLE IF NOT EXISTS public.meta_lead_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  meta_lead_id      TEXT NOT NULL,
  page_id           TEXT,
  form_id           TEXT,
  form_name         TEXT,
  source            TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (source IN ('facebook', 'instagram', 'unknown')),
  meta_created_time TIMESTAMPTZ,
  answers           JSONB NOT NULL DEFAULT '{}',
  field_data        JSONB NOT NULL DEFAULT '[]',
  flow_run_id       UUID REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  contact_id        UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  attempts          INT NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_retry_at     TIMESTAMPTZ,
  claimed_at        TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_submissions_account_lead_key
    UNIQUE (account_id, meta_lead_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_submissions_account
  ON public.meta_lead_submissions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_lead_submissions_retry
  ON public.meta_lead_submissions(account_id, next_retry_at)
  WHERE status = 'failed' AND claimed_at IS NULL;

-- ---------- 7. updated_at triggers --------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_pages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_forms;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_forms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_submissions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_submissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 8. RLS ------------------------------------------
ALTER TABLE public.meta_lead_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_lead_connections_select ON public.meta_lead_connections;
CREATE POLICY meta_lead_connections_select ON public.meta_lead_connections
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_lead_connections_insert ON public.meta_lead_connections;
CREATE POLICY meta_lead_connections_insert ON public.meta_lead_connections
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_connections_update ON public.meta_lead_connections;
CREATE POLICY meta_lead_connections_update ON public.meta_lead_connections
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_connections_delete ON public.meta_lead_connections;
CREATE POLICY meta_lead_connections_delete ON public.meta_lead_connections
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_lead_pages_select ON public.meta_lead_pages;
CREATE POLICY meta_lead_pages_select ON public.meta_lead_pages
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_lead_pages_insert ON public.meta_lead_pages;
CREATE POLICY meta_lead_pages_insert ON public.meta_lead_pages
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_pages_update ON public.meta_lead_pages;
CREATE POLICY meta_lead_pages_update ON public.meta_lead_pages
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_pages_delete ON public.meta_lead_pages;
CREATE POLICY meta_lead_pages_delete ON public.meta_lead_pages
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_forms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_lead_forms_select ON public.meta_lead_forms;
CREATE POLICY meta_lead_forms_select ON public.meta_lead_forms
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_lead_forms_insert ON public.meta_lead_forms;
CREATE POLICY meta_lead_forms_insert ON public.meta_lead_forms
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_forms_update ON public.meta_lead_forms;
CREATE POLICY meta_lead_forms_update ON public.meta_lead_forms
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_forms_delete ON public.meta_lead_forms;
CREATE POLICY meta_lead_forms_delete ON public.meta_lead_forms
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_submissions ENABLE ROW LEVEL SECURITY;
-- Members may READ submissions (Workspace provenance); writes are
-- service-role only (webhook + retry worker), so no write policy.
DROP POLICY IF EXISTS meta_lead_submissions_select ON public.meta_lead_submissions;
CREATE POLICY meta_lead_submissions_select ON public.meta_lead_submissions
  FOR SELECT USING (is_account_member(account_id));
