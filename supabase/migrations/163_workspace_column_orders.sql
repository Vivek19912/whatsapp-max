-- ============================================================
-- 163_workspace_column_orders.sql — per-user, per-table Workspace
-- column display order (drag-and-drop persistence).
--
-- One row per salesperson per Workspace table: the complete
-- ordered stable-ID list (`core:actions`, `core:row`,
-- `sys:<key>`/`flow:<key>`, `custom:<uuid>`,
-- `followup-result:<N>` — the same identities the visibility
-- manager and width/color systems use, never labels or indexes).
-- Defaults live in code (payload order); only a customized order
-- persists here, so new/removed columns merge safely and Reset
-- (row delete) restores the default without touching anything
-- else. Google Sheets never reads this table.
--
-- Scope is (user_id, account_id, flow_id): one salesperson's
-- arrangement never leaks into another user's, one table's never
-- into another's. Reads are the owning member; writes are the
-- owning agent+ (personal display preference, same bar as editing
-- cell values — viewers stay read-only everywhere).
--
-- Self-contained and idempotent — safe to run multiple times,
-- including after a partial application: the updated_at trigger
-- uses a dedicated function defined below (never the
-- trigger-NAME `set_updated_at()` as a function — no such
-- function exists — and with no dependency on
-- update_updated_at_column() from 001), and the unique
-- constraint is reconciled only when missing. Existing rows are
-- never touched.
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_column_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owner + tenant + flow scope: an arrangement belongs to exactly
  -- one salesperson's view of one flow's Workspace. All cascade
  -- (user delete, account wipe, flow delete).
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Complete ordered stable-ID list (JSONB array of strings).
  ordered_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_column_orders_owner_flow_unique
    UNIQUE (user_id, account_id, flow_id)
);

-- Partial-application reconcile: if an earlier attempt created
-- the table but stopped before the constraint existed, add it
-- now. Data is never modified; a genuine duplicate (which cannot
-- arise from the app's per-user upsert) fails loudly here
-- instead of silently duplicating preferences.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_column_orders_owner_flow_unique'
  ) THEN
    ALTER TABLE workspace_column_orders
      ADD CONSTRAINT workspace_column_orders_owner_flow_unique
      UNIQUE (user_id, account_id, flow_id);
  END IF;
END $$;

-- Hot path: "this member's order for this flow's Workspace".
CREATE INDEX IF NOT EXISTS idx_workspace_column_orders_flow
  ON workspace_column_orders (account_id, flow_id);

-- ============================================================
-- RLS — account isolation + owner-only rows on every path.
-- ============================================================
ALTER TABLE workspace_column_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_column_orders_select ON workspace_column_orders;
CREATE POLICY workspace_column_orders_select ON workspace_column_orders FOR SELECT
  USING (user_id = auth.uid() AND is_account_member(account_id));

DROP POLICY IF EXISTS workspace_column_orders_insert ON workspace_column_orders;
CREATE POLICY workspace_column_orders_insert ON workspace_column_orders FOR INSERT
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_column_orders_update ON workspace_column_orders;
CREATE POLICY workspace_column_orders_update ON workspace_column_orders FOR UPDATE
  USING (user_id = auth.uid() AND is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS workspace_column_orders_delete ON workspace_column_orders;
CREATE POLICY workspace_column_orders_delete ON workspace_column_orders FOR DELETE
  USING (user_id = auth.uid() AND is_account_member(account_id, 'agent'));

-- Keep updated_at fresh via a DEDICATED trigger function defined
-- below. Deliberately NOT update_updated_at_column() from 001 and
-- NOT a generic shared set_updated_at(): this migration must apply
-- standalone on any database holding 001's tables, with no helper
-- dependency and no effect on any other table's triggers.
CREATE OR REPLACE FUNCTION public.set_workspace_column_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON workspace_column_orders;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON workspace_column_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_workspace_column_orders_updated_at();
