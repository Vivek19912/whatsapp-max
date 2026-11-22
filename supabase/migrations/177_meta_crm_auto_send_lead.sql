-- 177_meta_crm_auto_send_lead.sql
--
-- Meta CRM Feedback: opt-in automatic initial Lead events.
--
-- `auto_send_lead` lets a workspace choose to enqueue the initial
-- `Lead` CRM event automatically when a new Meta Instant Form lead
-- is received. Defaults to FALSE so no automatic sending begins
-- without explicit activation; all later stages
-- (InterestedLead/QualifiedLead/BookingConfirmed/DisqualifiedLead)
-- stay manual regardless. Sending still uses the dedicated CRM
-- token and the existing durable outbox (deduplicated per lead).

ALTER TABLE public.meta_crm_config
  ADD COLUMN IF NOT EXISTS auto_send_lead BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.meta_crm_config.auto_send_lead IS
  'Opt-in: automatically enqueue the initial Lead CRM event on new Meta Instant Form leads. Defaults to false; later stages stay manual.';
