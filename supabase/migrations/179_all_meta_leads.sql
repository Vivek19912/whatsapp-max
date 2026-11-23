-- ============================================================
-- 179_all_meta_leads.sql — virtual All Meta Leads combined view.
--
-- Adds ONLY the supporting read path for the All Meta Leads Workspace
-- table (one virtual table combining every Meta Lead Ads Instant Form
-- table for the account). No data rewrites, no ingestion changes, no
-- existing table modifications:
--
--   1. Composite index flow_runs(account_id, started_at DESC) —
--      the All-view orders across ALL of an account's Meta flows by
--      Submission Time (flow_runs.started_at DESC, run_id DESC
--      tiebreak). Existing indexes cover per-flow (flow_id, started)
--      and account-only lookups; this covers the cross-flow account
--      ordering the new view pages over. Verified necessary for the
--      new RPC's ORDER BY; harmless for existing reads.
--
--   2. get_all_meta_leads() RPC — one paginated, server-filtered read
--      over the EXISTING canonical source (meta_lead_submissions JOIN
--      flow_runs + contacts + flows), never duplicating leads:
--        - one row per (account_id, meta_lead_id): submissions UNIQUE
--          guarantees it; DISTINCT ON defends against any legacy
--          duplicate, keeping the newest processed row;
--        - only status = 'processed' with a LIVE flow_run_id
--          (INNER JOIN flow_runs excludes NULL/deleted runs; failed /
--          ignored never surface as separate rows);
--        - includes EVERY Meta flow for the account (hidden + disabled
--          forms contribute historical leads; nothing is deleted or
--          modified);
--        - dummy test leads stay visible (no dummy exclusion here —
--          dashboard-only exclusions never apply to this Workspace view);
--        - SECURITY INVOKER, account from auth.uid(), flow must belong
--          to that account; all value lookups run under the caller's
--          RLS so cross-tenant ids match zero rows.
--
-- Filters (all OPTIONAL, DEFAULT NULL = inactive, AND-combined):
--   p_search        — name, phone, Meta Lead ID, form answer text
--                     (contacts.name/phone ILIKE, submissions.meta_lead_id
--                     ILIKE, flow_runs.vars::text ILIKE, submissions.answers
--                     ::text ILIKE). Escaped like get_flow_table_rows.
--   p_started_from/to — half-open [from, to) over Submission Time.
--   p_assignee      — all | unassigned | <member user_id> over this
--                     run's OWN flow Assigned To column (matched by
--                     stable ID equality, per-flow field resolution by
--                     case-insensitive name — unknown ids match zero rows).
--   p_flow_id       — single originating-table filter (NULL = all tables).
--   p_stage[]       — stored Stage value equals ANY listed (OR within).
--   p_lead_type[]   — stored Lead Type value equals ANY listed.
--   p_call_status[] / p_followup_status[] — same OR rule over the
--                     canonical business columns (missing column + active
--                     filter matches zero rows, never errors).
--
-- Ordering: started_at DESC, run_id DESC (same as the `all` view).
-- Pagination applies AFTER every predicate, keeping total + row
-- numbering correct. Pin/hide are per-flow prefs and are NOT applied
-- here (the combined view shows every processed lead once).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Cross-flow account ordering for the combined view.
CREATE INDEX IF NOT EXISTS idx_flow_runs_account_started
  ON public.flow_runs(account_id, started_at DESC);

-- 2. Combined read.
CREATE OR REPLACE FUNCTION public.get_all_meta_leads(
  p_search TEXT DEFAULT NULL,
  p_page INT DEFAULT 0,
  p_page_size INT DEFAULT 25,
  p_started_from TIMESTAMPTZ DEFAULT NULL,
  p_started_to TIMESTAMPTZ DEFAULT NULL,
  p_assignee TEXT DEFAULT NULL,
  p_flow_id UUID DEFAULT NULL,
  p_stage TEXT[] DEFAULT NULL,
  p_lead_type TEXT[] DEFAULT NULL,
  p_call_status TEXT[] DEFAULT NULL,
  p_followup_status TEXT[] DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_page INT := GREATEST(COALESCE(p_page, 0), 0);
  v_page_size INT := LEAST(GREATEST(COALESCE(p_page_size, 25), 1), 100);
  v_offset INT;
  v_search TEXT := NULLIF(BTRIM(COALESCE(p_search, '')), '');
  v_assignee TEXT := NULLIF(BTRIM(COALESCE(p_assignee, '')), '');
  v_stage TEXT[] := CASE WHEN COALESCE(cardinality(p_stage), 0) = 0 THEN NULL ELSE p_stage END;
  v_lead_type TEXT[] := CASE WHEN COALESCE(cardinality(p_lead_type), 0) = 0 THEN NULL ELSE p_lead_type END;
  v_call_status TEXT[] := CASE WHEN COALESCE(cardinality(p_call_status), 0) = 0 THEN NULL ELSE p_call_status END;
  v_followup_status TEXT[] := CASE WHEN COALESCE(cardinality(p_followup_status), 0) = 0 THEN NULL ELSE p_followup_status END;
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

  v_offset := v_page * v_page_size;

  WITH base AS (
    SELECT DISTINCT ON (s.meta_lead_id)
      s.meta_lead_id AS meta_lead_id,
      s.form_id AS submission_form_id,
      s.form_name AS submission_form_name,
      s.ad_id AS ad_id,
      s.ad_name AS ad_name,
      s.campaign_name AS campaign_name,
      s.is_organic AS is_organic,
      s.meta_created_time AS meta_created_time,
      s.answers AS submission_answers,
      s.status AS submission_status,
      s.flow_run_id AS submission_run_id,
      r.id AS run_id,
      r.flow_id AS flow_id,
      f.name AS flow_name,
      f.meta_form_id AS meta_form_db_id,
      r.contact_id AS contact_id,
      c.name AS contact_name,
      c.phone AS contact_phone,
      r.conversation_id AS conversation_id,
      r.status AS run_status,
      r.started_at AS started_at,
      r.last_advanced_at AS last_advanced_at,
      r.ended_at AS ended_at,
      r.vars AS vars,
      -- Assigned marker for the KPI card (same per-flow Assigned To
      -- resolution as the assignee filter, evaluated per row).
      EXISTS (
        SELECT 1
        FROM workspace_fields wf
        JOIN workspace_values v ON v.field_id = wf.id AND v.flow_run_id = r.id
        WHERE wf.flow_id = r.flow_id
          AND lower(btrim(wf.name)) = 'assigned to'
          AND v.value_text IS NOT NULL
          AND btrim(v.value_text) <> ''
          AND v.value_text <> 'Unassigned'
      ) AS is_assigned
    FROM meta_lead_submissions s
    JOIN flow_runs r
      ON r.id = s.flow_run_id
     AND r.account_id = v_account_id
    JOIN flows f
      ON f.id = r.flow_id
     AND f.account_id = v_account_id
     AND f.kind = 'meta_lead_ads'
    LEFT JOIN contacts c ON c.id = r.contact_id
    WHERE s.account_id = v_account_id
      AND s.status = 'processed'
      AND (p_flow_id IS NULL OR r.flow_id = p_flow_id)
      AND (p_started_from IS NULL OR r.started_at >= p_started_from)
      AND (p_started_to IS NULL OR r.started_at < p_started_to)
      AND (
        v_search IS NULL
        OR c.name ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR c.phone ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR s.meta_lead_id ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR r.vars::text ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR s.answers::text ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
      -- Assignee: this run's OWN flow Assigned To column (same rule as
      -- get_flow_table_rows 094, but resolved per-row by flow_id so a
      -- combined view across flows stays correct).
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
      -- Stage filter (stored Stage value equals ANY listed).
      AND (
        v_stage IS NULL
        OR EXISTS (
          SELECT 1
          FROM workspace_fields wf
          JOIN workspace_values v ON v.field_id = wf.id AND v.flow_run_id = r.id
          WHERE wf.flow_id = r.flow_id
            AND lower(btrim(wf.name)) = 'stage'
            AND v.value_text = ANY(v_stage)
        )
      )
      -- Lead Type filter (stored Lead Type value equals ANY listed).
      AND (
        v_lead_type IS NULL
        OR EXISTS (
          SELECT 1
          FROM workspace_fields wf
          JOIN workspace_values v ON v.field_id = wf.id AND v.flow_run_id = r.id
          WHERE wf.flow_id = r.flow_id
            AND lower(btrim(wf.name)) = 'lead type'
            AND v.value_text = ANY(v_lead_type)
        )
      )
      -- Call Status filter.
      AND (
        v_call_status IS NULL
        OR EXISTS (
          SELECT 1
          FROM workspace_fields wf
          JOIN workspace_values v ON v.field_id = wf.id AND v.flow_run_id = r.id
          WHERE wf.flow_id = r.flow_id
            AND lower(btrim(wf.name)) = 'call status'
            AND v.value_text = ANY(v_call_status)
        )
      )
      -- Follow-Up Status filter.
      AND (
        v_followup_status IS NULL
        OR EXISTS (
          SELECT 1
          FROM workspace_fields wf
          JOIN workspace_values v ON v.field_id = wf.id AND v.flow_run_id = r.id
          WHERE wf.flow_id = r.flow_id
            AND lower(btrim(wf.name)) = 'follow-up status'
            AND v.value_text = ANY(v_followup_status)
        )
      )
    ORDER BY s.meta_lead_id, s.processed_at DESC NULLS LAST, s.created_at DESC, r.started_at DESC
  ),
  ordered AS (
    SELECT b.*
    FROM base b
    ORDER BY b.started_at DESC, b.run_id DESC
  )
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*)::INT FROM base),
    'assigned_total', (SELECT COUNT(*)::INT FROM base WHERE is_assigned),
    'page', v_page,
    'page_size', v_page_size,
    'rows', COALESCE((
      SELECT jsonb_agg(row ORDER BY row_started DESC, row_id DESC)
      FROM (
        SELECT jsonb_build_object(
          'meta_lead_id', f.meta_lead_id,
          'submission_form_id', f.submission_form_id,
          'submission_form_name', f.submission_form_name,
          'ad_id', f.ad_id,
          'ad_name', f.ad_name,
          'campaign_name', f.campaign_name,
          'is_organic', f.is_organic,
          'meta_created_time', f.meta_created_time,
          'submission_answers', COALESCE(f.submission_answers, '{}'::JSONB),
          'run_id', f.run_id,
          'flow_id', f.flow_id,
          'flow_name', f.flow_name,
          'meta_form_db_id', f.meta_form_db_id,
          'contact_id', f.contact_id,
          'contact_name', f.contact_name,
          'contact_phone', f.contact_phone,
          'conversation_id', f.conversation_id,
          'run_status', f.run_status,
          'started_at', f.started_at,
          'last_advanced_at', f.last_advanced_at,
          'ended_at', f.ended_at,
          'vars', COALESCE(f.vars, '{}'::JSONB)
        ) AS row,
        f.started_at AS row_started,
        f.run_id AS row_id
        FROM ordered f
        LIMIT v_page_size OFFSET v_offset
      ) s
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
