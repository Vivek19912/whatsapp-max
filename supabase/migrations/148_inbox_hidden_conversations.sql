-- ============================================================
-- 148_inbox_hidden_conversations.sql -- Inbox Hide Conversations table
--
-- The production table `public.inbox_hidden_conversations` was
-- created via the Supabase dashboard (no migration captured it).
-- This migration encodes the exact live contract so fresh
-- environments, previews, and restores get the identical table.
-- It changes NOTHING on databases where the table already exists:
-- every statement is IF NOT EXISTS / DROP-then-CREATE.
--
-- Live contract (verified read-only against production):
--   columns: id, account_id, conversation_id, hidden_by, hidden_at
--   one row per (account_id, conversation_id) -- the hide API
--   upserts on that conflict target, so re-hiding is a no-op.
--   hiding never deletes conversation/message/contact rows;
--   unhiding deletes the row and restores visibility.
--
-- Authorization: owner-only writes are enforced in the API
-- (requireRole("owner") plus tenant conversation lookup in
-- src/app/api/inbox/conversations/[id]/hide/route.ts). RLS below
-- enforces tenant scope in depth (members of the account only).
--
-- No FK constraints are added to pre-existing tables: the dashboard
-- table has operated without them, orphan hidden rows are harmless
-- (filterHidden simply never matches a missing conversation), and a
-- retroactive FK could fail on legacy data. Fresh databases get the
-- FKs inline in the CREATE TABLE below.
--
-- Idempotent -- safe to run multiple times. Does NOT backfill,
-- modify, or delete any existing rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.inbox_hidden_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  hidden_by UUID NULL,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The upsert conflict target used by the hide API
-- (onConflict: "account_id,conversation_id"). IF NOT EXISTS so this
-- is a no-op where the dashboard already created the equivalent.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_hidden_conversations_account_conversation_key
  ON public.inbox_hidden_conversations(account_id, conversation_id);

-- Supports the ON DELETE CASCADE from conversations and any
-- "who hid this conversation" lookups.
CREATE INDEX IF NOT EXISTS idx_inbox_hidden_conversation
  ON public.inbox_hidden_conversations(conversation_id);

-- ============================================================
-- RLS -- tenant-scoped members only. Owner-only writes are enforced
-- in the hide API (requireRole("owner")); these policies keep every
-- row invisible outside its own account in depth. The UPDATE policy
-- exists because re-hiding (upsert on conflict) writes through an
-- UPDATE path under the caller session.
-- ============================================================
ALTER TABLE public.inbox_hidden_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_hidden_select ON public.inbox_hidden_conversations;
CREATE POLICY inbox_hidden_select ON public.inbox_hidden_conversations FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS inbox_hidden_insert ON public.inbox_hidden_conversations;
CREATE POLICY inbox_hidden_insert ON public.inbox_hidden_conversations FOR INSERT
  WITH CHECK (is_account_member(account_id));

DROP POLICY IF EXISTS inbox_hidden_update ON public.inbox_hidden_conversations;
CREATE POLICY inbox_hidden_update ON public.inbox_hidden_conversations FOR UPDATE
  USING (is_account_member(account_id))
  WITH CHECK (is_account_member(account_id));

DROP POLICY IF EXISTS inbox_hidden_delete ON public.inbox_hidden_conversations;
CREATE POLICY inbox_hidden_delete ON public.inbox_hidden_conversations FOR DELETE
  USING (is_account_member(account_id));