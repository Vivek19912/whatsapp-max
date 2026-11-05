-- ============================================================
-- 159_whatsapp_followups_agent_isolation.sql — backend ownership
-- enforcement for agent reminder reads (defense in depth)
--
-- The API layer scopes every agent query by created_by (see
-- GET /api/followups + followup-counts assignment scoping). This
-- policy mirrors that rule inside RLS so a missed query filter
-- can never leak another agent's reminder:
--   - owner / admin : full account visibility (unchanged)
--   - agent        : only rows they created (created_by = auth.uid())
--   - viewer       : full account visibility (unchanged — read-only
--                    role keeps its existing behavior)
-- Service-role callers (reminder cron) bypass RLS as before.
-- Idempotent — safe to run multiple times.
-- ============================================================

DROP POLICY IF EXISTS whatsapp_followups_select ON whatsapp_followups;
CREATE POLICY whatsapp_followups_select ON whatsapp_followups FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id) AND created_by = auth.uid())
    OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent'))
  );
