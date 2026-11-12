-- ============================================================
-- 166_call_dashboard_filters.sql — Calls dashboard filter parity
-- with the Recordings page.
--
-- The redesigned /calls dashboard reuses the Recordings filter set
-- (search text, call type, workspace table, lead status) in
-- addition to user + direction. This migration extends the two
-- existing exact aggregates and adds one per-salesperson
-- aggregate so every dashboard number stays a single indexed
-- server-side scan with no row cap:
--
-- * call_kpis_summary: new optional predicates (call type with the
--   same whatsapp/whatsapp_business merge as the Recordings list,
--   contact-id set from search/workspace-table resolution, digit
--   phone match, linked/unlinked lead status) plus phone /
--   whatsapp / whatsappBusiness breakdown outputs.
-- * call_event_outcomes_summary: answered + unknown outputs
--   alongside missed/rejected, plus the same contact/phone/status
--   scoping. Events are phone-only, so a non-phone call-type
--   filter matches nothing here (mirrors the documented
--   outgoing-direction behavior of yielding zero).
-- * call_salesperson_stats (new): per-user recordings + events in
--   one scan each, FULL OUTER JOINed so a user with only one kind
--   still appears. Powers the Salesperson Performance table and
--   its answer rate (answered / (answered + missed)).
--
-- All new parameters default to NULL (no constraint) and every
-- new output is additive — existing callers and the
-- /api/recordings summary path are untouched. SECURITY INVOKER +
-- is_account_member + GRANT TO authenticated follow the existing
-- call_* RPC convention (migrations 109/111/115). UUID arrays
-- mirror the Recordings list semantics: NULL = no constraint,
-- empty array = match nothing, NULL contact_id never matches IN.
-- ============================================================

CREATE OR REPLACE FUNCTION public.call_kpis_summary(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_uploaded_by UUID DEFAULT NULL,
  p_direction TEXT DEFAULT NULL,
  p_call_type TEXT DEFAULT NULL,
  p_contact_ids UUID[] DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_account_id IS NULL OR NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'total', COUNT(*),
    'durationSecs', SUM(duration_seconds),
    'incoming', COUNT(*) FILTER (WHERE direction = 'in'),
    'incomingDurationSecs', SUM(duration_seconds) FILTER (WHERE direction = 'in'),
    'outgoing', COUNT(*) FILTER (WHERE direction = 'out'),
    'outgoingDurationSecs', SUM(duration_seconds) FILTER (WHERE direction = 'out'),
    'phone', COUNT(*) FILTER (WHERE call_type = 'phone'),
    'whatsapp', COUNT(*) FILTER (WHERE call_type IN ('whatsapp', 'whatsapp_business')),
    'whatsappBusiness', COUNT(*) FILTER (WHERE call_type = 'whatsapp_business')
  )
  INTO v_result
  FROM call_recordings
  WHERE account_id = p_account_id
    AND (p_uploaded_by IS NULL OR uploaded_by = p_uploaded_by)
    AND (
      p_direction IS NULL
      OR (p_direction = 'unknown' AND direction IS NULL)
      OR direction = p_direction
    )
    AND (
      p_call_type IS NULL
      OR call_type = p_call_type
      OR (p_call_type = 'whatsapp' AND call_type = 'whatsapp_business')
    )
    AND (p_contact_ids IS NULL OR contact_id = ANY(p_contact_ids))
    AND (p_phone IS NULL OR phone_number ILIKE '%' || p_phone || '%')
    AND (
      p_status IS NULL
      OR (p_status = 'linked' AND contact_id IS NOT NULL)
      OR (p_status = 'unlinked' AND contact_id IS NULL)
    )
    AND (
      (recorded_at >= p_from AND recorded_at < p_to)
      OR (recorded_at IS NULL AND created_at >= p_from AND created_at < p_to)
    );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_kpis_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.call_event_outcomes_summary(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_user_id UUID DEFAULT NULL,
  p_direction TEXT DEFAULT NULL,
  p_contact_ids UUID[] DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_call_type TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_account_id IS NULL OR NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'missed', COUNT(*) FILTER (WHERE outcome = 'missed'),
    'rejected', COUNT(*) FILTER (WHERE outcome = 'rejected'),
    'answered', COUNT(*) FILTER (WHERE outcome = 'answered'),
    'unknown', COUNT(*) FILTER (WHERE outcome = 'unknown')
  )
  INTO v_result
  FROM call_events
  WHERE account_id = p_account_id
    AND (p_user_id IS NULL OR user_id = p_user_id)
    AND (
      p_direction IS NULL
      OR (p_direction = 'unknown' AND direction IS NULL)
      OR direction = p_direction
    )
    AND (p_call_type IS NULL OR p_call_type = 'phone')
    AND (p_contact_ids IS NULL OR contact_id = ANY(p_contact_ids))
    AND (p_phone IS NULL OR phone_number ILIKE '%' || p_phone || '%')
    AND (
      p_status IS NULL
      OR (p_status = 'linked' AND contact_id IS NOT NULL)
      OR (p_status = 'unlinked' AND contact_id IS NULL)
    )
    AND occurred_at >= p_from
    AND occurred_at < p_to;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_event_outcomes_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, UUID[], TEXT, TEXT, TEXT) TO authenticated;

-- Per-salesperson volume + outcomes for the Salesperson Performance
-- table. Recordings (uploaded_by) and events (user_id) live in
-- different tables with different owner columns, so each side
-- aggregates separately and the join is a FULL OUTER JOIN on the
-- user id — a salesperson with only recordings or only events
-- still gets a row. NULL owners are never attributed. Answer rate
-- is derived client-side as answered / (answered + missed).
CREATE OR REPLACE FUNCTION public.call_salesperson_stats(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_user_id UUID DEFAULT NULL,
  p_direction TEXT DEFAULT NULL,
  p_call_type TEXT DEFAULT NULL,
  p_contact_ids UUID[] DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL
) RETURNS TABLE (
  user_id UUID,
  recordings BIGINT,
  duration_secs BIGINT,
  answered BIGINT,
  missed BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_account_id IS NULL OR NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH rec AS (
    SELECT
      r.uploaded_by AS u,
      COUNT(*)::BIGINT AS c,
      COALESCE(SUM(r.duration_seconds), 0)::BIGINT AS d
    FROM call_recordings AS r
    WHERE r.account_id = p_account_id
      AND (p_user_id IS NULL OR r.uploaded_by = p_user_id)
      AND (
        p_direction IS NULL
        OR (p_direction = 'unknown' AND r.direction IS NULL)
        OR r.direction = p_direction
      )
      AND (
        p_call_type IS NULL
        OR r.call_type = p_call_type
        OR (p_call_type = 'whatsapp' AND r.call_type = 'whatsapp_business')
      )
      AND (p_contact_ids IS NULL OR r.contact_id = ANY(p_contact_ids))
      AND (p_phone IS NULL OR r.phone_number ILIKE '%' || p_phone || '%')
      AND (
        p_status IS NULL
        OR (p_status = 'linked' AND r.contact_id IS NOT NULL)
        OR (p_status = 'unlinked' AND r.contact_id IS NULL)
      )
      AND (
        (r.recorded_at >= p_from AND r.recorded_at < p_to)
        OR (r.recorded_at IS NULL AND r.created_at >= p_from AND r.created_at < p_to)
      )
      AND r.uploaded_by IS NOT NULL
    GROUP BY r.uploaded_by
  ),
  ev AS (
    SELECT
      e.user_id AS u,
      COUNT(*) FILTER (WHERE e.outcome = 'answered')::BIGINT AS a,
      COUNT(*) FILTER (WHERE e.outcome = 'missed')::BIGINT AS m
    FROM call_events AS e
    WHERE e.account_id = p_account_id
      AND (p_user_id IS NULL OR e.user_id = p_user_id)
      AND (
        p_direction IS NULL
        OR (p_direction = 'unknown' AND e.direction IS NULL)
        OR e.direction = p_direction
      )
      AND (p_call_type IS NULL OR p_call_type = 'phone')
      AND (p_contact_ids IS NULL OR e.contact_id = ANY(p_contact_ids))
      AND (p_phone IS NULL OR e.phone_number ILIKE '%' || p_phone || '%')
      AND (
        p_status IS NULL
        OR (p_status = 'linked' AND e.contact_id IS NOT NULL)
        OR (p_status = 'unlinked' AND e.contact_id IS NULL)
      )
      AND e.occurred_at >= p_from
      AND e.occurred_at < p_to
      AND e.user_id IS NOT NULL
    GROUP BY e.user_id
  )
  SELECT
    COALESCE(rec.u, ev.u) AS user_id,
    COALESCE(rec.c, 0) AS recordings,
    COALESCE(rec.d, 0) AS duration_secs,
    COALESCE(ev.a, 0) AS answered,
    COALESCE(ev.m, 0) AS missed
  FROM rec
  FULL OUTER JOIN ev ON rec.u = ev.u
  WHERE COALESCE(rec.u, ev.u) IS NOT NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_salesperson_stats(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT, TEXT) TO authenticated;
