-- ============================================================
-- 157_meta_leads_team_performance_uuid_guard.sql — UUID guard for
-- Team Member Lead Performance (preserves 156 byte-for-byte).
--
-- 156 remains the applied baseline and MUST NOT be edited:
-- applied migrations are immutable. This additive follow-up
-- re-creates get_meta_leads_team_performance() with IDENTICAL
-- signature, semantics, and grants, plus explicit uuid->text
-- casts wherever a UUID column meets TEXT: there is no
-- uuid = text operator, so the bare comparison raises
-- 42883 ("operator does not exist") and fails the whole call.
-- Non-UUID/legacy values still fall into Unassigned — never
-- dropped, never an error.
--
-- Idempotent — safe to run multiple times. LOCAL ONLY: do not
-- apply in production without explicit instruction.
-- ============================================================
--
-- Reporting hot path (same index as 156; IF NOT EXISTS makes
-- re-running safe whether or not 156 already created it).
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

  IF p_page IS NOT NULL AND p_page >= 1 THEN
    v_limit := LEAST(GREATEST(p_page_size, 1), 100);
    v_offset := (p_page - 1) * v_limit;
  END IF;
  v_detail := p_member IS NOT NULL;

  WITH
  -- Eligible lead population: DISTINCT Meta leads, countable
  -- statuses, optional form + date window. Timestamp rule matches
  -- the acquisition dashboard exactly.
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
  -- One attribution row per lead: current assignee (stable
  -- user_id, NULL when unresolvable), raw Stage, raw Type.
  lead_attr AS (
    SELECT
      l.lead_id AS lead_id,
      l.form_name AS form_name,
      l.ts AS ts,
      l.flow_run_id AS flow_run_id,
      l.contact_id AS contact_id,
      CASE
        WHEN av.value_text IS NOT NULL
          AND btrim(av.value_text) <> ''
          AND btrim(av.value_text) <> 'Unassigned'
          -- Explicit uuid->text cast: there is no uuid = text
          -- operator, so comparing profiles.user_id directly to the
          -- TEXT cell raises "operator does not exist" (42883) and
          -- fails the whole call. Casting the UUID side is total
          -- (never throws); the TEXT side is never cast.
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
  -- Team roster: every assignable member (zero-lead rows included).
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
  -- Detail rows for the View Leads dialog (only when a member or
  -- the Unassigned bucket is selected). Filters compose by AND;
  -- '__none__' matches missing Stage/Type.
  detail_base AS (
    SELECT
      la.lead_id AS lead_id,
      la.ts AS ts,
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
      -- Explicit uuid->text cast (same operator-resolution rule as
      -- the assignee check above): la.assignee_id is TEXT.
     AND ap.user_id::text = la.assignee_id
    WHERE v_detail
      AND (
        (
          (p_member = 'unassigned' AND la.assignee_id IS NULL)
          OR (p_member <> 'unassigned' AND la.assignee_id = p_member)
        )
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
