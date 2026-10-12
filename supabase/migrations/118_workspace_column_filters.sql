-- ============================================================
-- 118_workspace_column_filters.sql — server-side Workspace column
-- filters for five business columns.
--
-- Extends get_flow_table_rows() (094, pin/hide 117) with OPTIONAL,
-- backward-compatible params (all DEFAULT NULL = no filter, so
-- existing callers are unaffected):
--
--   p_call_status TEXT[] / p_followup_status TEXT[]
--     Multi-select (OR within the section): rows whose stored
--     single-select value equals ANY listed value. Empty/NULL =
--     inactive. Values match workspace_values.value_text by exact
--     equality — the same rule single-select writes validate by —
--     so only real saved states match; nothing is invented.
--   p_calls_tried_op TEXT + p_calls_tried_value/min/max INT
--     Numeric conditions over "No. of Calls Tried": eq / gt / lt /
--     between. Non-numeric legacy values are guarded out by regex
--     (they simply never match) so they can never abort the query
--     on cast. Unknown operators raise (22023); the API validates
--     first, so this fires only for out-of-band callers.
--   p_last_contact_from / p_last_contact_to DATE
--     Half-open [from, to) over "Last Contact Date". Stored dates
--     normalize to canonical YYYY-MM-DD on write; comparison is
--     guarded text equality on that canonical shape (zero-padded,
--     so lexicographic order IS chronological order) — garbage
--     values never match and never error. NULL side = open-ended.
--   p_next_followup_from / p_next_followup_to TEXT
--     Half-open [from, to) over "Next Follow-up Date & Time" as
--     canonical UTC ISO instants (stored values normalize to
--     toISOString() on write; the API normalizes bounds the same
--     way — instant comparison with no tz skew). Same guarded
--     text comparison as dates. Rows with no (or unparsable)
--     follow-up never match a datetime predicate — empties are
--     handled separately from dated rows. NULL side = open-ended.
--
-- Field identity resolves inside the function by case-insensitive
-- name match (the same rule the app uses): an active filter whose
-- column is missing/renamed matches zero rows (the established
-- graceful-degradation rule — cf. the assignee filter in 094).
--
-- Combination is conjunctive (AND) with every existing predicate
-- (view, search, date, assignee, hidden): total + page slice are
-- computed after ALL predicates, keeping pagination, row
-- numbering, pin ordering, and hidden exclusion correct. Pin/hide
-- behavior from 117 is otherwise byte-identical.
--
-- Security: unchanged (SECURITY INVOKER, account from auth.uid(),
-- flow must belong to that account). Value lookups read
-- workspace_fields / workspace_values under the caller's RLS, so
-- only the current account's data can ever match.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_flow_table_rows(
  p_flow_id UUID,
  p_view TEXT DEFAULT 'all',
  p_search TEXT DEFAULT NULL,
  p_page INT DEFAULT 0,
  p_page_size INT DEFAULT 25,
  p_started_from TIMESTAMPTZ DEFAULT NULL,
  p_started_to TIMESTAMPTZ DEFAULT NULL,
  p_assignee TEXT DEFAULT NULL,
  p_call_status TEXT[] DEFAULT NULL,
  p_calls_tried_op TEXT DEFAULT NULL,
  p_calls_tried_value INT DEFAULT NULL,
  p_calls_tried_min INT DEFAULT NULL,
  p_calls_tried_max INT DEFAULT NULL,
  p_followup_status TEXT[] DEFAULT NULL,
  p_last_contact_from DATE DEFAULT NULL,
  p_last_contact_to DATE DEFAULT NULL,
  p_next_followup_from TEXT DEFAULT NULL,
  p_next_followup_to TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_flow RECORD;
  v_page INT := GREATEST(COALESCE(p_page, 0), 0);
  v_page_size INT := LEAST(GREATEST(COALESCE(p_page_size, 25), 1), 100);
  v_offset INT;
  v_search TEXT := NULLIF(BTRIM(COALESCE(p_search, '')), '');
  v_assignee TEXT := NULLIF(BTRIM(COALESCE(p_assignee, '')), '');
  v_assignee_field_id UUID;
  -- Column-filter field ids (NULL when the column is missing or
  -- renamed — active filters then match zero rows, never error).
  v_call_status_field_id UUID;
  v_calls_tried_field_id UUID;
  v_followup_status_field_id UUID;
  v_last_contact_field_id UUID;
  v_next_followup_field_id UUID;
  -- Normalized multi-selects: NULL when empty/absent (inactive).
  v_call_status TEXT[] := CASE WHEN COALESCE(cardinality(p_call_status), 0) = 0 THEN NULL ELSE p_call_status END;
  v_followup_status TEXT[] := CASE WHEN COALESCE(cardinality(p_followup_status), 0) = 0 THEN NULL ELSE p_followup_status END;
  -- Normalized numeric condition: NULL op = inactive.
  v_calls_op TEXT := NULLIF(BTRIM(COALESCE(p_calls_tried_op, '')), '');
  v_result JSONB;
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

  SELECT f.id, f.account_id, f.name, f.completion_node_id
  INTO v_flow
  FROM flows f
  WHERE f.id = p_flow_id;

  IF v_flow.id IS NULL OR v_flow.account_id IS DISTINCT FROM v_account_id THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_view IS NOT NULL AND p_view NOT IN ('all', 'completed', 'incomplete') THEN
    RAISE EXCEPTION 'Invalid view (all|completed|incomplete)' USING ERRCODE = '22023';
  END IF;

  IF v_calls_op IS NOT NULL AND v_calls_op NOT IN ('eq', 'gt', 'lt', 'between') THEN
    RAISE EXCEPTION 'Invalid calls-tried operator (eq|gt|lt|between)' USING ERRCODE = '22023';
  END IF;

  -- "Assigned To" column for this flow (case-insensitive, same
  -- rule as the app). Missing/renamed → NULL and the assignee
  -- predicate below degrades gracefully.
  SELECT wf.id INTO v_assignee_field_id
  FROM workspace_fields wf
  WHERE wf.flow_id = p_flow_id
    AND lower(btrim(wf.name)) = 'assigned to'
  LIMIT 1;

  -- Business-column field ids for the five column filters
  -- (case-insensitive, same rule as the app). Each missing column
  -- leaves its predicate matching zero rows when that filter is
  -- active — never an error, never a bypass.
  SELECT wf.id INTO v_call_status_field_id
  FROM workspace_fields wf
  WHERE wf.flow_id = p_flow_id
    AND lower(btrim(wf.name)) = 'call status'
  LIMIT 1;

  SELECT wf.id INTO v_calls_tried_field_id
  FROM workspace_fields wf
  WHERE wf.flow_id = p_flow_id
    AND lower(btrim(wf.name)) = 'no. of calls tried'
  LIMIT 1;

  SELECT wf.id INTO v_followup_status_field_id
  FROM workspace_fields wf
  WHERE wf.flow_id = p_flow_id
    AND lower(btrim(wf.name)) = 'follow-up status'
  LIMIT 1;

  SELECT wf.id INTO v_last_contact_field_id
  FROM workspace_fields wf
  WHERE wf.flow_id = p_flow_id
    AND lower(btrim(wf.name)) = 'last contact date'
  LIMIT 1;

  SELECT wf.id INTO v_next_followup_field_id
  FROM workspace_fields wf
  WHERE wf.flow_id = p_flow_id
    AND lower(btrim(wf.name)) = 'next follow-up date & time'
  LIMIT 1;

  v_offset := v_page * v_page_size;

  WITH base AS (
    SELECT
      r.id AS run_id,
      r.contact_id AS contact_id,
      c.name AS contact_name,
      c.phone AS contact_phone,
      r.conversation_id AS conversation_id,
      r.status AS status,
      r.started_at AS started_at,
      r.last_advanced_at AS last_advanced_at,
      r.ended_at AS ended_at,
      r.vars AS vars,
      -- The caller's pin for this row (FALSE when never pinned).
      -- RLS on workspace_row_prefs scopes this join to the caller's
      -- own rows, so another user's pins can never leak in.
      COALESCE(rp.is_pinned, FALSE) AS is_pinned,
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN (
          SELECT MAX(e.created_at)
          FROM flow_run_events e
          WHERE e.flow_run_id = r.id
            AND e.node_key = v_flow.completion_node_id
        )
        ELSE NULL
      END AS reached_at
    FROM flow_runs r
    LEFT JOIN contacts c ON c.id = r.contact_id
    -- Personal row prefs: one row per (user, flow, run) at most, so
    -- this join can never fan out. Scoped to the caller — never to
    -- another user's preferences.
    LEFT JOIN workspace_row_prefs rp
      ON rp.flow_run_id = r.id
      AND rp.user_id = auth.uid()
    WHERE r.flow_id = p_flow_id
      AND r.account_id = v_account_id
      AND (
        v_search IS NULL
        OR c.name ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR c.phone ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
      -- Date filter: half-open window over Submission Time.
      AND (p_started_from IS NULL OR r.started_at >= p_started_from)
      AND (p_started_to IS NULL OR r.started_at < p_started_to)
      -- Assignee filter: conjunctive with view + search + date.
      AND (
        v_assignee IS NULL OR lower(v_assignee) = 'all'
        OR (
          lower(v_assignee) = 'unassigned'
          AND (
            v_assignee_field_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM workspace_values v
              WHERE v.field_id = v_assignee_field_id
                AND v.flow_run_id = r.id
                AND v.value_text IS NOT NULL
                AND btrim(v.value_text) <> ''
                AND v.value_text <> 'Unassigned'
            )
          )
        )
        OR (
          v_assignee_field_id IS NOT NULL
          AND lower(v_assignee) NOT IN ('all', 'unassigned')
          AND EXISTS (
            SELECT 1
            FROM workspace_values v
            WHERE v.field_id = v_assignee_field_id
              AND v.flow_run_id = r.id
              AND v.value_text = v_assignee
          )
        )
      )
      -- Call Status filter: stored single-select value equals ANY
      -- listed value (OR within the section, AND with everything
      -- else). Missing column + active filter matches zero rows.
      AND (
        v_call_status IS NULL
        OR (
          v_call_status_field_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM workspace_values v
            WHERE v.field_id = v_call_status_field_id
              AND v.flow_run_id = r.id
              AND v.value_text = ANY(v_call_status)
          )
        )
      )
      -- No. of Calls Tried filter: numeric conditions over the
      -- stored count. Non-numeric legacy values are guarded out by
      -- regex (never match, never abort the cast). Missing column
      -- + active filter matches zero rows.
      AND (
        v_calls_op IS NULL
        OR (
          v_calls_tried_field_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM workspace_values v
            WHERE v.field_id = v_calls_tried_field_id
              AND v.flow_run_id = r.id
              AND v.value_text ~ '^[0-9]+$'
              AND (
                (v_calls_op = 'eq' AND v.value_text::INT = p_calls_tried_value)
                OR (v_calls_op = 'gt' AND v.value_text::INT > p_calls_tried_value)
                OR (v_calls_op = 'lt' AND v.value_text::INT < p_calls_tried_value)
                OR (v_calls_op = 'between'
                    AND v.value_text::INT >= p_calls_tried_min
                    AND v.value_text::INT <= p_calls_tried_max)
              )
          )
        )
      )
      -- Follow-Up Status filter: same shape as Call Status —
      -- stored value equals ANY listed value.
      AND (
        v_followup_status IS NULL
        OR (
          v_followup_status_field_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM workspace_values v
            WHERE v.field_id = v_followup_status_field_id
              AND v.flow_run_id = r.id
              AND v.value_text = ANY(v_followup_status)
          )
        )
      )
      -- Last Contact Date filter: half-open [from, to) over the
      -- stored canonical YYYY-MM-DD (guarded text comparison —
      -- garbage never matches, never errors). NULL side =
      -- open-ended. Missing column + active filter matches zero.
      AND (
        (p_last_contact_from IS NULL AND p_last_contact_to IS NULL)
        OR (
          v_last_contact_field_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM workspace_values v
            WHERE v.field_id = v_last_contact_field_id
              AND v.flow_run_id = r.id
              AND v.value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              AND (p_last_contact_from IS NULL OR v.value_text >= p_last_contact_from::TEXT)
              AND (p_last_contact_to IS NULL OR v.value_text < p_last_contact_to::TEXT)
          )
        )
      )
      -- Next Follow-up Date & Time filter: half-open [from, to)
      -- over the stored canonical UTC ISO instant (guarded text
      -- comparison — same shape the API normalizes bounds to, so
      -- lexicographic order IS chronological order). Rows with no
      -- (or unparsable) follow-up never match. Missing column +
      -- active filter matches zero rows.
      AND (
        (p_next_followup_from IS NULL AND p_next_followup_to IS NULL)
        OR (
          v_next_followup_field_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM workspace_values v
            WHERE v.field_id = v_next_followup_field_id
              AND v.flow_run_id = r.id
              AND v.value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
              AND (p_next_followup_from IS NULL OR v.value_text >= p_next_followup_from)
              AND (p_next_followup_to IS NULL OR v.value_text < p_next_followup_to)
          )
        )
      )
      -- Hidden rows: the caller's hides are a visibility operation
      -- only — excluded here (rp NULL = never hidden), so they stay
      -- out of `total`, the page slice, and every view / filter /
      -- search combination. The underlying lead and flow-run rows
      -- are never touched.
      AND (rp.is_hidden IS NULL OR rp.is_hidden = FALSE)
  ),
  classified AS (
    SELECT
      b.*,
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN (b.reached_at IS NOT NULL)
        ELSE (b.status = 'completed')
      END AS is_completed,
      -- Real completion timestamp: custom-point reach time, else
      -- the END-completion timestamp. Used only by the completed
      -- view ordering below.
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN b.reached_at
        ELSE b.ended_at
      END AS completed_sort,
      -- Newest activity with submission fallback. Used only by
      -- the incomplete view ordering below.
      COALESCE(b.last_advanced_at, b.started_at) AS activity_sort
    FROM base b
  ),
  filtered AS (
    SELECT c.*
    FROM classified c
    WHERE p_view IS NULL OR p_view = 'all'
      OR (p_view = 'completed' AND c.is_completed)
      OR (p_view = 'incomplete' AND NOT c.is_completed)
  )
  SELECT jsonb_build_object(
    'flow', jsonb_build_object(
      'id', v_flow.id,
      'name', v_flow.name,
      'completion_node_id', v_flow.completion_node_id
    ),
    'total', (SELECT COUNT(*)::INT FROM filtered),
    'page', v_page,
    'page_size', v_page_size,
    'rows', COALESCE((
      SELECT jsonb_agg(
        row
        ORDER BY
          row_pinned DESC,
          CASE WHEN p_view = 'completed' THEN row_completed END DESC NULLS LAST,
          CASE WHEN p_view = 'incomplete' THEN row_activity END DESC NULLS LAST,
          CASE WHEN p_view NOT IN ('completed', 'incomplete') THEN row_started END DESC NULLS LAST,
          row_id DESC
      )
      FROM (
        SELECT jsonb_build_object(
          'run_id', f.run_id,
          'contact_id', f.contact_id,
          'contact_name', f.contact_name,
          'contact_phone', f.contact_phone,
          'conversation_id', f.conversation_id,
          'status', f.status,
          'started_at', f.started_at,
          'last_advanced_at', f.last_advanced_at,
          'ended_at', f.ended_at,
          'reached_at', f.reached_at,
          'is_completed', f.is_completed,
          'vars', COALESCE(f.vars, '{}'::JSONB)
        ) AS row,
        f.is_pinned AS row_pinned,
        f.completed_sort AS row_completed,
        f.activity_sort AS row_activity,
        f.started_at AS row_started,
        f.run_id AS row_id
        FROM filtered f
        ORDER BY
          f.is_pinned DESC,
          CASE WHEN p_view = 'completed' THEN f.completed_sort END DESC NULLS LAST,
          CASE WHEN p_view = 'incomplete' THEN f.activity_sort END DESC NULLS LAST,
          CASE WHEN p_view NOT IN ('completed', 'incomplete') THEN f.started_at END DESC NULLS LAST,
          f.run_id DESC
        LIMIT v_page_size OFFSET v_offset
      ) s
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
