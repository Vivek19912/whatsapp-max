-- 178_meta_crm_show_lead_quality.sql
--
-- Meta CRM Feedback: UI-only "Show Lead Quality Column" preference.
--
-- Controls only whether the Lead Quality column is displayed in the
-- Workspace table. Defaults to TRUE so existing users keep seeing
-- the column; hiding it changes no statuses, values, events, or
-- tokens — purely a display preference read by the Workspace page.

ALTER TABLE public.meta_crm_config
  ADD COLUMN IF NOT EXISTS show_lead_quality BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.meta_crm_config.show_lead_quality IS
  'UI-only preference: display the Lead Quality column in Workspace tables. Defaults to true; hiding changes nothing stored or sent.';
