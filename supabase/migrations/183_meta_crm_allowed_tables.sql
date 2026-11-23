-- ============================================================
-- 183_meta_crm_allowed_tables.sql — per-workspace Meta CRM table
-- allowlist for lead-quality event sending.
--
-- Adds meta_crm_config.allowed_flow_ids (UUID array, nullable):
-- the Workspace (Meta Lead Ads flow) ids whose leads may send
-- CRM events to Meta. Semantics:
--   NULL (including all pre-existing rows) = unrestricted
--     legacy behavior — every table stays eligible, so existing
--     configurations keep sending exactly as before without any
--     action from the owner.
--   Explicit array (even empty) = enforced allowlist — only the
--     saved tables' leads may enqueue (automatic + manual) or be
--     delivered (drain re-checks every pending row). An empty
--     array blocks all new sending (with a UI warning).
--
-- Names are never stored (renames/deletes can't corrupt the
-- selection); unknown ids are rejected at save time, and rows
-- whose flow is gone simply never match. Event history,
-- deduplication, datasets, tokens, and payloads are untouched.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.meta_crm_config
  ADD COLUMN IF NOT EXISTS allowed_flow_ids UUID[];

COMMENT ON COLUMN public.meta_crm_config.allowed_flow_ids IS
  'Meta Lead Ads flow ids eligible for Meta CRM event sending. NULL = unrestricted (legacy). Explicit array (even empty) = enforced allowlist.';
