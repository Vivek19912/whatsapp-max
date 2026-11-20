-- ============================================================
-- 173_meta_lead_phone_guard.sql — block scheduling follow-up
-- reminders to Meta Lead Ads customer numbers.
--
-- Follow-up reminders must go to a team member's WhatsApp number,
-- never to a lead. This additive, read-only helper backs the
-- server-side guard in POST /api/flows/[id]/followup-reminder and
-- POST /api/followups: given digits-only normalized input, it
-- reports whether the number belongs to any Meta Lead Ads lead of
-- the caller's account.
--
-- Coverage (account-scoped, all tables, hidden/disabled/history
-- included — no form or status filter, no single-table limit):
--   * meta_lead_submissions.answers phone keys (the ingestion
--     source; normalize.ts PHONE_KEYS). Historical rows from
--     disabled forms remain stored and are covered.
--   * contacts.phone, but ONLY for contacts with Meta provenance
--     (linked from the account's submissions or Meta flow runs) —
--     a manually added contact sharing no Meta lead is unaffected.
--
-- Matching is exact, never fuzzy: digits-only equality, plus the
-- India 10-digit national form (91 prefix) so +91 / spaces /
-- hyphens variants of the same number match. No substring or
-- last-N-digits matching that could block unrelated numbers.
--
-- No writes anywhere: no DELETE/UPDATE/INSERT. RLS posture mirrors
-- the analytics RPCs: SECURITY INVOKER, account derived from
-- auth.uid(), authenticated-only grant.
--
-- Idempotent — safe to run multiple times. LOCAL ONLY: do not
-- apply in production without explicit instruction.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_meta_lead_phone(p_digits TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_found BOOLEAN := FALSE;
BEGIN
  -- Caller must be authenticated and linked to an account.
  IF auth.uid() IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT p.account_id INTO v_account_id
  FROM profiles p
  WHERE p.user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Only digits are meaningful; anything else cannot match.
  IF p_digits IS NULL OR p_digits !~ '^\d{11,15}$' THEN
    RETURN FALSE;
  END IF;

  -- 1. Ingestion answers (every Meta submission, any form/status).
  SELECT EXISTS (
    SELECT 1 FROM meta_lead_submissions s
    WHERE s.account_id = v_account_id
      AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          s.answers ->> 'phone_number',
          s.answers ->> 'phone',
          s.answers ->> 'mobile',
          s.answers ->> 'mobile_number',
          s.answers ->> 'whatsapp_number'
        ]) AS v
        WHERE v IS NOT NULL AND (
          regexp_replace(v, '\D', '', 'g') = p_digits
          OR (
            char_length(regexp_replace(v, '\D', '', 'g')) = 10
            AND '91' || regexp_replace(v, '\D', '', 'g') = p_digits
          )
        )
      )
  ) INTO v_found;
  IF v_found THEN
    RETURN TRUE;
  END IF;

  -- 2. Contacts with Meta provenance only.
  SELECT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.account_id = v_account_id
      AND (
        regexp_replace(c.phone, '\D', '', 'g') = p_digits
        OR (
          char_length(regexp_replace(c.phone, '\D', '', 'g')) = 10
          AND '91' || regexp_replace(c.phone, '\D', '', 'g') = p_digits
        )
      )
      AND (
        EXISTS (
          SELECT 1 FROM meta_lead_submissions s2
          WHERE s2.account_id = v_account_id
            AND s2.contact_id = c.id
        )
        OR EXISTS (
          SELECT 1 FROM flow_runs r
          JOIN flows f ON f.id = r.flow_id
          WHERE r.account_id = v_account_id
            AND f.account_id = v_account_id
            AND f.kind = 'meta_lead_ads'
            AND r.contact_id = c.id
        )
      )
  ) INTO v_found;
  RETURN v_found;
END;
$$;

ALTER FUNCTION public.is_meta_lead_phone(TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.is_meta_lead_phone(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_meta_lead_phone(TEXT) TO authenticated;
