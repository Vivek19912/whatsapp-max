-- ============================================================
-- 182_lead_quality_junk.sql — replace "Disqualified Lead" with "Junk".
--
-- Dropdown: new and existing "Lead Quality" single_select columns
-- offer Clear, Lead, Interested Lead, Qualified Lead,
-- Booking Confirmed, Junk. Stored column options are rewritten
-- in place (same position, no reorder).
--
-- History is preserved, never modified:
-- - workspace_values rows already saved as "Disqualified Lead"
--   keep their value (chips still render the red badge).
-- - meta_crm_events rows with event_name 'DisqualifiedLead'
--   keep their value — the ledger CHECK keeps accepting it, and
--   the drain/preview code paths are unchanged.
--
-- Selecting Junk only stores the status. Delivery stays
-- manual-only via the existing Send to Meta button, which maps
-- the saved "Junk" status to the "Junk" CRM event through the
-- shared leadQualityToEvent mapper (same string pass-through
-- as every other event — no wire-format change).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Ledger: accept the new "Junk" event alongside every historical
-- name (inline CHECK from 175 is named
-- meta_crm_events_event_name_check by Postgres convention).
ALTER TABLE public.meta_crm_events
  DROP CONSTRAINT IF EXISTS meta_crm_events_event_name_check;
ALTER TABLE public.meta_crm_events
  ADD CONSTRAINT meta_crm_events_event_name_check CHECK (event_name IN (
    'Lead',
    'InterestedLead',
    'QualifiedLead',
    'BookingConfirmed',
    'DisqualifiedLead',
    'Junk'
  ));

-- Stored dropdown options: swap the retired outcome for Junk in
-- every Lead Quality single_select column. Values already saved
-- on leads are untouched — only the selectable option set.
UPDATE public.workspace_fields
SET options = (
  SELECT jsonb_agg(
    CASE
      WHEN elem = '"Disqualified Lead"'::jsonb THEN '"Junk"'::jsonb
      ELSE elem
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(options) WITH ORDINALITY AS t(elem, ord)
)
WHERE lower(btrim(name)) = 'lead quality'
  AND field_type = 'single_select'
  AND options @> '["Disqualified Lead"]'::jsonb;
