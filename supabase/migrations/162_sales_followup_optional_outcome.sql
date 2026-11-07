-- ============================================================
-- 162_sales_followup_optional_outcome.sql — outcome optional on
-- completed sales follow-up attempts.
--
-- Product change: recording a result requires only the result
-- text; the outcome dropdown is optional. The 161 completion
-- consistency constraint demanded a non-null outcome, so it is
-- replaced here (161 is left untouched — this migration applies
-- cleanly whether or not 161 has already run, and preserves every
-- existing row: all previously saved outcomes satisfy the
-- unchanged outcome-membership CHECK).
--
-- New rule for a completed attempt: non-blank result_text +
-- completed_by + completed_at. Outcome stays NULL-able and, when
-- present, must still be one of the eight allowed values.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_followup_attempts_completed_by_check'
  ) THEN
    ALTER TABLE sales_followup_attempts
      DROP CONSTRAINT sales_followup_attempts_completed_by_check;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_followup_attempts_completed_check'
  ) THEN
    ALTER TABLE sales_followup_attempts
      ADD CONSTRAINT sales_followup_attempts_completed_check CHECK (
        (completed_at IS NULL AND completed_by IS NULL AND result_text IS NULL)
        OR (
          completed_at IS NOT NULL
          AND completed_by IS NOT NULL
          AND result_text IS NOT NULL
          AND length(btrim(result_text)) > 0
        )
      );
  END IF;
END
$$;
