-- ============================================================
-- 155_meta_leads_dashboard.sql — acquisition analytics for the
-- standalone Meta Lead Ads dashboard (route /meta-lead-ads/dashboard).
--
-- Source of truth is meta_lead_submissions ONLY: every received
-- Instant Form submission is a lead for acquisition reporting,
-- whether or not a contact, conversation, or WhatsApp message was
-- ever created. messages / flow_runs are deliberately never read.
--
-- Counting rules (mirrored by the API + client contracts):
--   - DISTINCT meta_lead_id per account (the UNIQUE(account_id,
--     meta_lead_id) key already guarantees one row per lead; the
--     DISTINCT is belt-and-suspenders against duplicate webhook
--     deliveries that raced the ledger).
--   - Statuses counted: received, processed, failed. A lead stays
--     a lead even when subsequent processing fails.
--   - Status excluded: ignored (form disabled at fetch time —
--     never a real acquisition).
--   - Reporting timestamp: Meta's original submission instant
--     (meta_created_time), falling back to created_at when NULL.
--   - Day/month bucketing in the caller's timezone (p_tz, UTC
--     fallback — same convention as get_dashboard_analytics).
--   - Series key: form display name (form_name, falling back to
--     form_id, then 'Unknown form') — never hardcoded.
--
-- Shape: KPIs (today / yesterday, caller-supplied local bounds as
-- instants, same convention as the WhatsApp dashboard), trailing-30
-- daily points with per-form splits (zero days present), and 12
-- monthly totals with per-form splits for p_year (zero months
-- present). Single call, server-side aggregation, no N+1.
--
-- Security posture mirrors get_dashboard_analytics: SECURITY
-- INVOKER, account derived from auth.uid(), authenticated-only
-- grant. Members may SELECT submissions (119 policy), so every
-- role can read its own account's acquisition numbers.
--
-- Idempotent — safe to run multiple times. LOCAL ONLY: do not
-- apply in production.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_meta_lead_submissions_reporting
  ON public.meta_lead_submissions (account_id, (COALESCE(meta_created_time, created_at)) DESC)
  WHERE status IN ('received', 'processed', 'failed');

CREATE OR REPLACE FUNCTION public.get_meta_leads_analytics(
  p_today_start TIMESTAMPTZ,
  p_today_end TIMESTAMPTZ,
  p_yest_start TIMESTAMPTZ,
  p_yest_end TIMESTAMPTZ,
  p_year INT,
  p_tz TEXT DEFAULT 'UTC'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_tz TEXT := 'UTC';
  v_result JSONB;
BEGIN
  -- Caller must be authenticated and linked to an account.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id INTO v_account_id
  FROM profiles p
  WHERE p.user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Trust but verify the timezone: an unknown name falls back
  -- to UTC rather than erroring the whole dashboard.
  IF p_tz IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_timezone_names WHERE name = p_tz
  ) THEN
    v_tz := p_tz;
  END IF;

  WITH
  -- One row per acquired lead: DISTINCT Meta lead id, countable
  -- statuses only, reported at Meta's original submission instant
  -- (created_at fallback for legacy NULLs).
  leads AS (
    SELECT DISTINCT ON (s.meta_lead_id)
      s.meta_lead_id AS lead_id,
      COALESCE(s.meta_created_time, s.created_at) AS ts,
      COALESCE(NULLIF(btrim(s.form_name), ''), s.form_id, 'Unknown form') AS form_name
    FROM meta_lead_submissions s
    WHERE s.account_id = v_account_id
      AND s.status IN ('received', 'processed', 'failed')
  ),
  -- Trailing-30 calendar days in the caller's timezone (today
  -- included), as dates so generate_series emits every day.
  daily_bounds AS (
    SELECT
      ((now() AT TIME ZONE v_tz)::date - 29) AS d_from,
      ((now() AT TIME ZONE v_tz)::date) AS d_to
  ),
  daily_leads AS (
    SELECT
      (l.ts AT TIME ZONE v_tz)::date AS day,
      l.form_name AS form_name
    FROM leads l
    CROSS JOIN daily_bounds b
    WHERE (l.ts AT TIME ZONE v_tz)::date BETWEEN b.d_from AND b.d_to
  ),
  daily_agg AS (
    SELECT
      dl.day AS day,
      dl.form_name AS form_name,
      COUNT(*)::INT AS leads
    FROM daily_leads dl
    GROUP BY dl.day, dl.form_name
  ),
  monthly_leads AS (
    SELECT
      EXTRACT(MONTH FROM (l.ts AT TIME ZONE v_tz))::INT AS mth,
      l.form_name AS form_name
    FROM leads l
    WHERE EXTRACT(YEAR FROM (l.ts AT TIME ZONE v_tz))::INT = p_year
  ),
  monthly_agg AS (
    SELECT
      ml.mth AS mth,
      ml.form_name AS form_name,
      COUNT(*)::INT AS leads
    FROM monthly_leads ml
    GROUP BY ml.mth, ml.form_name
  )
  SELECT jsonb_build_object(
    'year', p_year,
    'todayLeads', (
      SELECT COUNT(DISTINCT l.lead_id)::INT FROM leads l
      WHERE l.ts >= p_today_start AND l.ts < p_today_end
    ),
    'yesterdayLeads', (
      SELECT COUNT(DISTINCT l.lead_id)::INT FROM leads l
      WHERE l.ts >= p_yest_start AND l.ts < p_yest_end
    ),
    'daily', COALESCE((
      SELECT jsonb_agg(d ORDER BY (d->>'date'))
      FROM (
        SELECT jsonb_build_object(
          'date', gs.day::TEXT,
          'total', COALESCE(SUM(da.leads), 0)::INT,
          'forms', COALESCE((
            SELECT jsonb_agg(item ORDER BY (item->>'leads')::INT DESC)
            FROM (
              SELECT jsonb_build_object(
                'formName', fa.form_name,
                'leads', fa.leads
              ) AS item
              FROM daily_agg fa
              WHERE fa.day = gs.day
            ) s2
          ), '[]'::JSONB)
        ) AS d
        FROM (
          SELECT generate_series(b.d_from, b.d_to, '1 day'::interval)::date AS day
          FROM daily_bounds b
        ) gs
        LEFT JOIN daily_agg da ON da.day = gs.day
        GROUP BY gs.day
      ) s
    ), '[]'::JSONB),
    'monthly', COALESCE((
      SELECT jsonb_agg(m ORDER BY (m->>'month')::INT)
      FROM (
        SELECT jsonb_build_object(
          'year', p_year,
          'month', gs.mth,
          'total', COALESCE(SUM(ma.leads), 0)::INT,
          'forms', COALESCE((
            SELECT jsonb_agg(item ORDER BY (item->>'leads')::INT DESC)
            FROM (
              SELECT jsonb_build_object(
                'formName', fa.form_name,
                'leads', fa.leads
              ) AS item
              FROM monthly_agg fa
              WHERE fa.mth = gs.mth
            ) s2
          ), '[]'::JSONB)
        ) AS m
        FROM generate_series(1, 12) AS gs(mth)
        LEFT JOIN monthly_agg ma ON ma.mth = gs.mth
        GROUP BY gs.mth
      ) s
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.get_meta_leads_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_meta_leads_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_meta_leads_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) TO authenticated;
