-- ============================================================
-- 167_meta_lead_submissions_attribution.sql — preserve extra Meta
-- lead metadata for the Workspace "Additional Meta Details" drawer.
--
-- Background: the Graph Lead node already returns ad_id and
-- is_organic (see LEAD_FIELDS in graph-client.ts) and
-- created_time, but process-lead persisted only ad_name /
-- campaign_name. Historical rows therefore lack these values and
-- must NOT be backfilled (Meta created_time cannot be recovered
-- from the local database).
--
-- This migration adds only the missing columns; existing columns
-- (meta_created_time from 119, ad_name/campaign_name from 128)
-- are reused. Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.meta_lead_submissions
  ADD COLUMN IF NOT EXISTS ad_id TEXT;

ALTER TABLE public.meta_lead_submissions
  ADD COLUMN IF NOT EXISTS is_organic BOOLEAN;

COMMENT ON COLUMN public.meta_lead_submissions.ad_id IS
  'Meta ad id for the lead (Lead node ad_id at processing time). Null when Meta omits it; only populated for newly ingested leads.';
COMMENT ON COLUMN public.meta_lead_submissions.is_organic IS
  'Whether Meta marked the lead organic (Lead node is_organic at processing time). Null when Meta omits it; only populated for newly ingested leads.';
COMMENT ON COLUMN public.meta_lead_submissions.meta_created_time IS
  'Meta Lead created_time at processing time (populated for newly ingested leads; null for older rows ingested before preservation).';
