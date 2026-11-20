-- ============================================================
-- 172_meta_leads_dummy_phone_exclusion.sql — Exclude Meta dummy
-- test leads from ALL Meta Lead Ads dashboard analytics.
--
-- Meta sends test leads whose phone-number answer is the literal
-- placeholder `<test lead: dummy data for phone_number>` (see the
-- Workspace Phone Number column). These are not genuine customers
-- and must not count in any dashboard KPI, chart, breakdown, or
-- View-Leads list — while staying untouched everywhere else
-- (submissions, runs, Workspace, contacts, assignment records).
--
-- Data architecture (verified):
--   * Ingestion writes ONE normalized answers map to BOTH
--     meta_lead_submissions.answers AND flow_runs.vars
--     (process-lead.ts: vars = {...normalized.answers, source}).
--   * Standard phone derivation (normalize.ts PHONE_KEYS =
--     phone_number, phone, mobile, mobile_number, whatsapp_number)
--     is shared by ingestion and the Workspace read path
--     (table/route.ts: standardContactFromAnswers(flow_runs.vars)).
--   * Workspace Phone Number = contacts.phone ?? vars-phone
--     (flow-tables.ts toFlowTableRow). contacts.phone can NEVER
--     hold the marker: contacts are only created for valid E.164
--     phones (process-lead.ts), which the placeholder is not — so
--     dummy leads have no contact and display the vars value.
--   * Hence submissions.answers (the ingestion source, same write
--     as vars) is authoritative for the marker; the team RPC also
--     checks the already-joined flow_runs.vars at no extra cost.
--
-- Changes (additive, signatures/security/grants/scoping intact):
--   1. New helper public.is_meta_dummy_phone_lead(answers, vars):
--      true when any PHONE_KEYS value in either map normalizes to
--      the canonical placeholder (btrim + internal-whitespace
--      collapse + lowercase). Name-only "test"/"dummy" values and
--      missing phones never match.
--   2. get_meta_leads_analytics (155 rules + dummy filter in the
--      leads CTE — submissions.answers only, so flow_runs/messages
--      stay unread per the 155 contract).
--   3. get_meta_leads_agent_analytics (169 rules + same filter).
--   4. get_meta_leads_team_performance (171 rules + answers carried
--      through the leads CTE, filtered once in lead_attr so
--      members/unassigned/summary/tables/stages/detail all stay
--      reconciled; Total = Assigned + Unassigned preserved).
--
-- Idempotent — safe to run multiple times. LOCAL ONLY: do not
-- apply in production without explicit instruction.
-- ============================================================

-- Centralized predicate: one rule for all three dashboards.
CREATE OR REPLACE FUNCTION public.is_meta_dummy_phone_lead(
  p_answers JSONB,
  p_vars JSONB
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      p_answers ->> 'phone_number',
      p_answers ->> 'phone',
      p_answers ->> 'mobile',
      p_answers ->> 'mobile_number',
      p_answers ->> 'whatsapp_number',
      p_vars ->> 'phone_number',
      p_vars ->> 'phone',
      p_vars ->> 'mobile',
      p_vars ->> 'mobile_number',
      p_vars ->> 'whatsapp_number'
    ]) AS v
    WHERE v IS NOT NULL
      AND lower(regexp_replace(btrim(v), '\s+', ' ', 'g')) = '<test lead: dummy data for phone_number>'
  );
$$;

ALTER FUNCTION public.is_meta_dummy_phone_lead(JSONB, JSONB) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.is_meta_dummy_phone_lead(JSONB, JSONB) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_meta_dummy_phone_lead(JSONB, JSONB) TO authenticated;

-- ------------------------------------------------------------
-- Owner dashboard (155 + dummy exclusion in the leads CTE).
-- flow_runs/messages stay unread: the marker is read from
-- submissions.answers written at ingestion (vars mirrors it).
-- ------------------------------------------------------------
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
  -- (created_at fallback for legacy NULLs). Meta dummy test leads
  -- (placeholder phone) never count.
  leads AS (
    SELECT DISTINCT ON (s.meta_lead_id)
      s.meta_lead_id AS lead_id,
      COALESCE(s.meta_created_time, s.created_at) AS ts,
      COALESCE(NULLIF(btrim(s.form_name), ''), s.form_id, 'Unknown form') AS form_name
    FROM meta_lead_submissions s
    WHERE s.account_id = v_account_id
      AND s.status IN ('received', 'processed', 'failed')
      AND NOT public.is_meta_dummy_phone_lead(s.answers, NULL)
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

-- ------------------------------------------------------------
-- Agent dashboard (169 + dummy exclusion in the leads CTE).
-- ------------------------------------------------------------
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
  -- One row per acquired lead (same rules as 155, dummy test
  -- leads excluded via the shared predicate).
  leads AS (
    SELECT DISTINCT ON (s.meta_lead_id)
      s.meta_lead_id AS lead_id,
      COALESCE(NULLIF(btrim(s.form_name), ''), s.form_id, 'Unknown form') AS form_name,
      COALESCE(s.meta_created_time, s.created_at) AS ts,
      s.flow_run_id AS flow_run_id
    FROM meta_lead_submissions s
    WHERE s.account_id = v_account_id
      AND s.status IN ('received', 'processed', 'failed')
      AND NOT public.is_meta_dummy_phone_lead(s.answers, NULL)
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

-- ------------------------------------------------------------
-- Team performance (171 + dummy exclusion filtered once in
-- lead_attr, so members/unassigned/summary/tables/stages/forms
-- and the View-Leads detail stay reconciled).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_meta_leads_team_performance(
  p_form_id TEXT DEFAULT NULL,
  p_from DATE DEFAULT NULL,
  p_to DATE DEFAULT NULL,
  p_tz TEXT DEFAULT 'UTC',
  p_member TEXT DEFAULT NULL,
  p_stage TEXT DEFAULT NULL,
  p_type TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_page INT DEFAULT 1,
  p_page_size INT DEFAULT 25
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
  v_detail BOOLEAN := FALSE;
  v_limit INT := 25;
  v_offset INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id INTO v_account_id
  FROM profiles p
  WHERE p.user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF p_tz IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_timezone_names WHERE name = p_tz
  ) THEN
    v_tz := p_tz;
  END IF;

  IF p_page IS NOT NULL AND p_page >= 1 THEN
    v_limit := LEAST(GREATEST(p_page_size, 1), 100);
    v_offset := (p_page - 1) * v_limit;
  END IF;
  -- Detail for member drill-down OR single-table View. Both-NULL
  -- stays aggregates-only (existing behaviour preserved).
  v_detail := p_member IS NOT NULL OR p_form_id IS NOT NULL;

  WITH
  leads AS (
    SELECT DISTINCT ON (s.meta_lead_id)
      s.meta_lead_id AS lead_id,
      s.form_id AS form_id,
      COALESCE(NULLIF(btrim(s.form_name), ''), s.form_id, 'Unknown form') AS form_name,
      COALESCE(s.meta_created_time, s.created_at) AS ts,
      s.flow_run_id AS flow_run_id,
      s.contact_id AS contact_id,
      s.answers AS answers
    FROM meta_lead_submissions s
    WHERE s.account_id = v_account_id
      AND s.status IN ('received', 'processed', 'failed')
      AND (p_form_id IS NULL OR s.form_id = p_form_id)
      AND (p_from IS NULL OR (COALESCE(s.meta_created_time, s.created_at) AT TIME ZONE v_tz)::date >= p_from)
      AND (p_to IS NULL OR (COALESCE(s.meta_created_time, s.created_at) AT TIME ZONE v_tz)::date <= p_to)
    ORDER BY s.meta_lead_id, s.created_at DESC
  ),
  lead_attr AS (
    SELECT
      l.lead_id AS lead_id,
      l.form_id AS form_id,
      l.form_name AS form_name,
      l.ts AS ts,
      l.flow_run_id AS flow_run_id,
      l.contact_id AS contact_id,
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
      NULLIF(btrim(sv.value_text), '') AS stage,
      NULLIF(btrim(tv.value_text), '') AS type
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
    LEFT JOIN workspace_fields tf
      ON tf.account_id = v_account_id
     AND tf.flow_id = r.flow_id
     AND btrim(lower(tf.name)) = 'lead type'
    LEFT JOIN workspace_values tv
      ON tv.field_id = tf.id
     AND tv.flow_run_id = r.id
     AND tv.account_id = v_account_id
    -- Meta dummy test leads (placeholder phone) never count in any
    -- aggregate or detail row: answers is the ingestion source, vars
    -- the already-joined Workspace fallback — one shared predicate.
    WHERE NOT public.is_meta_dummy_phone_lead(l.answers, r.vars)
  ),
  roster AS (
    SELECT
      p.user_id AS user_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Unnamed member') AS name,
      p.email AS email,
      p.avatar_url AS avatar_url
    FROM profiles p
    WHERE p.account_id = v_account_id
      AND p.account_role IN ('owner', 'admin', 'agent')
  ),
  member_agg AS (
    SELECT
      r.user_id AS user_id,
      COUNT(la.lead_id)::INT AS total
    FROM roster r
    LEFT JOIN lead_attr la ON la.assignee_id = r.user_id::text
    GROUP BY r.user_id
  ),
  stage_agg AS (
    SELECT la.assignee_id AS assignee_id, la.stage AS stage, COUNT(*)::INT AS leads
    FROM lead_attr la
    GROUP BY la.assignee_id, la.stage
  ),
  type_agg AS (
    SELECT la.assignee_id AS assignee_id, la.type AS type, COUNT(*)::INT AS leads
    FROM lead_attr la
    GROUP BY la.assignee_id, la.type
  ),
  table_stage_agg AS (
    SELECT la.form_id AS form_id, la.stage AS stage, COUNT(*)::INT AS leads
    FROM lead_attr la
    GROUP BY la.form_id, la.stage
  ),
  member_form_agg AS (
    SELECT la.assignee_id AS assignee_id, la.form_id AS form_id,
      COALESCE(MAX(la.form_name), 'Unknown form') AS form_name, COUNT(*)::INT AS leads
    FROM lead_attr la
    GROUP BY la.assignee_id, la.form_id
  ),
  detail_base AS (
    SELECT
      la.lead_id AS lead_id,
      la.ts AS ts,
      la.form_id AS form_id,
      la.form_name AS form_name,
      la.assignee_id AS assignee_id,
      COALESCE(NULLIF(btrim(ap.full_name), ''), 'Unnamed member') AS assignee_name,
      la.stage AS stage,
      la.type AS type,
      ct.name AS contact_name,
      ct.phone AS contact_phone
    FROM lead_attr la
    LEFT JOIN contacts ct
      ON ct.id = la.contact_id
     AND ct.account_id = v_account_id
    LEFT JOIN profiles ap
      ON ap.account_id = v_account_id
     AND ap.user_id::text = la.assignee_id
    WHERE v_detail
      AND (
        (p_member IS NULL
          OR (p_member = 'unassigned' AND la.assignee_id IS NULL)
          OR (p_member <> 'unassigned' AND la.assignee_id = p_member))
        AND (p_stage IS NULL OR (p_stage = '__none__' AND la.stage IS NULL) OR (p_stage <> '__none__' AND la.stage = p_stage))
        AND (p_type IS NULL OR (p_type = '__none__' AND la.type IS NULL) OR (p_type <> '__none__' AND la.type = p_type))
        AND (
          p_search IS NULL OR btrim(p_search) = ''
          OR (ct.name IS NOT NULL AND ct.name ILIKE '%' || btrim(p_search) || '%')
          OR (ct.phone IS NOT NULL AND ct.phone ILIKE '%' || btrim(p_search) || '%')
        )
      )
  ),
  detail_total AS (
    SELECT COUNT(*)::INT AS n FROM detail_base WHERE v_detail
  ),
  detail_rows AS (
    SELECT
      to_jsonb(d.ts) AS ts,
      d.lead_id AS lead_id,
      d.form_id AS form_id,
      d.form_name AS form_name,
      d.assignee_id AS assignee_id,
      d.assignee_name AS assignee_name,
      d.stage AS stage,
      d.type AS type,
      d.contact_name AS contact_name,
      d.contact_phone AS contact_phone
    FROM detail_base d
    WHERE v_detail
    ORDER BY d.ts DESC, d.lead_id
    LIMIT v_limit OFFSET v_offset
  ),
  forms AS (
    SELECT DISTINCT s.form_id AS form_id,
      COALESCE(NULLIF(btrim(s.form_name), ''), s.form_id, 'Unknown form') AS form_name
    FROM meta_lead_submissions s
    WHERE s.account_id = v_account_id
      AND s.status IN ('received', 'processed', 'failed')
      AND s.form_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'members', COALESCE((
      SELECT jsonb_agg(item ORDER BY (item->>'total')::INT DESC, item->>'name')
      FROM (
        SELECT jsonb_build_object(
          'userId', r.user_id,
          'name', r.name,
          'email', r.email,
          'avatar', r.avatar_url,
          'total', COALESCE(ma.total, 0),
          'stages', COALESCE((
            SELECT jsonb_agg(item ORDER BY item->>'stage')
            FROM (
              SELECT jsonb_build_object('stage', sa.stage, 'leads', sa.leads) AS item
              FROM stage_agg sa
              WHERE sa.assignee_id IS NOT DISTINCT FROM r.user_id::text
            ) s2
          ), '[]'::JSONB),
          'types', COALESCE((
            SELECT jsonb_agg(item ORDER BY item->>'type')
            FROM (
              SELECT jsonb_build_object('type', ta.type, 'leads', ta.leads) AS item
              FROM type_agg ta
              WHERE ta.assignee_id IS NOT DISTINCT FROM r.user_id::text
            ) s2
          ), '[]'::JSONB),
          'forms', COALESCE((
            SELECT jsonb_agg(item ORDER BY (item->>'leads')::INT DESC, item->>'formName')
            FROM (
              SELECT jsonb_build_object('formId', mfa.form_id, 'formName', mfa.form_name, 'leads', mfa.leads) AS item
              FROM member_form_agg mfa
              WHERE mfa.assignee_id IS NOT DISTINCT FROM r.user_id::text
            ) s2
          ), '[]'::JSONB)
        ) AS item
        FROM roster r
        LEFT JOIN member_agg ma ON ma.user_id = r.user_id
      ) s
    ), '[]'::JSONB),
    'unassigned', jsonb_build_object(
      'total', COALESCE((SELECT COUNT(*)::INT FROM lead_attr la WHERE la.assignee_id IS NULL), 0),
      'stages', COALESCE((
        SELECT jsonb_agg(item ORDER BY item->>'stage')
        FROM (
          SELECT jsonb_build_object('stage', sa.stage, 'leads', sa.leads) AS item
          FROM stage_agg sa
          WHERE sa.assignee_id IS NULL
        ) s2
      ), '[]'::JSONB),
      'types', COALESCE((
        SELECT jsonb_agg(item ORDER BY item->>'type')
        FROM (
          SELECT jsonb_build_object('type', ta.type, 'leads', ta.leads) AS item
          FROM type_agg ta
          WHERE ta.assignee_id IS NULL
        ) s2
      ), '[]'::JSONB),
      'forms', COALESCE((
        SELECT jsonb_agg(item ORDER BY (item->>'leads')::INT DESC, item->>'formName')
        FROM (
          SELECT jsonb_build_object('formId', mfa.form_id, 'formName', mfa.form_name, 'leads', mfa.leads) AS item
          FROM member_form_agg mfa
          WHERE mfa.assignee_id IS NULL
        ) s2
      ), '[]'::JSONB)
    ),
    'summary', (
      SELECT jsonb_build_object(
        'total', COUNT(DISTINCT la.lead_id)::INT,
        'assigned', COUNT(DISTINCT la.lead_id) FILTER (WHERE la.assignee_id IS NOT NULL)::INT,
        'unassigned', COUNT(DISTINCT la.lead_id) FILTER (WHERE la.assignee_id IS NULL)::INT
      )
      FROM lead_attr la
    ),
    'forms', COALESCE((
      SELECT jsonb_agg(item ORDER BY item->>'formName')
      FROM (
        SELECT jsonb_build_object('formId', f.form_id, 'formName', f.form_name) AS item
        FROM forms f
      ) s
    ), '[]'::JSONB),
    'tables', COALESCE((
      SELECT jsonb_agg(item ORDER BY (item->>'total')::INT DESC, item->>'formName')
      FROM (
        SELECT jsonb_build_object(
          'formId', t.form_id,
          'formName', t.form_name,
          'total', t.total,
          'assigned', t.assigned,
          'unassigned', t.unassigned,
          'stages', COALESCE((
            SELECT jsonb_agg(sitem ORDER BY sitem->>'stage')
            FROM (
              SELECT jsonb_build_object('stage', tsa.stage, 'leads', tsa.leads) AS sitem
              FROM table_stage_agg tsa
              WHERE tsa.form_id IS NOT DISTINCT FROM t.form_id
            ) s2
          ), '[]'::JSONB)
        ) AS item
        FROM (
          SELECT
            la.form_id AS form_id,
            COALESCE(MAX(la.form_name), 'Unknown form') AS form_name,
            COUNT(*)::INT AS total,
            COUNT(*) FILTER (WHERE la.assignee_id IS NOT NULL)::INT AS assigned,
            COUNT(*) FILTER (WHERE la.assignee_id IS NULL)::INT AS unassigned
          FROM lead_attr la
          GROUP BY la.form_id
        ) t
      ) s
    ), '[]'::JSONB),
    'leads', jsonb_build_object(
      'total', COALESCE((SELECT n FROM detail_total), 0),
      'rows', COALESCE((SELECT jsonb_agg(r) FROM detail_rows r), '[]'::JSONB)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.get_meta_leads_team_performance(
  TEXT, DATE, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_meta_leads_team_performance(
  TEXT, DATE, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_meta_leads_team_performance(
  TEXT, DATE, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT
) TO authenticated;
