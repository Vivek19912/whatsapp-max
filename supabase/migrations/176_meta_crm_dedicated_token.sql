-- 176_meta_crm_dedicated_token.sql
--
-- Meta CRM Feedback: dedicated access token, stored separately from
-- the Meta Lead Ads connection credential.
--
-- The CRM Feedback integration must NEVER use the Meta Lead Ads
-- connection token (meta_lead_connections.access_token) for dataset
-- verification or event delivery. This column holds the dedicated
-- CRM token entered in Settings → Meta → CRM Integration, AES-256-GCM
-- encrypted by the application (same mechanism as the connection
-- tokens) — never plaintext, never returned by any API.

ALTER TABLE public.meta_crm_config
  ADD COLUMN IF NOT EXISTS access_token TEXT;

COMMENT ON COLUMN public.meta_crm_config.access_token IS
  'Dedicated Meta CRM access token for feedback verification and event delivery, application-encrypted (AES-256-GCM). Replaces any use of the Meta Lead Ads connection token. Never returned by APIs.';
