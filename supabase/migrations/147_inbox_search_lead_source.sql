-- ============================================================
-- 147_inbox_search_lead_source.sql — Lead Source facet for Inbox search
--
-- Problem: the Inbox has no way to filter conversations by acquisition
-- source. Attribution already exists in the schema (verified read-only):
--   - Meta Instant Form: a processed row in meta_lead_submissions linked
--     by contact_id (one row per lead; repeat submissions from one
--     contact are separate rows; ingestion never touches contacts).
--   - CTWA: first-touch contacts.source_url / contacts.ctwa_clid stamped
--     by the WhatsApp webhook from message.referral (never overwritten).
-- Conversations themselves carry no source column, so the facet derives
-- both signals through the contact join the RPC already performs.
--
-- Fix: add ONE trailing parameter p_source (DEFAULT 'all', so every
-- existing caller keeps working unchanged) with four values:
--   - 'all'          — no source filtering (default).
--   - 'instant_form' — a processed Meta Instant Form submission is linked
--                      to the conversation's contact (EXISTS, dedup-safe:
--                      repeat submissions never duplicate the thread).
--   - 'ctwa'         — the contact carries valid CTWA attribution
--                      (non-blank source_url OR non-blank ctwa_clid) AND
--                      has NO processed Instant Form submission. Instant
--                      Form takes precedence: a dual-source contact is a
--                      Meta lead, excluded here even when CTWA fields are
--                      populated (metadata itself is never modified).
--   - 'other'        — NEITHER signal (NOT EXISTS + NOT valid-CTWA).
--
-- What is NOT changed: signature order of the 11 existing parameters
-- (p_source and p_form_id are appended last with defaults), all
-- existing facets (status/tags/company/flow/team/date), the text-match branches
-- (including the 085 messages EXISTS), ordering (last_message_at DESC
-- NULLS FIRST, id DESC), keyset pagination, response envelope,
-- SECURITY INVOKER, grants. Unknown p_source values match nothing
-- (fail-closed; the API route validates the enum strictly and 400s).
--
-- Scope notes:
--   - submissions are scoped to the account twice: through the contact
--     join (ct.account_id = v_account_id) AND an explicit
--     s.account_id = v_account_id predicate (defense in depth).
--   - RLS is unchanged: SECURITY INVOKER, so the caller's
--     meta_lead_submissions_select policy applies as before.
--   - EXISTS (never JOIN) keeps one row per conversation — pagination,
--     ordering, keyset cursor, and has_more behave exactly as in 078/085.
--
-- Performance: the facet reuses the existing contacts join (already
-- driven by idx_conversations_account_lastmsg) plus an EXISTS over
-- meta_lead_submissions keyed by contact_id. The submissions table
-- carries idx_meta_lead_submissions_account(account_id, created_at);
-- if the contact_id correlation ever shows up in query plans at scale,
-- add: CREATE INDEX ... ON meta_lead_submissions(contact_id)
--        WHERE status = 'processed';  (NOT created here — evaluate on
--        production plans first.)
--
-- Idempotent — safe to run multiple times. Do NOT edit 078/085.
-- ============================================================

-- Trigram support + message-content index (from 085, IF NOT EXISTS so
-- re-running is a no-op; kept here because the contract tests read the
-- latest inbox_search migration as the full statement of the RPC).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_messages_content_text_trgm
  ON messages USING gin (content_text gin_trgm_ops);

-- New 13-arg overload. The old 11-arg version is dropped first so
-- PostgREST never sees an ambiguous overload; all 11 existing
-- parameters keep their positions, types, and defaults. p_source and
-- p_form_id are appended last with defaults, so every existing caller
-- keeps working unchanged.
DROP FUNCTION IF EXISTS public.search_inbox_conversations(
  TEXT, TEXT, UUID[], TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, UUID, INT
);

DROP FUNCTION IF EXISTS public.search_inbox_conversations(
  TEXT, TEXT, UUID[], TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, UUID, INT, TEXT
);

CREATE FUNCTION public.search_inbox_conversations(
  p_search TEXT,
  p_status TEXT DEFAULT 'all',
  p_tag_ids UUID[] DEFAULT '{}',
  p_company TEXT DEFAULT NULL,
  p_flow_id TEXT DEFAULT NULL,
  p_member_ids TEXT[] DEFAULT '{}',
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_cur_ts TIMESTAMPTZ DEFAULT NULL,
  p_cur_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_source TEXT DEFAULT 'all',
  p_form_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_q TEXT;
  v_qesc TEXT;
  v_digits TEXT;
  v_limit INT;
  v_ids UUID[];
  v_has_more BOOLEAN;
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

  -- Empty queries match nothing (the client never sends them; this
  -- just makes the function total instead of surprising).
  v_q := btrim(COALESCE(p_search, ''));
  IF v_q = '' THEN
    RETURN jsonb_build_object('ids', '[]'::JSONB, 'has_more', false);
  END IF;

  -- Escape LIKE metacharacters so '+', '%', '_' etc. are literal.
  v_qesc := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  -- Digits-only form for phone_normalized (mirrors normalizePhone).
  v_digits := NULLIF(regexp_replace(v_q, '\D', '', 'g'), '');

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);

  WITH matches AS (
    SELECT c.id AS id, c.last_message_at AS last_message_at
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.account_id = v_account_id
      AND ct.account_id = v_account_id
      -- Status facet (mirrors the client filter exactly).
      AND (
        p_status IS NULL OR p_status = 'all'
        OR (p_status = 'unread' AND c.unread_count > 0)
        OR (p_status <> 'unread' AND p_status <> 'all' AND c.status = p_status)
      )
      -- Tags facet (OR across ids).
      AND (
        COALESCE(cardinality(p_tag_ids), 0) = 0
        OR EXISTS (
          SELECT 1 FROM contact_tags t
          WHERE t.contact_id = c.contact_id
            AND t.tag_id = ANY (p_tag_ids)
        )
      )
      -- Company facet (client compares trimmed contact company).
      AND (p_company IS NULL OR btrim(ct.company) = p_company)
      -- Flow facet (same resolution as pickContactFlowRun).
      AND (
        p_flow_id IS NULL
        OR COALESCE(
          (
            SELECT r.flow_id
            FROM flow_runs r
            JOIN flows f ON f.id = r.flow_id
            WHERE r.account_id = v_account_id
              AND f.account_id = v_account_id
              AND r.conversation_id = c.id
            ORDER BY (r.status = 'active') DESC, r.started_at DESC, r.id DESC
            LIMIT 1
          ),
          (
            SELECT r.flow_id
            FROM flow_runs r
            JOIN flows f ON f.id = r.flow_id
            WHERE r.account_id = v_account_id
              AND f.account_id = v_account_id
              AND r.contact_id = c.contact_id
            ORDER BY (r.status = 'active') DESC, r.started_at DESC, r.id DESC
            LIMIT 1
          )
        ) IS NOT DISTINCT FROM CASE
          WHEN p_flow_id = '__no_flow__' THEN NULL::UUID
          ELSE p_flow_id::UUID
        END
      )
      -- Team facet ('unassigned' member = NULL agent).
      AND (
        COALESCE(cardinality(p_member_ids), 0) = 0
        OR c.assigned_agent_id::TEXT = ANY (p_member_ids)
        OR ('unassigned' = ANY (p_member_ids) AND c.assigned_agent_id IS NULL)
      )
      -- Date facet (inclusive both ends, like the client range).
      AND (p_from IS NULL OR c.last_message_at >= p_from)
      AND (p_to IS NULL OR c.last_message_at <= p_to)
      -- Lead Source facet (mirrors matchesLeadSource in
      -- src/lib/inbox/conversations.ts exactly). Instant Form takes
      -- precedence: dual-signal threads match instant_form only, never
      -- ctwa. EXISTS (never JOIN) keeps one row per conversation.
      AND (
        p_source IS NULL OR p_source = 'all'
        OR (
          p_source = 'instant_form'
          AND EXISTS (
            SELECT 1 FROM meta_lead_submissions s
            WHERE s.account_id = v_account_id
              AND s.contact_id = c.contact_id
              AND s.status = 'processed'
          )
        )
        OR (
          p_source = 'ctwa'
          AND NOT EXISTS (
            SELECT 1 FROM meta_lead_submissions s
            WHERE s.account_id = v_account_id
              AND s.contact_id = c.contact_id
              AND s.status = 'processed'
          )
          AND (
            (ct.source_url IS NOT NULL AND btrim(ct.source_url) <> '')
            OR (ct.ctwa_clid IS NOT NULL AND btrim(ct.ctwa_clid) <> '')
          )
        )
        OR (
          p_source = 'other'
          AND NOT EXISTS (
            SELECT 1 FROM meta_lead_submissions s
            WHERE s.account_id = v_account_id
              AND s.contact_id = c.contact_id
              AND s.status = 'processed'
          )
          AND NOT (
            (ct.source_url IS NOT NULL AND btrim(ct.source_url) <> '')
            OR (ct.ctwa_clid IS NOT NULL AND btrim(ct.ctwa_clid) <> '')
          )
        )
      )
      -- Meta Form facet (the API sends p_form_id only when
      -- source=instant_form with a specific form selected; All Forms
      -- sends NULL and disables it). The contact must have a
      -- processed submission carrying this exact form id. EXISTS,
      -- never JOIN, so one conversation yields one row.
      AND (
        p_form_id IS NULL
        OR EXISTS (
          SELECT 1 FROM meta_lead_submissions s
          WHERE s.account_id = v_account_id
            AND s.contact_id = c.contact_id
            AND s.status = 'processed'
            AND s.form_id = p_form_id
        )
      )
      -- Text match: name / raw phone / normalized phone / last message /
      -- ANY historical message. The messages branch is EXISTS (never a
      -- join), so one conversation yields one row no matter how many of
      -- its messages match. Scoping rides on m.conversation_id = c.id:
      -- the outer c.account_id filter already owns the conversation,
      -- and messages carries no account_id of its own.
      AND (
        c.last_message_text ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR ct.name ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR ct.phone ILIKE '%' || v_qesc || '%' ESCAPE '\'
        OR (
          v_digits IS NOT NULL
          AND ct.phone_normalized ILIKE '%' || v_digits || '%' ESCAPE '\'
        )
        OR EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
            AND m.content_text ILIKE '%' || v_qesc || '%' ESCAPE '\'
        )
      )
      -- Keyset: strictly past the cursor under
      -- (last_message_at DESC NULLS FIRST, id DESC).
      AND (
        p_cur_id IS NULL
        OR (p_cur_ts IS NULL AND c.last_message_at IS NULL AND c.id < p_cur_id)
        OR (c.last_message_at < p_cur_ts)
        OR (c.last_message_at = p_cur_ts AND c.id < p_cur_id)
      )
    ORDER BY c.last_message_at DESC NULLS FIRST, c.id DESC
    LIMIT v_limit + 1
  )
  SELECT
    COALESCE(
      array_agg(s.id ORDER BY s.last_message_at DESC NULLS FIRST, s.id DESC),
      '{}'
    ),
    COUNT(*) > v_limit
  INTO v_ids, v_has_more
  FROM matches s;

  -- Trim the over-fetched probe row; the array is already ordered.
  IF v_has_more THEN
    v_ids := v_ids[1:v_limit];
  END IF;

  RETURN jsonb_build_object(
    'ids', COALESCE(to_jsonb(v_ids), '[]'::JSONB),
    'has_more', v_has_more
  );
END;
$$;

ALTER FUNCTION public.search_inbox_conversations(
  TEXT, TEXT, UUID[], TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, UUID, INT, TEXT, TEXT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.search_inbox_conversations(
  TEXT, TEXT, UUID[], TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, UUID, INT, TEXT, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.search_inbox_conversations(
  TEXT, TEXT, UUID[], TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, UUID, INT, TEXT, TEXT
) TO authenticated;
