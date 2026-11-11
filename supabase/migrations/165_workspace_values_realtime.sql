-- ============================================================
-- 165_workspace_values_realtime.sql — Inbox reassignment sync.
--
-- The Inbox subscribes to `workspace_values` so that a Workspace
-- lead reassignment (Assigned To cell change) can resync the
-- conversation list for both the previous and the new owner
-- without a manual refresh — including the case where the
-- losing viewer's `conversations` UPDATE is filtered out by the
-- assignment-scoped SELECT policy and only the cell write reaches
-- them.
--
-- Idempotent (DO block, same convention as 001/009/010/024/027):
-- safe to apply when the table is already published.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'workspace_values'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE workspace_values;
  END IF;
END $$;
