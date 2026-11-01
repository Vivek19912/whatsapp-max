-- ============================================================
-- 143_message_delivery_errors.sql — persist Meta WhatsApp status
-- callback errors[] per message.
--
-- `handleStatusUpdate` previously mirrored only `status` onto
-- `messages`, discarding Meta's error code/title/message. That made
-- delivery failures (e.g. template/media errors) undiagnosable after
-- the fact. This table keeps one row per reported error entry:
--
--   provider_message_id = Meta wamid (always known, even when no
--     local row matches)
--   message_id = our messages.id when resolvable, else NULL
--   code/title/message/details = Meta's error payload (no secrets:
--     code, title, message, href only)
--   provider_timestamp = Meta's status.timestamp
--
-- Append-only from the service role; clients get SELECT only.
-- Forward-only status rules on `messages` are unchanged.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS message_delivery_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id UUID NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  code INTEGER NULL,
  title TEXT NULL,
  message TEXT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_timestamp TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_errors_provider
  ON message_delivery_errors (provider_message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_errors_account
  ON message_delivery_errors (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_errors_message
  ON message_delivery_errors (message_id)
  WHERE message_id IS NOT NULL;

ALTER TABLE message_delivery_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_errors_select ON message_delivery_errors;
CREATE POLICY delivery_errors_select ON message_delivery_errors
  FOR SELECT USING (is_account_member(account_id));
