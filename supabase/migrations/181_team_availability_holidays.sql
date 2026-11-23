-- ============================================================
-- 181_team_availability_holidays.sql — Team Availability: account-wide
-- holiday/leave records for internal team members.
--
-- One row = one employee's leave window. While a holiday is
-- active (start_date <= today <= end_date in Asia/Kolkata and
-- cancelled_at IS NULL), the assignment engine excludes that
-- employee from NEW automatic lead assignments across every
-- Meta Lead Ads table where they are a configured internal
-- assignee. Saved assignment configurations, existing lead
-- ownership, and notifications for other members are untouched:
-- the exclusion is evaluated at assignment time from these
-- rows, so expiry/restoration needs no cron and no writes.
--
-- Identity is the stable profiles.user_id (never display names).
-- Overlap handling is enforced in the API (reject conflicting
-- windows); cancellation is a timestamp (history preserved).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_assignment_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scope. Account wipe cascades; the employee link is
  -- intentionally NOT a hard FK to profiles so a removed member's
  -- history survives (the API validates roster membership).
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  -- Audit only — never used for reads.
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_assignment_holidays_valid_range
    CHECK (end_date >= start_date)
);

-- Hot path: "active holidays for this account" (engine check per
-- assignment) and "this member's windows" (overlap validation).
CREATE INDEX IF NOT EXISTS idx_assignment_holidays_account
  ON lead_assignment_holidays (account_id);
CREATE INDEX IF NOT EXISTS idx_assignment_holidays_member
  ON lead_assignment_holidays (account_id, user_id);

-- ============================================================
-- RLS — account isolation on every path. Owner-only writes;
-- account members may read (availability is team-visible, and
-- the engine reads through the service role regardless).
-- ============================================================
ALTER TABLE lead_assignment_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assignment_holidays_select ON lead_assignment_holidays;
CREATE POLICY assignment_holidays_select ON lead_assignment_holidays FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS assignment_holidays_insert ON lead_assignment_holidays;
CREATE POLICY assignment_holidays_insert ON lead_assignment_holidays FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS assignment_holidays_update ON lead_assignment_holidays;
CREATE POLICY assignment_holidays_update ON lead_assignment_holidays FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS assignment_holidays_delete ON lead_assignment_holidays;
CREATE POLICY assignment_holidays_delete ON lead_assignment_holidays FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON lead_assignment_holidays;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lead_assignment_holidays
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
