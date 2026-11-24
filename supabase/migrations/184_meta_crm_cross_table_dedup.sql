-- ============================================================
-- 184_meta_crm_cross_table_dedup.sql — one dataset + one Meta
-- lead + one event name = at most one in-flight or delivered
-- CRM event, regardless of Workspace table or run.
--
-- Background: the original ledger key
--   UNIQUE (account_id, flow_run_id, event_name,
--            from_quality, to_quality)
-- is per-run, so the same Meta lead in two tables could queue
-- and deliver the same event twice (once per run). Application
-- code now checks across runs before inserting; this partial
-- unique index enforces the pending/sent subset atomically so
-- two concurrent submissions cannot both slip through.
--
-- Scope decisions (deliberate):
-- - failed/skipped rows are EXCLUDED: terminal history is never
--   rewritten, and the controlled retry path requeues the
--   existing row in place instead of inserting a new one.
-- - The index does not replace the application check, which also
--   reports the recorded delivery state (already sent / queued)
--   instead of merely failing the insert.
--
-- Safety: the DO block below aborts the migration with an
-- actionable error if live duplicate pending/sent rows already
-- exist (list them with the query in the message). It never
-- deletes or modifies event history — resolve those rows first
-- (let them drain, or cancel the extras), then re-run.
--
-- Idempotent: the index uses IF NOT EXISTS; the guard is a pure
-- read. Safe to run multiple times.
-- ============================================================

DO $$
DECLARE
  v_dup_count integer;
  v_sample text;
BEGIN
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT account_id, dataset_id, meta_lead_id, event_name
    FROM public.meta_crm_events
    WHERE status IN ('pending', 'sent')
    GROUP BY account_id, dataset_id, meta_lead_id, event_name
    HAVING COUNT(*) > 1
  ) dups;

  IF v_dup_count > 0 THEN
    SELECT string_agg(
      format('account=%s dataset=%s lead=%s event=%s (n=%s)', account_id, dataset_id, meta_lead_id, event_name, n),
      '; '
    )
    INTO v_sample
    FROM (
      SELECT account_id, dataset_id, meta_lead_id, event_name, COUNT(*) AS n
      FROM public.meta_crm_events
      WHERE status IN ('pending', 'sent')
      GROUP BY account_id, dataset_id, meta_lead_id, event_name
      HAVING COUNT(*) > 1
      ORDER BY n DESC
      LIMIT 5
    ) dups;

    RAISE EXCEPTION
      'Migration 184 blocked: % duplicate (account, dataset, Meta lead, event) group(s) with status pending/sent already exist. Resolve them first (let pending rows drain, or keep exactly one live row per group via the controlled retry/cancel flow — do NOT delete sent history). Sample: %',
      v_dup_count, v_sample;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS meta_crm_events_dataset_lead_event_key
  ON public.meta_crm_events (account_id, dataset_id, meta_lead_id, event_name)
  WHERE status IN ('pending', 'sent');

COMMENT ON INDEX public.meta_crm_events_dataset_lead_event_key IS
  'Cross-table duplicate guard: at most one pending or sent row per (account, dataset, Meta lead, event). Terminal (failed/skipped) history is intentionally excluded.';
