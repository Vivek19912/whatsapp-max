-- ============================================================
-- 146_crm_user_mappings.sql — CRM User Mapping (WACRM → Travel CRM).
--
-- One row maps a WhatsApp Max user to the Travel Agency CRM
-- salesperson that user's Workspace-created leads are assigned to.
--
-- Identity is by INTERNAL IDs on both sides, never email or name:
--   wacrm_user_id  auth.users id of the WACRM member
--                  (matches profiles.user_id within the account).
--   crm_user_id    Travel CRM `users.id` UUID (the assignee id in the
--                  linked Travel CRM account).
-- Emails/names may differ or collide across the two systems; IDs are
-- the only stable join key.
--
-- Tenant isolation: UNIQUE (account_id, wacrm_user_id) — one mapping
-- per WACRM user per workspace, and mappings never leak across
-- workspaces connected to different CRM accounts.
--
-- Writes are admin-gated at the API layer (requireRole("admin"));
-- RLS mirrors other settings tables: members may read, admin+ may
-- write. Service-role archival/lookup paths bypass RLS as usual.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_user_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- WACRM member. No FK to auth.users (managed by Supabase Auth);
  -- membership is enforced by the API checking profiles.
  wacrm_user_id UUID NOT NULL,
  -- Travel CRM salesperson id (UUID in the linked CRM account).
  -- Validated live against the linked account's assignable users at
  -- write time; re-validated on read for the mapping status.
  crm_user_id TEXT NOT NULL CHECK (char_length(crm_user_id) BETWEEN 1 AND 64),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_user_mappings_one_per_user
    UNIQUE (account_id, wacrm_user_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_user_mappings_account
  ON crm_user_mappings (account_id);

ALTER TABLE crm_user_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_user_mappings_select ON crm_user_mappings;
CREATE POLICY crm_user_mappings_select
ON crm_user_mappings
FOR SELECT
USING (is_account_member(account_id));

DROP POLICY IF EXISTS crm_user_mappings_insert ON crm_user_mappings;
CREATE POLICY crm_user_mappings_insert
ON crm_user_mappings
FOR INSERT
WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS crm_user_mappings_update ON crm_user_mappings;
CREATE POLICY crm_user_mappings_update
ON crm_user_mappings
FOR UPDATE
USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS crm_user_mappings_delete ON crm_user_mappings;
CREATE POLICY crm_user_mappings_delete
ON crm_user_mappings
FOR DELETE
USING (is_account_member(account_id, 'admin'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON crm_user_mappings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON crm_user_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
