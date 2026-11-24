-- ============================================================
-- 184_meta_crm_cross_table_dedup.sql — SUPERSEDED by 185.
--
-- Background: the original version of this migration created a
-- partial unique index
--   UNIQUE (account_id, dataset_id, meta_lead_id, event_name)
--   WHERE status IN ('pending', 'sent')
-- to cap one dataset + one Meta lead + one event name at a single
-- in-flight/delivered row. Production proved that constraint
-- wrong: legitimate history already contains TWO sent rows for
-- one identity (Lead → QualifiedLead AND Booking Confirmed →
-- QualifiedLead for the same dataset + Meta lead, both actually
-- transmitted to Meta with events_received: 1). The DO-block
-- guard therefore raised
--   ERROR P0001: Migration 184 blocked: 1 duplicate group
-- and the index could never be applied without deleting or
-- falsifying real Sent history — which is forbidden.
--
-- Redesign (185): a separate `meta_crm_event_claims` table holds
-- ONE claim row per (account, dataset, lead, event) with a plain
-- PRIMARY KEY. Historical duplicates stay untouched in the
-- ledger; the seed picks one canonical event per identity (sent
-- first, then pending, failed, skipped — newest first, the same
-- rule the application display path already uses). New
-- submissions claim the identity atomically inside a single
-- Postgres transaction (see `enqueue_meta_crm_event()` in 185),
-- so concurrent submits serialize on the claim PK instead of
-- racing past an application pre-check.
--
-- This file is now a safe convergence stub:
--   - drops the partial index when it exists (clean environments
--     that applied the original 184 keep working; every
--     environment converges on the claim mechanism),
--   - reports duplicate groups with a NOTICE for pre-apply review
--     (never raises, never blocks),
--   - performs NO data mutation: no DELETE, no UPDATE, no status
--     changes to meta_crm_events.
--
-- Idempotent — safe to run multiple times, before or after 185.
-- ============================================================

DROP INDEX IF EXISTS public.meta_crm_events_dataset_lead_event_key;

DO $$
DECLARE
  v_dup_groups integer;
  v_sample text;
BEGIN
  SELECT COUNT(*) INTO v_dup_groups
  FROM (
    SELECT account_id, dataset_id, meta_lead_id, event_name
    FROM public.meta_crm_events
    WHERE status IN ('pending', 'sent')
    GROUP BY account_id, dataset_id, meta_lead_id, event_name
    HAVING COUNT(*) > 1
  ) dups;

  IF v_dup_groups IS NOT NULL AND v_dup_groups > 0 THEN
    SELECT string_agg(
      format(
        'account=%s dataset=%s lead=%s event=%s (n=%s, statuses=%s)',
        account_id, dataset_id, meta_lead_id, event_name, n, statuses
      ),
      '; '
    )
    INTO v_sample
    FROM (
      SELECT account_id, dataset_id, meta_lead_id, event_name,
             COUNT(*) AS n,
             string_agg(DISTINCT status::text, ',' ORDER BY status::text) AS statuses
      FROM public.meta_crm_events
      WHERE status IN ('pending', 'sent')
      GROUP BY account_id, dataset_id, meta_lead_id, event_name
      HAVING COUNT(*) > 1
      ORDER BY n DESC
      LIMIT 5
    ) dups;

    RAISE NOTICE
      'Migration 184 (superseded by 185): % duplicate (account, dataset, Meta lead, event) group(s) with status pending/sent remain preserved in the ledger. Canonical claims for them are seeded by 185 — no manual cleanup required, do NOT delete history. Sample: %',
      v_dup_groups, v_sample;
  ELSE
    RAISE NOTICE 'Migration 184 (superseded by 185): no duplicate pending/sent groups; ledger already unique per identity.';
  END IF;
END
$$;
