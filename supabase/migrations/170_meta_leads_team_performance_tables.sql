-- ============================================================
-- 170_meta_leads_team_performance_tables.sql — Table-wise breakdown
-- for the Team Performance dashboard (all Meta Lead Ads tables).
--
-- Additive follow-up to 156 (baseline, immutable) + 157 (uuid guard).
-- Re-creates get_meta_leads_team_performance() with IDENTICAL
-- signature, security posture, lead population, assignment/stage
-- resolution, and existing keys (members/unassigned/summary/forms/
-- leads) — plus:
--   1. `tables[]`: per–Meta-form aggregates over the SAME filtered
--      lead population (date/form window): total / assigned /
--      unassigned + raw stages[] split. Sorted total DESC. Enables
--      the bottom "Table-wise Summary" without one-request-per-form
--      and without N+1. NULL form_id leads are included as their own
--      bucket (formId null, "Unknown form") so tables SUM matches
--      summary.total.
--   2. Form-aware lead detail: previously detail rows required
--      p_member (v_detail := p_member IS NOT NULL). Table "View"
--      needs leads for one form across all members. Now
--      v_detail := p_member IS NOT NULL OR p_form_id IS NOT NULL,
--      and the member predicate allows p_member IS NULL (all members
--      in the already form-filtered population). Aggregates-only call
--      (both NULL) is unchanged.
--   3. lead_attr + detail rows now carry form_id (new key `formId`
--      in detail rows; old keys untouched).
--
-- Counting/timestamp/uuid-guard rules unchanged from 157.
-- Idempotent — safe to run multiple times. LOCAL ONLY: do not
-- apply in production without explicit instruction.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_meta_lead_submissions_team_perf
  ON public.meta_lead_submissions
    (account_id, status, form_id, (COALESCE(meta_created_time, created_at)) DESC)
  WHERE status IN ('received', 'processed', 'failed');

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
      s.contact_id AS contact_id
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
