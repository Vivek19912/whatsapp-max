-- ============================================================
-- 185_meta_crm_event_claims.sql — atomic cross-table duplicate
-- prevention WITHOUT touching historical CRM events.
--
-- Problem (see 184, now a convergence stub): one dataset + one
-- Meta lead + one event name can legitimately appear TWICE in
-- the ledger with status 'sent' (e.g. Lead → QualifiedLead and
-- Booking Confirmed → QualifiedLead for the same lead, both
-- actually transmitted to Meta). A partial unique index over
-- pending/sent rows can therefore never be applied — and must
-- never be worked around by deleting history or flipping a
-- Sent row to failed/skipped.
--
-- Design: a separate `meta_crm_event_claims` table holds exactly
-- ONE row per (account_id, dataset_id, meta_lead_id, event_name)
-- enforced by its PRIMARY KEY. The ledger keeps every
-- historical row byte-identical; the seed below only READS the
-- ledger and inserts one claim per identity, pointing at a
-- canonical event:
--   sent first, then pending, then failed, then skipped;
--   newest created_at first (the same preference the
--   application display path already uses), id as final tiebreak.
-- New submissions go through `enqueue_meta_crm_event()`, which
-- claims the identity and inserts the event row in ONE
-- transaction: concurrent submits serialize on the claim PK, so
-- at most one event row is ever created per identity. Every
-- event-creation path funnels through the single application
-- function `enqueueLeadQualityEvent`, which calls that RPC —
-- individual tables, All Meta Leads, automatic initial Lead,
-- Lead Quality selection, retries (which reuse the existing row
-- and never insert), and concurrent submits are all covered.
-- Table-selection allowlists and tenant isolation are unchanged
-- (account_id is part of the claim key; RLS mirrors the ledger).
--
-- No date cutoff is used: claims are seeded from ALL history,
-- so a new event can never duplicate an old Sent row from any
-- era. Failed/skipped rows are also claimed, so repeats route
-- to the existing row (deduplicated) instead of inserting anew.
--
-- Pre-apply inspection (read-only — run before applying):
--   SELECT account_id, dataset_id, meta_lead_id, event_name,
--          COUNT(*) AS n,
--          string_agg(DISTINCT status::text, ',' ) AS statuses
--   FROM public.meta_crm_events
--   GROUP BY 1, 2, 3, 4 HAVING COUNT(*) > 1 ORDER BY n DESC;
-- Post-apply verification:
--   SELECT COUNT(*) AS claims FROM public.meta_crm_event_claims;
--   SELECT COUNT(*) AS groups FROM (
--     SELECT 1 FROM public.meta_crm_events
--     GROUP BY account_id, dataset_id, meta_lead_id, event_name
--   ) g;  -- claims must equal groups
--
-- Idempotent — safe to run multiple times (IF NOT EXISTS /
-- OR REPLACE / ON CONFLICT DO NOTHING throughout). Performs NO
-- DELETE and NO UPDATE on meta_crm_events: the ledger is only
-- ever read here.
-- ============================================================

-- Convergence: environments that applied the original 184 carry
-- its partial unique index, which cannot coexist with preserved
-- historical duplicates. The claim PK supersedes it everywhere.
DROP INDEX IF EXISTS public.meta_crm_events_dataset_lead_event_key;

-- ---------- 1. claim table -----------------------------------
CREATE TABLE IF NOT EXISTS public.meta_crm_event_claims (
  account_id         UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  dataset_id         TEXT NOT NULL,
  meta_lead_id       TEXT NOT NULL,
  event_name         TEXT NOT NULL
                     -- Must accept every name the ledger accepts:
                     -- authoritative list is CRM_EVENT_NAMES in
                     -- src/lib/meta-crm/lead-quality.ts, enforced on
                     -- the ledger by meta_crm_events_event_name_check
                     -- (175, extended by 182). Historical
                     -- 'DisqualifiedLead' and current 'Junk' rows
                     -- must both seed without a 23514 violation.
                     CHECK (event_name IN (
                       'Lead',
                       'InterestedLead',
                       'QualifiedLead',
                       'BookingConfirmed',
                       'DisqualifiedLead',
                       'Junk'
                     )),
  canonical_event_id UUID REFERENCES public.meta_crm_events(id) ON DELETE SET NULL,
  claimed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_crm_event_claims_pkey
    PRIMARY KEY (account_id, dataset_id, meta_lead_id, event_name)
);

COMMENT ON TABLE public.meta_crm_event_claims IS
  'One claim per (account, dataset, Meta lead, event): atomic cross-table duplicate guard. Historical duplicates stay untouched in meta_crm_events; canonical_event_id points at the surviving record (sent > pending > failed > skipped, newest first). New submissions must acquire the claim inside enqueue_meta_crm_event().';
COMMENT ON COLUMN public.meta_crm_event_claims.canonical_event_id IS
  'Ledger row this identity resolved to. NULL only transiently inside the claiming transaction (or if the canonical row was deleted); never cleared by this migration.';

-- Lookup for drains/audits: claim -> canonical event.
CREATE INDEX IF NOT EXISTS idx_meta_crm_event_claims_canonical
  ON public.meta_crm_event_claims (canonical_event_id);

-- Plain (non-unique) identity lookup for the enqueue fast path.
CREATE INDEX IF NOT EXISTS idx_meta_crm_events_identity
  ON public.meta_crm_events (account_id, dataset_id, meta_lead_id, event_name);

-- ---------- 2. RLS (mirrors the ledger) ----------------------
ALTER TABLE public.meta_crm_event_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_crm_event_claims_select ON public.meta_crm_event_claims;
CREATE POLICY meta_crm_event_claims_select ON public.meta_crm_event_claims
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_crm_event_claims_insert ON public.meta_crm_event_claims;
CREATE POLICY meta_crm_event_claims_insert ON public.meta_crm_event_claims
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_crm_event_claims_update ON public.meta_crm_event_claims;
CREATE POLICY meta_crm_event_claims_update ON public.meta_crm_event_claims
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_crm_event_claims_delete ON public.meta_crm_event_claims;
CREATE POLICY meta_crm_event_claims_delete ON public.meta_crm_event_claims
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---------- 3. seed: one claim per identity, ledger untouched -
-- Canonical = sent, then pending, then failed, then skipped;
-- newest first (matches the application display preference).
-- TRIM keeps whitespace variants of the same lead/dataset on one
-- claim; the ledger rows themselves are never modified.
INSERT INTO public.meta_crm_event_claims
  (account_id, dataset_id, meta_lead_id, event_name, canonical_event_id)
SELECT account_id, dataset_id, meta_lead_id, event_name, canonical_event_id
FROM (
  SELECT account_id,
         TRIM(dataset_id) AS dataset_id,
         TRIM(meta_lead_id) AS meta_lead_id,
         event_name,
         id AS canonical_event_id,
         ROW_NUMBER() OVER (
           PARTITION BY account_id, TRIM(dataset_id), TRIM(meta_lead_id), event_name
           ORDER BY CASE status
                      WHEN 'sent' THEN 0
                      WHEN 'pending' THEN 1
                      WHEN 'failed' THEN 2
                      ELSE 3
                    END,
                    created_at DESC,
                    id DESC
         ) AS rn
  FROM public.meta_crm_events
  WHERE NULLIF(TRIM(meta_lead_id), '') IS NOT NULL
    AND NULLIF(TRIM(dataset_id), '') IS NOT NULL
) ranked
WHERE rn = 1
ON CONFLICT (account_id, dataset_id, meta_lead_id, event_name) DO NOTHING;

-- ---------- 4. atomic enqueue RPC -----------------------------
-- Claims the identity and inserts the event row in ONE
-- transaction. Concurrent callers serialize on the claim PK:
-- exactly one creates the event; the losers return the
-- canonical id as deduplicated. Callers keep their existing
-- gates (unchanged-status, mapping, submission, config,
-- table allowlist) and call this only when a NEW row may be
-- needed; a pre-existing event is returned deduplicated here
-- too, so a stale pre-check can never cause a duplicate.
CREATE OR REPLACE FUNCTION public.enqueue_meta_crm_event(
  p_account_id    UUID,
  p_flow_id       UUID,
  p_flow_run_id   UUID,
  p_submission_id UUID,
  p_meta_lead_id  TEXT,
  p_event_name    TEXT,
  p_from_quality  TEXT,
  p_to_quality    TEXT,
  p_event_time    TIMESTAMPTZ,
  p_dataset_id    TEXT
)
RETURNS TABLE (event_id UUID, deduplicated BOOLEAN)
LANGUAGE plpgsql
SET search_path = public
AS $func$
DECLARE
  v_lead     TEXT := NULLIF(TRIM(p_meta_lead_id), '');
  v_ds       TEXT := NULLIF(TRIM(p_dataset_id), '');
  v_existing UUID;
  v_claimed  UUID;
  v_new      UUID;
BEGIN
  IF v_lead IS NULL OR v_ds IS NULL THEN
    RAISE EXCEPTION
      'enqueue_meta_crm_event: meta lead id and dataset id are required.'
      USING ERRCODE = '22004';
  END IF;

  -- 1. Fast path: an event already recorded for this identity
  --    (ANY status — failed/skipped repeats reuse the existing
  --    row via the controlled retry, never a new insert).
  SELECT e.id INTO v_existing
  FROM public.meta_crm_events e
  WHERE e.account_id = p_account_id
    AND e.dataset_id = v_ds
    AND TRIM(e.meta_lead_id) = v_lead
    AND e.event_name = p_event_name
  ORDER BY CASE e.status
             WHEN 'sent' THEN 0
             WHEN 'pending' THEN 1
             WHEN 'failed' THEN 2
             ELSE 3
           END,
           e.created_at DESC,
           e.id DESC
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- Backfill the claim for rows that predate it (e.g. direct
    -- SQL inserts); the common case is already seeded.
    INSERT INTO public.meta_crm_event_claims
      (account_id, dataset_id, meta_lead_id, event_name, canonical_event_id)
    VALUES (p_account_id, v_ds, v_lead, p_event_name, v_existing)
    ON CONFLICT (account_id, dataset_id, meta_lead_id, event_name) DO NOTHING;
    event_id := v_existing;
    deduplicated := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 2. Claim the identity. This single statement is the atomic
  --    mutual-exclusion point: concurrent transactions block on
  --    the PK row until the winner commits or aborts.
  INSERT INTO public.meta_crm_event_claims
    (account_id, dataset_id, meta_lead_id, event_name, canonical_event_id)
  VALUES (p_account_id, v_ds, v_lead, p_event_name, NULL)
  ON CONFLICT (account_id, dataset_id, meta_lead_id, event_name) DO NOTHING
  RETURNING canonical_event_id INTO v_claimed;

  IF NOT FOUND THEN
    -- Lost the race (or an orphaned NULL claim exists): lock the
    -- claim row and re-read. SELECT ... FOR UPDATE re-reads the
    -- latest committed version after waiting, so the second of
    -- two adopters sees the first adopter's canonical id.
    SELECT c.canonical_event_id INTO v_claimed
    FROM public.meta_crm_event_claims c
    WHERE c.account_id = p_account_id
      AND c.dataset_id = v_ds
      AND c.meta_lead_id = v_lead
      AND c.event_name = p_event_name
    FOR UPDATE;

    IF v_claimed IS NOT NULL THEN
      event_id := v_claimed;
      deduplicated := TRUE;
      RETURN NEXT;
      RETURN;
    END IF;
    -- NULL canonical while holding the row lock: orphaned claim
    -- from a crashed writer — adopted below; the lock guarantees
    -- a single adopter.
  END IF;

  -- 3. We own the claim: insert the event, then finalize it.
  INSERT INTO public.meta_crm_events
    (account_id, flow_id, flow_run_id, submission_id, meta_lead_id,
     event_name, from_quality, to_quality, event_time, dataset_id)
  VALUES (p_account_id, p_flow_id, p_flow_run_id, p_submission_id, v_lead,
          p_event_name, COALESCE(p_from_quality, ''), COALESCE(p_to_quality, ''),
          p_event_time, v_ds)
  RETURNING id INTO v_new;

  UPDATE public.meta_crm_event_claims
  SET canonical_event_id = v_new
  WHERE account_id = p_account_id
    AND dataset_id = v_ds
    AND meta_lead_id = v_lead
    AND event_name = p_event_name
    AND canonical_event_id IS NULL;

  event_id := v_new;
  deduplicated := FALSE;
  RETURN NEXT;
  RETURN;
END;
$func$;

COMMENT ON FUNCTION public.enqueue_meta_crm_event(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) IS
  'Atomic cross-table CRM event enqueue: claims (account, dataset, Meta lead, event) and inserts the ledger row in one transaction. Concurrent callers serialize on the claim PK; losers receive the canonical event id as deduplicated. Never modifies existing ledger rows.';

-- ---------- 5. read-only verification (never blocks) ---------
DO $$
DECLARE
  v_claims integer;
  v_groups integer;
  v_multi  integer;
BEGIN
  SELECT COUNT(*) INTO v_claims FROM public.meta_crm_event_claims;
  SELECT COUNT(*) INTO v_groups FROM (
    SELECT 1 FROM public.meta_crm_events
    GROUP BY account_id, dataset_id, meta_lead_id, event_name
  ) g;
  SELECT COUNT(*) INTO v_multi FROM (
    SELECT 1 FROM public.meta_crm_events
    GROUP BY account_id, dataset_id, meta_lead_id, event_name
    HAVING COUNT(*) > 1
  ) m;

  RAISE NOTICE
    'Migration 185 complete: % event claims for % ledger identities (% multi-row identities preserved untouched). New submissions serialize on the claim PK via enqueue_meta_crm_event().',
    v_claims, v_groups, v_multi;
END
$$;
