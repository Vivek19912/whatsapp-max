-- ============================================================
-- 168_workspace_hidden_tables.sql — hide/restore Workspace tables.
--
-- Visibility-only: one row per table the owner hid from the
-- Workspace table selector, keyed by the STABLE flow_id (never
-- the display name — renames must not orphan or resurrect a
-- preference).
--
-- Hiding changes NOTHING about the underlying form, leads,
-- ingestion, imports, polling, columns, assignment, or
-- follow-ups: hidden tables keep receiving and storing new
-- leads normally. The Workspace client simply filters them out
-- of the selector until restored.
--
-- Scope is account-wide (one account's hides never leak into
-- another's). Reads are account members (everyone's selector
-- hides the same tables); writes are owner-only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_hidden_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant + table scope. Both cascade (account wipe, flow delete
  -- drops its hide row so a recreated table starts visible).
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Who hid it (audit only — never used for reads).
  hidden_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_hidden_tables_key_unique
    UNIQUE (account_id, flow_id)
);

-- Hot path: "all hidden tables for this account's Workspace".
CREATE INDEX IF NOT EXISTS idx_workspace_hidden_tables_account
  ON workspace_hidden_tables (account_id);

-- ============================================================
-- RLS — account isolation on every path. Owner-only writes.
-- ============================================================
ALTER TABLE workspace_hidden_tables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_hidden_tables_select ON workspace_hidden_tables;
CREATE POLICY workspace_hidden_tables_select ON workspace_hidden_tables FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS workspace_hidden_tables_insert ON workspace_hidden_tables;
CREATE POLICY workspace_hidden_tables_insert ON workspace_hidden_tables FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS workspace_hidden_tables_update ON workspace_hidden_tables;
CREATE POLICY workspace_hidden_tables_update ON workspace_hidden_tables FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS workspace_hidden_tables_delete ON workspace_hidden_tables;
CREATE POLICY workspace_hidden_tables_delete ON workspace_hidden_tables FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON workspace_hidden_tables;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_hidden_tables
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
