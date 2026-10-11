-- ============================================================
-- 115_call_recordings_summary_whatsapp_merge.sql — merged
-- WhatsApp reporting category for GET /api/recordings?summary=1.
--
-- Reporting rule: `whatsapp` and `whatsapp_business` are ONE
-- user-facing category ("WhatsApp"). The stored values stay
-- distinct (recording authorization depends on the difference),
-- so this changes only aggregation semantics, never data.
--
-- Changes vs migration 108 (same function name + signature,
-- CREATE OR REPLACE — the established pattern for evolving
-- read-model RPCs):
--   p_call_type 'whatsapp' (or legacy 'whatsapp_business')
--     matches BOTH stored values, so a WhatsApp-filtered summary
--     counts whatsapp + whatsapp_business together — exactly what
--     the filtered list endpoint returns for the same filter.
--   The 'whatsapp' output key is the combined count. The
--     'whatsappBusiness' key is retained for transport
--     compatibility; the route folds it into 'whatsapp'.
--
-- Security, grants, and all other predicates: unchanged from 108.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.call_recordings_summary(
  p_account_id UUID,
  p_contact_id UUID DEFAULT NULL,
  p_contact_ids UUID[] DEFAULT NULL,
  p_digits TEXT DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_call_type TEXT DEFAULT NULL,
  p_direction TEXT DEFAULT NULL,
  p_uploaded_by UUID DEFAULT NULL,
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
    'totalDurationSecs', COALESCE(SUM(duration_seconds), 0),
    'phone', COUNT(*) FILTER (WHERE call_type = 'phone'),
    'whatsapp', COUNT(*) FILTER (WHERE call_type IN ('whatsapp', 'whatsapp_business')),
    'whatsappBusiness', COUNT(*) FILTER (WHERE call_type = 'whatsapp_business'),
    'unlinked', COUNT(*) FILTER (WHERE contact_id IS NULL)
  )
  INTO v_result
  FROM call_recordings
  WHERE account_id = p_account_id
    AND (p_contact_id IS NULL OR contact_id = p_contact_id)
    AND (
      p_call_type IS NULL
      OR (p_call_type = 'phone' AND call_type = 'phone')
      OR (
        p_call_type IN ('whatsapp', 'whatsapp_business')
        AND call_type IN ('whatsapp', 'whatsapp_business')
      )
    )
    AND (
      p_direction IS NULL
      OR (p_direction IN ('in', 'out') AND direction = p_direction)
      OR (p_direction = 'unknown' AND direction IS NULL)
    )
    AND (p_uploaded_by IS NULL OR uploaded_by = p_uploaded_by)
    AND (
      p_status IS NULL
      OR (p_status = 'linked' AND contact_id IS NOT NULL)
      OR (p_status = 'unlinked' AND contact_id IS NULL)
    )
    AND (
      p_from IS NULL OR p_to IS NULL
      OR (
        (recorded_at >= p_from AND recorded_at < p_to)
        OR (recorded_at IS NULL AND created_at >= p_from AND created_at < p_to)
      )
    )
    AND (
      p_contact_ids IS NULL AND p_digits IS NULL
      OR (
        (p_contact_ids IS NOT NULL AND contact_id = ANY (p_contact_ids))
        OR (p_digits IS NOT NULL AND phone_number ILIKE '%' || p_digits || '%')
      )
    );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_recordings_summary(
  UUID, UUID, UUID[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) TO authenticated;
