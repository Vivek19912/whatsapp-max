-- ============================================================
-- 149_agent_inbox_permissions.sql — per-agent Inbox permission grants
--
-- Two independent, owner-managed flags per agent:
--   can_manage_assignments — assign/reassign ANY conversation
--                            (Workspace + Inbox assign paths).
--   can_view_all           — read every Inbox conversation.
-- Either, both, or neither may be set. Defaults are all false:
-- a fresh agent row grants nothing.
--
-- Enforcement (belt and suspenders):
--   1. RLS: conversations_select gains a view_all branch so the
--      data layer itself admits permitted agents (direct PostgREST,
--      SECURITY INVOKER search RPC, realtime delivery). The manager
--      write path stays API-only (assign route, service-role) so
--      every cross-thread assignment also mirrors to Workspace.
--   2. Server routes resolve the same rule in code (explicit 403/404
--      + audit logging) and never trust the client.
--
-- SOLE writer of this table is PUT /api/account/agent-permissions
-- (requireRole("owner")). Agents can read only their own row (for
-- UI gating); owners read the whole account matrix. No other role
-- can insert/update/delete — enforced by RLS below AND by the
-- route's requireRole("owner").
--
-- Does NOT change: 148's update/delete policies, messages RLS
-- (inherits via the parent conversation), pins, hide, search RPC
-- shape, or any existing table. Additive only.
--
-- Idempotent — DROP IF EXISTS + CREATE / CREATE IF NOT EXISTS
-- throughout; safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.agent_inbox_permissions (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  can_manage_assignments BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_all BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_inbox_permissions_pkey PRIMARY KEY (account_id, user_id)
);

-- Keep updated_at fresh (same trigger as other tables since 001).
DROP TRIGGER IF EXISTS set_updated_at ON public.agent_inbox_permissions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.agent_inbox_permissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- RLS: owners manage the matrix; agents read only their own row.
-- ============================================================
ALTER TABLE public.agent_inbox_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_inbox_permissions_select ON public.agent_inbox_permissions;
CREATE POLICY agent_inbox_permissions_select ON public.agent_inbox_permissions FOR SELECT
  USING (
    is_account_member(account_id, 'owner')
    OR (user_id = auth.uid() AND is_account_member(account_id))
  );

DROP POLICY IF EXISTS agent_inbox_permissions_insert ON public.agent_inbox_permissions;
CREATE POLICY agent_inbox_permissions_insert ON public.agent_inbox_permissions FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS agent_inbox_permissions_update ON public.agent_inbox_permissions;
CREATE POLICY agent_inbox_permissions_update ON public.agent_inbox_permissions FOR UPDATE
  USING (is_account_member(account_id, 'owner'))
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS agent_inbox_permissions_delete ON public.agent_inbox_permissions;
CREATE POLICY agent_inbox_permissions_delete ON public.agent_inbox_permissions FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- ============================================================
-- SECURITY DEFINER helper for use inside RLS policies (bypasses
-- RLS on this table the way is_account_member bypasses profiles).
-- 'manage_assignments' | 'view_all'. Unknown perm strings match
-- nothing (fail-closed).
-- ============================================================
CREATE OR REPLACE FUNCTION public.has_inbox_permission(
  target_account_id UUID,
  perm TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agent_inbox_permissions p
    JOIN public.profiles prof
      ON prof.user_id = p.user_id
     AND prof.account_id = p.account_id
    WHERE p.account_id = target_account_id
      AND p.user_id = auth.uid()
      AND prof.account_role = 'agent'
      AND (
        (perm = 'manage_assignments' AND p.can_manage_assignments)
        OR (perm = 'view_all' AND p.can_view_all)
      )
  );
$$;

ALTER FUNCTION public.has_inbox_permission(UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.has_inbox_permission(UUID, TEXT) TO authenticated;

-- ============================================================
-- Conversations read gate: admit view_all agents alongside the
-- 148 rule (owner/admin | own assignment | viewer legacy).
-- DROP + CREATE (not CREATE OR REPLACE — the predicate changes).
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR assigned_agent_id = auth.uid()
    OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent'))
    OR has_inbox_permission(account_id, 'view_all')
  );
