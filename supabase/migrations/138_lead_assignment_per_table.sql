-- ============================================================
-- 138_lead_assignment_per_table.sql — per-table assignment for
-- Meta Lead Ads tables AND Flow tables.
--
-- The legacy global rule engine (migration 127 tables:
-- lead_assignment_rules / rule_tables / rule_members /
-- table_state, events) is PRESERVED untouched: existing rules
-- keep working, no rows are deleted or migrated automatically.
-- The new per-table engine checks a table's own config first and
-- falls back to the legacy rules only for Meta tables without
-- one (Flow tables have no legacy rules, so nothing changes for
-- them until a per-table config is saved).
--
-- New model (all tables carry account_id for tenant isolation):
--   lead_assignment_table_configs    one row per (account, flow):
--                                    enabled, mode (round_robin |
--                                    percentage), IANA timezone for
--                                    pause math, optional WhatsApp
--                                    template for assignee alerts.
--   lead_assignment_table_assignees  internal members (user_id)
--                                    AND/OR custom contacts
--                                    (display_name + email and/or
--                                    phone). Active flag, pause
--                                    window (paused_until +
--                                    reason + table|account
--                                    scope), per-channel notify
--                                    toggles, position + weight.
--   lead_assignment_table_config_state per-config algorithm state
--                                    (RR cursor + SWRR weights +
--                                    CAS version). Never shared
--                                    across tables. Named distinctly
--                                    from the legacy migration-127
--                                    lead_assignment_table_state
--                                    table (keyed by rule_id +
--                                    form_id), which is preserved
--                                    untouched for the legacy
--                                    global-rule engine.
--   lead_assignment_notifications    durable outbox for assignee
--                                    alerts the legacy Meta-only
--                                    queue cannot carry (external
--                                    emails, WhatsApp, Flow-table
--                                    leads without a submission
--                                    row). Drained by the existing
--                                    meta-lead-ads cron sweep.
--   lead_assignment_events           gains two nullable FKs
--                                    (table_config_id,
--                                    table_assignee_id) plus a
--                                    meta JSONB envelope — audit
--                                    for both engines.
--
-- Lead ownership itself still reuses the "Assigned To"
-- workspace_values cell (member user_id only). External
-- recipients are NEVER written as owners: they receive
-- notifications, and the lead stays Unassigned.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- per-table configs --------------------------------------
CREATE TABLE IF NOT EXISTS public.lead_assignment_table_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'round_robin'
    CHECK (mode IN ('round_robin', 'percentage')),
  -- IANA timezone used for pause math ("pause for today" ends at
  -- local midnight in this zone) and status display. UTC default;
  -- editable per table. No app-wide zone exists, so the zone is
  -- stored explicitly instead of guessed from the server clock.
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- Optional approved WhatsApp template for assignee alerts
  -- (name + language). Send is skipped until both are set AND the
  -- template is APPROVED at send time.
  whatsapp_template_name TEXT,
  whatsapp_template_language TEXT NOT NULL DEFAULT 'en_US',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_lead_assignment_table_config UNIQUE (account_id, flow_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_assignment_table_configs_account
  ON public.lead_assignment_table_configs (account_id);

-- ---- assignees (internal members and/or custom contacts) ----
CREATE TABLE IF NOT EXISTS public.lead_assignment_table_assignees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES public.lead_assignment_table_configs(id) ON DELETE CASCADE,
  -- Internal team member (profiles.user_id). NULL = external-only
  -- recipient (notifications only, never an owner).
  user_id UUID,
  display_name TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  email TEXT,
  phone TEXT,
  position INT NOT NULL DEFAULT 0 CHECK (position >= 0),
  weight INT NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- Temporary exclusion window. NULL = not paused; expiry is
  -- evaluated at assignment time (no cron needed) and displayed
  -- in the config's timezone.
  paused_until TIMESTAMPTZ,
  pause_reason TEXT,
  pause_scope TEXT NOT NULL DEFAULT 'table' CHECK (pause_scope IN ('table', 'account')),
  notify_email BOOLEAN NOT NULL DEFAULT true,
  notify_whatsapp BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An internal member must carry contact details; an external
  -- recipient must carry at least one contact channel.
  CONSTRAINT chk_lead_assignment_assignee_contact CHECK (
    user_id IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL
  )
);

-- One row per internal member per table config.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_assignment_assignee_member
  ON public.lead_assignment_table_assignees (config_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lead_assignment_assignees_config
  ON public.lead_assignment_table_assignees (config_id, position);

-- ---- per-config algorithm state ------------------------------
-- NOTE: this deliberately does NOT reuse the migration-127
-- lead_assignment_table_state table (id PK, rule_id + form_id
-- unique, no config_id column). That legacy table belongs to the
-- global-rule engine; CREATE TABLE IF NOT EXISTS would silently
-- keep the legacy shape and every config_id reference below
-- would fail with 42703. The per-table engine gets its own table.
CREATE TABLE IF NOT EXISTS public.lead_assignment_table_config_state (
  config_id UUID PRIMARY KEY REFERENCES public.lead_assignment_table_configs(id) ON DELETE CASCADE,
  rr_cursor BIGINT NOT NULL DEFAULT 0,
  current_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- assignee notification outbox -----------------------------
CREATE TABLE IF NOT EXISTS public.lead_assignment_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  config_id UUID REFERENCES public.lead_assignment_table_configs(id) ON DELETE SET NULL,
  assignee_id UUID REFERENCES public.lead_assignment_table_assignees(id) ON DELETE SET NULL,
  flow_id UUID,
  flow_run_id UUID REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  form_id UUID,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  to_email TEXT,
  to_phone TEXT,
  subject TEXT,
  body TEXT,
  lead_name TEXT,
  lead_phone TEXT,
  template_name TEXT,
  template_language TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ,
  sent_message_id TEXT,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One alert per (lead, assignee, channel): retries and duplicate
  -- deliveries collapse to a single row.
  CONSTRAINT uq_lead_assignment_notification UNIQUE (account_id, flow_run_id, assignee_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_lead_assignment_notifications_due
  ON public.lead_assignment_notifications (next_attempt_at)
  WHERE status IN ('queued', 'failed');

CREATE INDEX IF NOT EXISTS idx_lead_assignment_notifications_sending
  ON public.lead_assignment_notifications (updated_at)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS idx_lead_assignment_notifications_account
  ON public.lead_assignment_notifications (account_id, created_at DESC);

-- ---- audit trail columns ---------------------------------------
ALTER TABLE public.lead_assignment_events
  ADD COLUMN IF NOT EXISTS table_config_id UUID REFERENCES public.lead_assignment_table_configs(id) ON DELETE SET NULL;
ALTER TABLE public.lead_assignment_events
  ADD COLUMN IF NOT EXISTS table_assignee_id UUID REFERENCES public.lead_assignment_table_assignees(id) ON DELETE SET NULL;
ALTER TABLE public.lead_assignment_events
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_lead_assignment_events_config
  ON public.lead_assignment_events (table_config_id, created_at DESC);

-- ---- updated_at triggers ---------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.lead_assignment_table_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.lead_assignment_table_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.lead_assignment_table_assignees;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.lead_assignment_table_assignees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.lead_assignment_table_config_state;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.lead_assignment_table_config_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.lead_assignment_notifications;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.lead_assignment_notifications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- RLS ---------------------------------------------------------
-- Configs: members read their account's rows; owner/admin manage.
ALTER TABLE public.lead_assignment_table_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can read own account table assignment configs" ON public.lead_assignment_table_configs;
CREATE POLICY "Members can read own account table assignment configs"
  ON public.lead_assignment_table_configs FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "Admins can manage own account table assignment configs" ON public.lead_assignment_table_configs;
CREATE POLICY "Admins can manage own account table assignment configs"
  ON public.lead_assignment_table_configs FOR ALL
  USING (account_id IN (
    SELECT account_id FROM public.profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ))
  WITH CHECK (account_id IN (
    SELECT account_id FROM public.profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));

-- Assignees carry private contact details: reads AND writes are
-- owner/admin only. Members never see emails/phones here (the
-- Workspace Assigned To dropdown keeps using the profiles
-- roster, which is unchanged).
ALTER TABLE public.lead_assignment_table_assignees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage own account table assignees" ON public.lead_assignment_table_assignees;
CREATE POLICY "Admins can manage own account table assignees"
  ON public.lead_assignment_table_assignees FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.lead_assignment_table_configs c
    WHERE c.id = lead_assignment_table_assignees.config_id
      AND c.account_id IN (
        SELECT account_id FROM public.profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.lead_assignment_table_configs c
    WHERE c.id = lead_assignment_table_assignees.config_id
      AND c.account_id IN (
        SELECT account_id FROM public.profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ));

-- Algorithm state is written by the service role during
-- assignment; owner/admin may read via the API (service role
-- bypasses RLS). No direct client writes.
ALTER TABLE public.lead_assignment_table_config_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can read own account table assignment state" ON public.lead_assignment_table_config_state;
CREATE POLICY "Admins can read own account table assignment state"
  ON public.lead_assignment_table_config_state FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.lead_assignment_table_configs c
    WHERE c.id = lead_assignment_table_config_state.config_id
      AND c.account_id IN (
        SELECT account_id FROM public.profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ));

-- Notification outbox: owner/admin manage; service role drains.
ALTER TABLE public.lead_assignment_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage own account assignment notifications" ON public.lead_assignment_notifications;
CREATE POLICY "Admins can manage own account assignment notifications"
  ON public.lead_assignment_notifications FOR ALL
  USING (account_id IN (
    SELECT account_id FROM public.profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ))
  WITH CHECK (account_id IN (
    SELECT account_id FROM public.profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));
