-- ============================================================
-- repair-inbox-assignment-drift.sql — one-time reconciliation of
-- Workspace Assigned To -> conversations.assigned_agent_id.
--
-- BACKGROUND: Workspace assignment writes (per-table auto engine,
-- manual assign service, Workspace cell edits) now mirror to the
-- linked WhatsApp thread at write time (see
-- src/lib/inbox/assignment-sync.ts). Rows assigned BEFORE those
-- mirrors existed were left with conversations.assigned_agent_id
-- = NULL while Workspace shows an owner, so agents cannot see
-- those threads in the Inbox.
--
-- SCOPE: LOCAL / REVIEW ONLY. Do NOT apply in production without
-- owner review and a backup. Never run against production data
-- unless explicitly instructed.
--
-- VERIFIED TARGET (2026-11-05 dry run): account
-- 3f5b2105-cd30-4df0-abf6-d9b97ed48246, owner
-- 9db793d7-b591-49e2-a5ca-e5b77816ea5e (Saniya) — exactly 19
-- unassigned threads. The :OWNER_ID predicate scopes both
-- statements to one salesperson, so no other member's threads
-- (e.g. Canara Tales) can ever match.
--
-- SAFETY RULES (built into the UPDATE below):
--   1. Only touches threads that are currently UNASSIGNED
--      (assigned_agent_id IS NULL) — never overwrites an explicit
--      assignment, so Inbox-side decisions always win.
--   2. Only copies stable member UUIDs (UUID-shaped values);
--      "Unassigned" / legacy display strings map to NULL (no-op).
--   3. Matches strictly through the stable relationship
--      flow_runs.contact_id = conversations.contact_id within ONE
--      account (both sides scoped by the same account_id).
--   4. One row per run: if a run somehow has several Assigned To
--      cells, the most recently updated wins.
-- ============================================================

-- ---- Step 0: DRY RUN — inspect what would change -------------
-- Replace :ACCOUNT_ID / :OWNER_ID with the verified UUIDs above
-- before running. SELECT only — changes nothing.
WITH latest_owner AS (
  SELECT DISTINCT ON (wv.flow_run_id)
    wv.flow_run_id,
    wv.value_text AS owner_id,
    fr.contact_id
  FROM public.workspace_values wv
  JOIN public.workspace_fields wf
    ON wf.id = wv.field_id
   AND wf.account_id = wv.account_id
   AND btrim(lower(wf.name)) = 'assigned to'
  JOIN public.flow_runs fr
    ON fr.id = wv.flow_run_id
   AND fr.account_id = wv.account_id
  WHERE wv.account_id = :ACCOUNT_ID
    AND wv.value_text = :OWNER_ID
    AND wv.value_text ~ '^[0-9a-fA-F-]{36}$'
  ORDER BY wv.flow_run_id, wv.updated_at DESC
)
SELECT
  c.id AS conversation_id,
  ct.name AS contact_name,
  ct.phone AS contact_phone,
  c.assigned_agent_id AS current_assignee,
  lo.owner_id AS workspace_owner
FROM latest_owner lo
JOIN public.conversations c
  ON c.account_id = :ACCOUNT_ID
 AND c.contact_id = lo.contact_id
JOIN public.contacts ct
  ON ct.id = lo.contact_id
 AND ct.account_id = :ACCOUNT_ID
WHERE c.assigned_agent_id IS NULL;

-- ---- Step 1: APPLY — adopt the Workspace owner onto ------------
-- ---- unassigned threads only ----------------------------------
-- Same predicates as the dry run (same account, same owner, NULL
-- assignees only); the UPDATE can only fill NULLs. No INSERT, so
-- no duplicate conversation can ever be created. DO NOT RUN
-- without explicit instruction.
WITH latest_owner AS (
  SELECT DISTINCT ON (wv.flow_run_id)
    wv.flow_run_id,
    wv.value_text AS owner_id,
    fr.contact_id
  FROM public.workspace_values wv
  JOIN public.workspace_fields wf
    ON wf.id = wv.field_id
   AND wf.account_id = wv.account_id
   AND btrim(lower(wf.name)) = 'assigned to'
  JOIN public.flow_runs fr
    ON fr.id = wv.flow_run_id
   AND fr.account_id = wv.account_id
  WHERE wv.account_id = :ACCOUNT_ID
    AND wv.value_text = :OWNER_ID
    AND wv.value_text ~ '^[0-9a-fA-F-]{36}$'
  ORDER BY wv.flow_run_id, wv.updated_at DESC
)
UPDATE public.conversations c
SET assigned_agent_id = lo.owner_id::uuid,
    updated_at = now()
FROM latest_owner lo
WHERE c.account_id = :ACCOUNT_ID
  AND c.contact_id = lo.contact_id
  AND c.assigned_agent_id IS NULL;
