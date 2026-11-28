-- ============================================================
-- 186_meta_export_form_counts.sql — per-form lead counts for the
-- Meta Lead Ads Excel export dialog.
--
-- Adds ONE read-only aggregate:
--
--   get_meta_export_form_counts(
--     p_started_from TIMESTAMPTZ, p_started_to TIMESTAMPTZ,
--     p_assignee TEXT, p_flow_id UUID
--   ) RETURNS JSONB { all: INT, forms: [{flow_id, count}] }
--
--   - Counts the EXACT same canonical set the export reads
--     (meta_lead_submissions JOIN flow_runs + flows, processed
--     only, live run, meta_lead_ads kind, DISTINCT ON meta_lead_id
--     so legacy duplicates never double-count).
--   - Same Submission Time semantics as the export (half-open
--     [from, to) over flow_runs.started_at) and the same per-row
--     Assigned-To resolution as get_all_meta_leads (179/180).
--   - No rows are returned — only integers — so the dialog can
--     show "N total · M matching" without downloading records.
--   - The route calls it twice (once unfiltered for totals, once
--     with the dialog's date + assignee for matching): O(1)
--     round-trips no matter how many forms exist, never N+1.
--
-- Security: unchanged (SECURITY INVOKER, account from auth.uid(),
-- flow must belong to that account, value lookups under the
-- caller's RLS). Restricted-agent narrowing happens in the API
-- (forced own assignee + visible-form intersection), never here.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_meta_export_form_counts(
  p_started_from TIMESTAMPTZ DEFAULT NULL,
  p_started_to TIMESTAMPTZ DEFAULT NULL,
  p_assignee TEXT DEFAULT NULL,
  p_flow_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_assignee TEXT := NULLIF(BTRIM(COALESCE(p_assignee, '')), '');
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

  WITH base AS (
    SELECT DISTINCT ON (s.meta_lead_id)
      s.meta_lead_id AS meta_lead_id,
      r.flow_id AS flow_id
    FROM meta_lead_submissions s
    JOIN flow_runs r
      ON r.id = s.flow_run_id
     AND r.account_id = v_account_id
    JOIN flows f
      ON f.id = r.flow_id
     AND f.account_id = v_account_id
     AND f.kind = 'meta_lead_ads'
    WHERE s.account_id = v_account_id
      AND s.status = 'processed'
      AND (p_flow_id IS NULL OR r.flow_id = p_flow_id)
      AND (p_started_from IS NULL OR r.started_at >= p_started_from)
      AND (p_started_to IS NULL OR r.started_at < p_started_to)
      -- Assignee: this run's OWN flow Assigned To column (same
      -- per-row, per-flow resolution as get_all_meta_leads, so
      -- counts and the export can never disagree).
      AND (
        v_assignee IS NULL OR lower(v_assignee) = 'all'
        OR (
          lower(v_assignee) = 'unassigned'
          AND NOT EXISTS (
            SELECT 1
            FROM workspace_fields wf
            JOIN workspace_values v ON v.field_id = wf.id AND v.flow_run_id = r.id
            WHERE wf.flow_id = r.flow_id
              AND lower(btrim(wf.name)) = 'assigned to'
              AND v.value_text IS NOT NULL
              AND btrim(v.value_text) <> ''
              AND v.value_text <> 'Unassigned'
          )
        )
        OR EXISTS (
          SELECT 1
          FROM workspace_fields wf
          JOIN workspace_values v ON v.field_id = wf.id AND v.flow_run_id = r.id
          WHERE wf.flow_id = r.flow_id
            AND lower(btrim(wf.name)) = 'assigned to'
            AND lower(v_assignee) NOT IN ('all', 'unassigned')
            AND v.value_text = v_assignee
        )
      )
    ORDER BY s.meta_lead_id, s.processed_at DESC NULLS LAST, s.created_at DESC, r.started_at DESC
  ),
  per_flow AS (
    SELECT flow_id, COUNT(*)::INT AS count
    FROM base
    GROUP BY flow_id
  )
  SELECT jsonb_build_object(
    'all', (SELECT COUNT(*)::INT FROM base),
    'forms', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('flow_id', flow_id, 'count', count)
        ORDER BY flow_id
      )
      FROM per_flow
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
