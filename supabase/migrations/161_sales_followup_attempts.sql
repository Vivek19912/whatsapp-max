-- ============================================================
-- 161_sales_followup_attempts.sql — sequential sales follow-up
-- history (one row per scheduled attempt, unlimited per lead).
--
-- A sales follow-up attempt is NOT a WhatsApp reminder (see
-- whatsapp_followups): it records the salesperson's planned sales
-- interaction and its mandatory result. Business rule enforced
-- here and in the API: one unresolved attempt per lead; the next
-- attempt number derives from actual history.
--
-- State is DERIVED (no status column to drift):
--   completed_at IS NULL + scheduled_at > now  → Scheduled
--   completed_at IS NULL + scheduled_at <= now → Result Required
--   completed_at IS NOT NULL                   → Completed
-- Sequence closure lives in sales_followup_closures.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_followup_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  scheduled_at TIMESTAMPTZ NOT NULL,
  outcome TEXT NULL CHECK (
    outcome IS NULL OR outcome IN (
      'Connected — Interested',
      'Connected — Not Interested',
      'Call Back Requested',
      'No Answer',
      'Busy',
      'Switched Off',
      'Wrong Number',
      'Other'
    )
  ),
  result_text TEXT NULL CHECK (result_text IS NULL OR length(btrim(result_text)) > 0),
  -- Audit: NULL created_by = row imported by the migration below
  -- (existing pending schedules), never a live API write.
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ NULL,
  rescheduled_from TIMESTAMPTZ NULL,
  rescheduled_at TIMESTAMPTZ NULL,
  rescheduled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  origin TEXT NOT NULL DEFAULT 'scheduled' CHECK (origin IN ('scheduled', 'migrated')),
  CONSTRAINT sales_followup_attempts_completed_by_check CHECK (
    (completed_at IS NULL AND completed_by IS NULL AND outcome IS NULL AND result_text IS NULL)
    OR (completed_at IS NOT NULL AND completed_by IS NOT NULL AND outcome IS NOT NULL AND result_text IS NOT NULL)
  ),
  CONSTRAINT sales_followup_attempts_reschedule_check CHECK (
    (rescheduled_from IS NULL AND rescheduled_at IS NULL AND rescheduled_by IS NULL)
    OR (rescheduled_from IS NOT NULL AND rescheduled_at IS NOT NULL AND rescheduled_by IS NOT NULL)
  )
);

-- Next attempt number is unique per lead (concurrent schedulers
-- racing on MAX()+1 collide here; the API retries once).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_followup_attempt_number
  ON sales_followup_attempts (account_id, flow_run_id, attempt_number);

-- Exactly one unresolved attempt per lead, enforced by the
-- database (not just the API).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_followup_open_attempt
  ON sales_followup_attempts (account_id, flow_run_id)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_followup_attempts_run
  ON sales_followup_attempts (account_id, flow_run_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_sales_followup_attempts_due
  ON sales_followup_attempts (account_id, scheduled_at)
  WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS sales_followup_closures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  closed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_followup_closure_per_lead UNIQUE (account_id, flow_run_id)
);

ALTER TABLE sales_followup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_followup_closures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_followup_attempts_select ON sales_followup_attempts;
CREATE POLICY sales_followup_attempts_select ON sales_followup_attempts FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS sales_followup_attempts_insert ON sales_followup_attempts;
CREATE POLICY sales_followup_attempts_insert ON sales_followup_attempts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS sales_followup_attempts_update ON sales_followup_attempts;
CREATE POLICY sales_followup_attempts_update ON sales_followup_attempts FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS sales_followup_attempts_delete ON sales_followup_attempts;
CREATE POLICY sales_followup_attempts_delete ON sales_followup_attempts FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS sales_followup_closures_select ON sales_followup_closures;
CREATE POLICY sales_followup_closures_select ON sales_followup_closures FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS sales_followup_closures_insert ON sales_followup_closures;
CREATE POLICY sales_followup_closures_insert ON sales_followup_closures FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS sales_followup_closures_update ON sales_followup_closures;
CREATE POLICY sales_followup_closures_update ON sales_followup_closures FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS sales_followup_closures_delete ON sales_followup_closures;
CREATE POLICY sales_followup_closures_delete ON sales_followup_closures FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Preserve existing pending schedules: every lead whose
-- "Next Follow-up Date & Time" cell holds a value becomes attempt 1
-- (origin 'migrated', unresolved). No results are invented, nothing
-- is marked completed, and leads that already have attempt rows are
-- skipped (never duplicated).
INSERT INTO sales_followup_attempts (
  account_id, flow_id, flow_run_id, attempt_number, scheduled_at, origin
)
SELECT
  v.account_id,
  f.flow_id,
  v.flow_run_id,
  1,
  v.value_text::timestamptz,
  'migrated'
FROM workspace_values v
JOIN workspace_fields f ON f.id = v.field_id
JOIN flow_runs r ON r.id = v.flow_run_id
WHERE lower(btrim(f.name)) = 'next follow-up date & time'
  AND f.field_type = 'datetime'
  AND v.value_text IS NOT NULL
  AND btrim(v.value_text) <> ''
  AND v.account_id = f.account_id
  AND r.account_id = v.account_id
  AND NOT EXISTS (
    SELECT 1 FROM sales_followup_attempts a
    WHERE a.account_id = v.account_id AND a.flow_run_id = v.flow_run_id
  )
ON CONFLICT DO NOTHING;
