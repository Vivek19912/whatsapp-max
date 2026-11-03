-- ============================================================
-- 148_inbox_assignment_access.sql — assignment-scoped Inbox access
--
-- Problem: conversations_select (017) lets EVERY account member —
-- including agents — read EVERY thread in the account. Assignment
-- (assigned_agent_id) was display/filter metadata only, never an
-- access predicate. Any agent could list, open by direct URL/ID,
-- search, hydrate, and realtime-receive any teammate's or any
-- unassigned conversation.
--
-- Fix: predicate Inbox row visibility on assignment, centrally in
-- RLS — the only layer that covers direct PostgREST reads, the
-- SECURITY INVOKER search RPC, hydration fetches, AND realtime
-- postgres_changes delivery. API routes keep their own explicit
-- checks for precise 403s, but they can no longer be bypassed.
--
-- Visibility rule (mirrored by canViewConversation in
-- src/lib/inbox/assignment-access.ts — keep them in sync):
--   - owner OR admin  -> every thread in their account (unchanged).
--   - agent           -> only threads assigned to themselves.
--   - viewer          -> unchanged legacy read-all (read-only role;
--                        directory-level reads elsewhere already
--                        assume account-wide visibility).
-- Unassigned threads are owner/admin-only; agents never see them.
--
-- Messages need NO policy change: messages_select / messages_modify
-- scope through an EXISTS on the parent conversation, and that inner
-- scan is itself RLS-filtered — revoking a thread automatically
-- revokes its messages, reactions lookups, and realtime delivery.
--
-- Writes:
--   - conversations_update USING tightened the same way (old row must
--     be visible); WITH CHECK keeps today's bar (any same-account
--     agent) so legitimate reassign-to-teammate still validates.
--     Webhook/auto-assign/automation paths use the service-role or
--     admin client and bypass RLS, so server-side assignment keeps
--     working.
--   - conversations_delete restricted to owner/admin (no UI or server
--     path deletes threads as an agent; destructive op).
--   - conversations_insert unchanged (agent+ may open threads; a
--     thread they create unassigned is simply invisible to them
--     until an owner/admin assigns it).
--
-- No schema change, no data change, no new tables. Idempotent —
-- DROP IF EXISTS + CREATE, safe to run multiple times.
--
-- Coverage (single enforcement point): direct PostgREST reads,
-- SECURITY INVOKER RPCs (search/hydration run as the caller, so the
-- same predicates apply), and realtime postgres_changes delivery
-- (filtered by these same row policies) are all gated here. API
-- routes add explicit checks for precise 403s, but they can no
-- longer be bypassed at the data layer.
-- ============================================================

-- Read: owner/admin see all; agents see only their own threads;
-- viewers keep legacy read-all. Unassigned threads are
-- owner/admin-only.
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR assigned_agent_id = auth.uid()
    OR (
      is_account_member(account_id)
      AND NOT is_account_member(account_id, 'agent')
    )
  );

-- Update: the old row must be visible (same rule as SELECT), so an
-- agent can only touch threads assigned to them; admins keep full
-- access. New-row check unchanged (any same-account agent) so
-- reassign-to-teammate keeps validating exactly as before.
DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR assigned_agent_id = auth.uid()
    OR (
      is_account_member(account_id)
      AND NOT is_account_member(account_id, 'agent')
    )
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

-- Delete: destructive op, owner/admin only. No UI or server path
-- deletes threads as a non-privileged member today.
DROP POLICY IF EXISTS conversations_delete ON public.conversations;
CREATE POLICY conversations_delete ON public.conversations FOR DELETE
  USING (is_account_member(account_id, 'admin'));
