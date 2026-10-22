-- ============================================================
-- 128_meta_lead_notifications.sql — new-lead email notifications
--
-- Per-account opt-in settings + a durable outbox for emails sent to
-- the salesperson assigned to a genuinely new Meta Lead Ads row.
--
-- Design (mirrors 057 flow_email_notifications):
--   * `meta_lead_notification_settings` — one row per account,
--     default OFF. Only the enabled flag + templates live here;
--     SMTP credentials NEVER live in the database (server env only).
--   * `meta_lead_notifications` — one row per notified lead, keyed
--     UNIQUE(account_id, submission_id) so polling, imports,
--     retries and concurrent workers can never enqueue twice.
--     Lifecycle: queued → sending → sent | failed (+backoff).
--   * `meta_lead_submissions.campaign_name / ad_name` — snapshot of
--     the ad attribution at processing time for the email body.
--     (Ad-set name is not returned by the Lead node; see notify.ts.)
--
-- Email sending never blocks ingestion: enqueue is one fast INSERT
-- (best-effort, never throws into lead processing) and delivery is
-- drained by the existing meta-lead-ads cron sweep.
-- ============================================================

-- ---------- 1. Per-account settings (default OFF) -------------
CREATE TABLE IF NOT EXISTS public.meta_lead_notification_settings (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  subject_template TEXT NOT NULL DEFAULT 'New Lead Assigned to You — {{lead_name}}',
  body_template TEXT NOT NULL DEFAULT
    'Hi {{assignee_name}},

A new lead was assigned to you in WhatsApp Max.

Name: {{lead_name}}
Phone: {{lead_phone}}
Email: {{lead_email}}
Form: {{form_name}}
Campaign: {{campaign_name}}
Ad: {{ad_name}}
Received: {{received_at}}

Open the lead: {{lead_link}}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.meta_lead_notification_settings IS
  'Per-account opt-in for new Meta Lead Ads notification emails. Default OFF. SMTP credentials are server env vars, never stored here.';

-- ---------- 2. Notification outbox -----------------------------
CREATE TABLE IF NOT EXISTS public.meta_lead_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  submission_id UUID NOT NULL REFERENCES public.meta_lead_submissions(id) ON DELETE CASCADE,
  flow_run_id UUID REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  recipient_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Snapshot at enqueue time (stable even if the profile changes).
  recipient_email TEXT,
  assignee_name TEXT,
  lead_name TEXT,
  lead_phone TEXT,
  lead_email TEXT,
  form_name TEXT,
  campaign_name TEXT,
  ad_name TEXT,
  received_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ,
  sent_message_id TEXT,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_notifications_account_submission_key
    UNIQUE (account_id, submission_id)
);

COMMENT ON TABLE public.meta_lead_notifications IS
  'Durable outbox for new-lead emails. UNIQUE(account_id, submission_id) makes duplicate ingestion a no-op. Drained by the meta-lead-ads cron; never blocks lead processing.';

-- ---------- 3. Ad attribution snapshot on submissions ----------
ALTER TABLE public.meta_lead_submissions
  ADD COLUMN IF NOT EXISTS campaign_name TEXT;
ALTER TABLE public.meta_lead_submissions
  ADD COLUMN IF NOT EXISTS ad_name TEXT;

COMMENT ON COLUMN public.meta_lead_submissions.campaign_name IS
  'Snapshot of the Lead node campaign_name at processing time (for notification emails).';
COMMENT ON COLUMN public.meta_lead_submissions.ad_name IS
  'Snapshot of the Lead node ad_name at processing time (for notification emails).';

-- ---------- 4. Indexes ----------------------------------------
CREATE INDEX IF NOT EXISTS idx_meta_lead_notifications_due
  ON public.meta_lead_notifications(next_attempt_at)
  WHERE status IN ('queued', 'failed');

CREATE INDEX IF NOT EXISTS idx_meta_lead_notifications_sending
  ON public.meta_lead_notifications(updated_at)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS idx_meta_lead_notifications_account
  ON public.meta_lead_notifications(account_id, created_at DESC);

-- ---------- 5. updated_at triggers -----------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_notification_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_notification_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_notifications;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_notifications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 6. RLS ---------------------------------------------
ALTER TABLE public.meta_lead_notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_lead_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_lead_notif_settings_select ON public.meta_lead_notification_settings;
CREATE POLICY meta_lead_notif_settings_select ON public.meta_lead_notification_settings
  FOR SELECT USING (is_account_member(account_id, 'viewer'));

DROP POLICY IF EXISTS meta_lead_notif_settings_admin ON public.meta_lead_notification_settings;
CREATE POLICY meta_lead_notif_settings_admin ON public.meta_lead_notification_settings
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_lead_notifications_select ON public.meta_lead_notifications;
CREATE POLICY meta_lead_notifications_select ON public.meta_lead_notifications
  FOR SELECT USING (is_account_member(account_id, 'viewer'));
