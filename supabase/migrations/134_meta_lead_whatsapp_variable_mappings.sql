-- ============================================================
-- 134_meta_lead_whatsapp_variable_mappings.sql — per-template
-- variable → Workspace field mappings for Meta Lead Ads
-- WhatsApp auto-send ONLY.
--
-- Scope protection: this migration touches ONLY the new
-- `meta_lead_whatsapp_templates` table (adds one nullable-shape
-- JSONB column). It does NOT alter flows, flow_runs,
-- workspace_*, message_templates, whatsapp_config, the queue
-- ledger, or any Flow Tables / All Sheets / Travel CRM state.
--
-- Design:
--   * Each row of `meta_lead_whatsapp_templates` already
--     identifies one template in one table's send sequence
--     (account, form, name, language). `variable_mappings` stores
--     that template's variable → Workspace field map, e.g.
--       {"body:1": "name", "body:2": "answer:full_name",
--        "button:0:1": "phone"}
--     Slot keys are `body:<N>`, `header:1`, or
--     `button:<buttonIndex>:1`. Field keys are the table's
--     variable field catalog (standard keys like `name`,
--     `phone`, or `answer:<questionKey>` for Instant Form
--     answers). Exactly the granularity required: separate per
--     table AND per template — sibling tables and sibling
--     templates never share mappings.
--   * Existing rows default to '{}' (static templates keep
--     working unchanged). No queue rows are touched: no reset,
--     no duplication, no history loss. Shape validation lives in
--     the API layer so error messages can name the offending
--     slot; the DB stores the JSON verbatim.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.meta_lead_whatsapp_templates
  ADD COLUMN IF NOT EXISTS variable_mappings JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.meta_lead_whatsapp_templates.variable_mappings IS
  'Variable → Workspace field map for this table template, e.g. {"body:1": "name"}. Slot keys are body:<N>, header:1, or button:<buttonIndex>:1; field keys are standard variable fields (name, phone, ...) or answer:<questionKey>. Empty object = static template (no variables).';
