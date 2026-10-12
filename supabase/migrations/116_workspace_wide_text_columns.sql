-- ============================================================
-- 116_workspace_wide_text_columns.sql — doubled width for the
-- two long-text Workspace columns.
--
-- "Customer Response" and "Next Action" render at exactly twice
-- their previous natural width: 2 × 224px (`max-w-56`) = 448px
-- (`max-w-112`), inside the 80–500 safe band enforced by the
-- column-widths API. The live table also falls back to 448px in
-- code (`defaultColumnWidthsForFields`), so this seed only makes
-- the doubled width explicit for columns provisioned before that
-- fallback shipped.
--
-- Scope is surgical: only rows for fields named (case-insensitive)
-- "Customer Response" / "Next Action", only where NO width row
-- exists yet (ON CONFLICT DO NOTHING) — every saved user width,
-- on these or any other columns, is left byte-for-byte intact.
-- Google Sheets never reads either table.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

INSERT INTO workspace_column_widths (account_id, flow_id, column_key, width_px)
SELECT
  f.account_id,
  f.flow_id,
  'custom:' || f.id::text,
  448
FROM workspace_fields f
WHERE lower(btrim(f.name)) IN ('customer response', 'next action')
ON CONFLICT ON CONSTRAINT workspace_column_widths_key_unique
DO NOTHING;
