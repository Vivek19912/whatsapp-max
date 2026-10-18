-- ============================================================
-- 120_meta_lead_pages_global_unique.sql
--
-- A Facebook Page may be connected to only ONE WhatsApp Max
-- account at a time. Until now `meta_lead_pages` was unique only on
-- (account_id, page_id), so two accounts could both "own" the same
-- Page — which made the leadgen webhook's Page -> account lookup
-- ambiguous and could silently drop leads.
--
-- This migration:
--   1. Collapses any pre-existing duplicates, keeping the EARLIEST
--      connection per page_id (deterministic: created_at, then id).
--   2. Disables Instant Forms whose account no longer owns the Page,
--      so a losing duplicate cannot keep publishing a table that can
--      never receive leads.
--   3. Adds a GLOBAL unique index on page_id (also serves the
--      webhook's hot lookup path).
--
-- Lead records are NEVER touched: `meta_lead_submissions` and the
-- linked `flow_runs` rows are left exactly as they are. Only the
-- duplicate *connection* rows (and the enabled flag on their forms)
-- change. Every statement is safe to re-run.
-- ============================================================

-- ---------- 1. Collapse duplicate Page connections -----------
-- Keep the oldest row per page_id; delete the rest. `created_at`
-- is NOT NULL (defaulted to now()) and `id` is a unique UUID, so the
-- (created_at, id) tuple ordering is total and deterministic.
DELETE FROM public.meta_lead_pages p
USING public.meta_lead_pages q
WHERE p.page_id = q.page_id
  AND (p.created_at, p.id) > (q.created_at, q.id);

-- ---------- 2. Disable now-orphaned forms --------------------
-- A form whose (account_id, page_id) no longer has a Page row can
-- never be routed a lead; disable it so the Workspace/settings stop
-- presenting it as active. Its historical runs are untouched.
UPDATE public.meta_lead_forms f
SET enabled = false,
    updated_at = now()
WHERE f.enabled
  AND NOT EXISTS (
    SELECT 1
    FROM public.meta_lead_pages p
    WHERE p.account_id = f.account_id
      AND p.page_id = f.page_id
  );

-- ---------- 3. Global uniqueness on page_id ------------------
CREATE UNIQUE INDEX IF NOT EXISTS meta_lead_pages_page_id_key
  ON public.meta_lead_pages(page_id);

COMMENT ON INDEX public.meta_lead_pages_page_id_key IS
  'A Meta Page is connected to at most one account; the leadgen webhook resolves the tenant by page_id.';
