-- ============================================================
-- Meta Lead Ads agent dashboard analytics (personal, self-scoped).
--
-- New function get_meta_leads_agent_analytics(): same acquisition
-- counting rules as get_meta_leads_analytics (155) — DISTINCT
-- meta_lead_id per account, statuses received/processed/failed,
-- COALESCE(meta_created_time, created_at), caller-timezone
-- bucketing, per-form splits — but restricted to leads CURRENTLY
-- assigned to the caller.
--
-- Assignment resolution mirrors get_meta_leads_team_performance
-- (156/157, uuid guard included): workspace "Assigned To" cell
-- holds the stable profiles.user_id UUID text; valid only for an
-- assignable member (owner/admin/agent) of this account, else the
-- lead is Unassigned and never appears in any agent's dashboard.
-- Reassignments are handled implicitly: only the CURRENT cell
-- value counts, so a reassigned lead moves to the new owner's
-- dashboard and leaves the previous one.
--
-- Security: SECURITY INVOKER, account AND member derived from
-- auth.uid() — no member/account param, so an agent cannot spoof
-- another member's id. Authenticated-only grant, same as 155.
--
-- Shape: assignedTotal (current assigned, all time) + today /
-- yesterday (caller-local bounds) + trailing-30 daily + 12
-- monthly buckets for p_year (zero-filled) + stages overview
-- (raw Stage values, NULL preserved for the "No Stage" label).
-- Last-7 / Last-30 rolling KPIs are derived by the API route
-- from the daily buckets (same rollup as the owner dashboard),
-- so they are not duplicated here.
--
-- Additive only: 155/156/157 untouched. Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_meta_leads_agent_analytics(
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
  v_member_id TEXT;
  v_tz TEXT := 'UTC';
  v_result JSONB;
BEGIN
  -- Caller must be authenticated and linked to an account.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.user_id::text INTO v_account_id, v_member_id
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
  -- One row per acquired lead (same rules as 155).
  leads AS (
    SELECT DISTINCT ON (s.meta_lead_id)
      s.meta_lead_id AS lead_id,
      COALESCE(NULLIF(btrim(s.form_name), ''), s.form_id, 'Unknown form') AS form_name,
      COALESCE(s.meta_created_time, s.created_at) AS ts,
      s.flow_run_id AS flow_run_id
    FROM meta_lead_submissions s
    WHERE s.account_id = v_account_id
      AND s.status IN ('received', 'processed', 'failed')
  ),
  -- Current assignment per lead (same resolution as 156/157,
  -- uuid guard included: no uuid = text operator exists).
  lead_attr AS (
    SELECT
      l.lead_id AS lead_id,
      l.form_name AS form_name,
      l.ts AS ts,
      CASE
        WHEN av.value_text IS NOT NULL
          AND btrim(av.value_text) <> ''
          AND btrim(av.value_text) <> 'Unassigned'
          AND EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.account_id = v_account_id
              AND p.user_id::text = btrim(av.value_text)
              AND p.account_role IN ('owner', 'admin', 'agent')
          )
        THEN btrim(av.value_text)
        ELSE NULL
      END AS assignee_id,
      NULLIF(btrim(sv.value_text), '') AS stage
    FROM leads l
    LEFT JOIN flow_runs r
      ON r.id = l.flow_run_id
     AND r.account_id = v_account_id
    LEFT JOIN workspace_fields af
      ON af.account_id = v_account_id
     AND af.flow_id = r.flow_id
     AND btrim(lower(af.name)) = 'assigned to'
    LEFT JOIN workspace_values av
      ON av.field_id = af.id
     AND av.flow_run_id = r.id
     AND av.account_id = v_account_id
    LEFT JOIN workspace_fields sf
      ON sf.account_id = v_account_id
     AND sf.flow_id = r.flow_id
     AND btrim(lower(sf.name)) = 'stage'
    LEFT JOIN workspace_values sv
      ON sv.field_id = sf.id
     AND sv.flow_run_id = r.id
     AND sv.account_id = v_account_id
  ),
  -- Only the caller's own currently-assigned leads.
  mine AS (
    SELECT la.lead_id, la.form_name, la.ts, la.stage
    FROM lead_attr la
    WHERE la.assignee_id = v_member_id
  ),
  daily_bounds AS (
    SELECT
      ((now() AT TIME ZONE v_tz)::date - 29) AS d_from,
      ((now() AT TIME ZONE v_tz)::date) AS d_to
  ),
  daily_leads AS (
    SELECT
      (m.ts AT TIME ZONE v_tz)::date AS day,
      m.form_name AS form_name
    FROM mine m
    CROSS JOIN daily_bounds b
    WHERE (m.ts AT TIME ZONE v_tz)::date BETWEEN b.d_from AND b.d_to
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
      EXTRACT(MONTH FROM (m.ts AT TIME ZONE v_tz))::INT AS mth,
      m.form_name AS form_name
    FROM mine m
    WHERE EXTRACT(YEAR FROM (m.ts AT TIME ZONE v_tz))::INT = p_year
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
    'assignedTotal', (
      SELECT COUNT(DISTINCT m.lead_id)::INT FROM mine m
    ),
    'todayLeads', (
      SELECT COUNT(DISTINCT m.lead_id)::INT FROM mine m
      WHERE m.ts >= p_today_start AND m.ts < p_today_end
    ),
    'yesterdayLeads', (
      SELECT COUNT(DISTINCT m.lead_id)::INT FROM mine m
      WHERE m.ts >= p_yest_start AND m.ts < p_yest_end
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
    ), '[]'::JSONB),
    'stages', COALESCE((
      SELECT jsonb_agg(item ORDER BY item->>'stage')
      FROM (
        SELECT jsonb_build_object('stage', s.stage, 'leads', s.leads) AS item
        FROM (
          SELECT m.stage AS stage, COUNT(*)::INT AS leads
          FROM mine m
          GROUP BY m.stage
        ) s
      ) s2
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.get_meta_leads_agent_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_meta_leads_agent_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_meta_leads_agent_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT
) TO authenticated;
