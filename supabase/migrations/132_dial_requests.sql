// ============================================================
// 132_dial_requests.sql — secure desktop → CallVault dial handoff.
//
// A dial request is NOT proof of a call. It records that a
// Workspace user asked an authorized CallVault device to open
// the native dialer (ACTION_DIAL) with a number prefilled. The
// eventual carrier call (if the user places it) flows through
// the existing call_recordings / call_events pipeline unchanged.
//
// Lifecycle: pending → delivered → opened → completed / expired /
//   cancelled / failed. One-time consumption: `consumed_at` is set
// when a device first opens the request; replays 409.
// Expiry: `expires_at` (default +10 min); reads treat past-expiry
// pending rows as expired (lazy) without a cron dependency.
// Dedupe: UNIQUE(account_id, idempotency_key) makes rapid double
// clicks return the same row instead of two notifications.
// Ownership: account-scoped like every parent table (017).
// RLS: members read their account's rows; agent+ writes (devices
// post through the service-role path with account fixed at
// credential lookup, same as call_events).
// Idempotent — safe to re-run.
// ============================================================

CREATE TABLE IF NOT EXISTS dial_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  phone_number    text NOT NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  flow_id         uuid REFERENCES flows(id) ON DELETE SET NULL,
  run_id          text,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','opened','completed','expired','cancelled','failed')),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at     timestamptz,
  delivered_at    timestamptz,
  opened_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dial_requests_idempotency_unique UNIQUE (account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS dial_requests_account_status_idx
  ON dial_requests (account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS dial_requests_account_expires_idx
  ON dial_requests (account_id, expires_at);

ALTER TABLE dial_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dial_requests_select ON dial_requests;
CREATE POLICY dial_requests_select ON dial_requests FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS dial_requests_insert ON dial_requests;
CREATE POLICY dial_requests_insert ON dial_requests FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS dial_requests_update ON dial_requests;
CREATE POLICY dial_requests_update ON dial_requests FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS dial_requests_delete ON dial_requests;
CREATE POLICY dial_requests_delete ON dial_requests FOR DELETE
  USING (is_account_member(account_id, 'agent'));
