-- ============================================================
-- 117_workspace_row_prefs.sql — Per-user pin/hide Workspace rows
--
-- Lets a team member pin important leads (they float to the top of
-- their Workspace table) and hide unwanted rows (removed from their
-- table without touching any lead or flow-run data). Both states are
-- PER USER per flow: one teammate pinning or hiding a row must not
-- affect anyone else's Workspace.
--
-- What this migration does
--   1. `workspace_row_prefs` — one row per (user, flow, flow_run)
--      preference, carrying account_id for tenant scoping + fast
--      reads and is_pinned / is_hidden flags. Rows whose flags are
--      both false are deleted (no empty preference rows pile up).
--      UNIQUE(user_id, flow_id, flow_run_id) makes a duplicate
--      preference impossible at the DB level, so repeated pin
--      toggles can never create duplicate records.
--   2. RLS: a member may only SELECT their OWN prefs, and only
--      inside an account they belong to. There are deliberately NO
--      client INSERT/UPDATE/DELETE policies — every write goes
--      through the two SECURITY DEFINER RPCs below, so row-id and
--      flow-id validation cannot be bypassed by writing directly.
--   3. `set_workspace_row_pref` / `restore_workspace_hidden_rows`
--      RPCs that self-check the caller, enforce tenant isolation
--      (the run must belong to the caller's account AND the given
--      flow — missing, deleted, or cross-account runs read as "not
--      found"), keep pin and hide state independent, and are
--      idempotent (re-pinning / re-hiding is a no-op success).
--   4. `get_flow_table_rows` (094) is redefined with the SAME
--      signature — existing callers are unaffected — plus two
--      additive behaviors for the CALLING user only:
--        - rows they hid are excluded from the filtered set, so
--          `total`, the page slice, and row numbering all stay
--          correct (hidden rows never leak back via sorting,
--          filters, views, search, or pagination);
--        - rows they pinned sort first, with the existing
--          view-dependent ordering applied WITHIN the pinned and
--          unpinned groups (pinned rows stay subject to search
--          and filters — pinning never bypasses them).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS workspace_row_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The member who pinned/hid. auth.users, not profiles — matches
  -- every other user_id FK in the schema (e.g. conversation_pins
  -- in 054) and cascades on user deletion.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Denormalised tenant key: lets the SELECT policy scope by account
  -- without a join, and lets a deleted account cascade its prefs away.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Flow scope: prefs belong to exactly one flow's Workspace, so one
  -- flow's pins/hides can never leak into another. Both cascade
  -- (flow delete, run delete).
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- Stable row identity: the flow_runs PK (the same identity the
  -- table payload exposes as runId) — never an array index, display
  -- position, or lead name.
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  -- Pin and hide are independent flags on ONE row: flipping one
  -- never touches the other.
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One preference per (user, flow, run): repeated toggles upsert,
  -- never duplicate.
  CONSTRAINT workspace_row_prefs_user_flow_run_key
    UNIQUE (user_id, flow_id, flow_run_id)
);

-- Hot path: "give me this user's prefs for this flow's Workspace".
CREATE INDEX IF NOT EXISTS idx_workspace_row_prefs_user_flow
  ON workspace_row_prefs (user_id, flow_id);
-- Tenant cleanup + "all prefs of this flow" reads.
CREATE INDEX IF NOT EXISTS idx_workspace_row_prefs_account_flow
  ON workspace_row_prefs (account_id, flow_id);
-- Supports the ON DELETE CASCADE from flow_runs and any "who pinned
-- or hid this run" lookups.
CREATE INDEX IF NOT EXISTS idx_workspace_row_prefs_run
  ON workspace_row_prefs (flow_run_id);

-- ============================================================
-- RLS
--
-- Read-only for clients, scoped to the caller's own prefs inside an
-- account they belong to. Writes are RPC-only (see below) so run-id
-- and flow-id validation can't be side-stepped.
-- ============================================================
ALTER TABLE workspace_row_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_row_prefs_select ON workspace_row_prefs;
CREATE POLICY workspace_row_prefs_select ON workspace_row_prefs FOR SELECT
  USING (user_id = auth.uid() AND is_account_member(account_id));

-- Keep updated_at fresh (same trigger as every table since 001).
DROP TRIGGER IF EXISTS set_updated_at ON workspace_row_prefs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_row_prefs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- set_workspace_row_pref(p_flow_id, p_flow_run_id, p_pinned, p_hidden)
--   -> { flow_run_id, pinned, hidden }
--
-- Sets the caller's pin and/or hide flag for one Workspace row.
-- NULL means "leave unchanged", so pin and hide stay independent:
-- toggling one never touches the other. When both flags end up
-- false the preference row is deleted (no empty rows accumulate).
--
-- Guarantees:
--   - auth required                              (42501)
--   - flow must belong to the caller's account   (P0002)
--   - run must belong to that flow AND account —
--     missing, deleted, or cross-account runs read as
--     "not found", never as an existence oracle   (22023)
--   - idempotent: repeating the same call succeeds and changes
--     nothing (the UNIQUE key + upsert make duplicates
--     impossible, even under concurrent toggles).
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_workspace_row_pref(
  p_flow_id UUID,
  p_flow_run_id UUID,
  p_pinned BOOLEAN DEFAULT NULL,
  p_hidden BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_flow_account_id UUID;
  v_run_ok BOOLEAN;
  v_pinned BOOLEAN;
  v_hidden BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Resolve caller's account (also proves they have a profile).
  SELECT account_id INTO v_caller_account_id
  FROM profiles WHERE user_id = v_user_id;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Flow must belong to the caller's account. Browser ids are never
  -- trusted as authority (same rule as the column-widths API).
  SELECT account_id INTO v_flow_account_id
  FROM flows WHERE id = p_flow_id;
  IF v_flow_account_id IS NULL OR v_flow_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = 'P0002';
  END IF;

  -- Run must belong to that flow (and therefore that account). A
  -- missing row and a cross-tenant row are indistinguishable to the
  -- caller by design (no existence oracle).
  SELECT EXISTS (
    SELECT 1 FROM flow_runs r
    WHERE r.id = p_flow_run_id
      AND r.flow_id = p_flow_id
      AND r.account_id = v_caller_account_id
  ) INTO v_run_ok;
  IF NOT v_run_ok THEN
    RAISE EXCEPTION 'Row not found in this flow'
      USING ERRCODE = '22023';
  END IF;

  -- Single-statement upsert: NULL preserves the stored flag, so the
  -- two states stay independent even under concurrent toggles.
  INSERT INTO workspace_row_prefs
    (user_id, account_id, flow_id, flow_run_id, is_pinned, is_hidden)
  VALUES (
    v_user_id, v_caller_account_id, p_flow_id, p_flow_run_id,
    COALESCE(p_pinned, FALSE), COALESCE(p_hidden, FALSE)
  )
  ON CONFLICT (user_id, flow_id, flow_run_id)
  DO UPDATE SET
    is_pinned = CASE WHEN p_pinned IS NULL
      THEN workspace_row_prefs.is_pinned ELSE p_pinned END,
    is_hidden = CASE WHEN p_hidden IS NULL
      THEN workspace_row_prefs.is_hidden ELSE p_hidden END,
    updated_at = now()
  RETURNING is_pinned, is_hidden INTO v_pinned, v_hidden;

  -- Both flags false = no preference: delete instead of keeping an
  -- empty row (unpin + restore converge here).
  IF NOT v_pinned AND NOT v_hidden THEN
    DELETE FROM workspace_row_prefs
    WHERE user_id = v_user_id
      AND flow_id = p_flow_id
      AND flow_run_id = p_flow_run_id;
  END IF;

  RETURN jsonb_build_object(
    'flow_run_id', p_flow_run_id,
    'pinned', v_pinned,
    'hidden', v_hidden
  );
END;
$$;

-- ============================================================
-- restore_workspace_hidden_rows(p_flow_id) -> restored count
--
-- Clears the caller's hidden flags for this flow ("Restore all").
-- Pin state is never touched: a pinned + hidden row stays pinned.
-- Idempotent — restoring when nothing is hidden returns 0.
-- ============================================================
CREATE OR REPLACE FUNCTION public.restore_workspace_hidden_rows(
  p_flow_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_flow_account_id UUID;
  v_restored INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_caller_account_id
  FROM profiles WHERE user_id = v_user_id;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_flow_account_id
  FROM flows WHERE id = p_flow_id;
  IF v_flow_account_id IS NULL OR v_flow_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = 'P0002';
  END IF;

  -- Clear hidden flags on the caller's rows only. Pins survive:
  -- only rows left with both flags false are deleted.
  UPDATE workspace_row_prefs
  SET is_hidden = FALSE, updated_at = now()
  WHERE user_id = v_user_id
    AND flow_id = p_flow_id
    AND is_hidden;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  DELETE FROM workspace_row_prefs
  WHERE user_id = v_user_id
    AND flow_id = p_flow_id
    AND NOT is_pinned
    AND NOT is_hidden;

  RETURN v_restored;
END;
$$;

-- SECURITY DEFINER functions run as their owner; make that explicit
-- and grant execute to authenticated callers only (mirrors 054).
ALTER FUNCTION public.set_workspace_row_pref(UUID, UUID, BOOLEAN, BOOLEAN) OWNER TO postgres;
ALTER FUNCTION public.restore_workspace_hidden_rows(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.set_workspace_row_pref(UUID, UUID, BOOLEAN, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.restore_workspace_hidden_rows(UUID) TO authenticated, service_role;

-- ============================================================
-- get_flow_table_rows — pin/hide awareness (same signature as 094;
-- existing callers are unaffected).
--
-- Two additive behaviors for the CALLING user only (both keyed by
-- auth.uid(), so one user's pins/hides can never affect another):
--   - hidden rows are excluded from the filtered set: `total`, the
--     page slice, and row numbering stay correct, and hidden rows
--     cannot resurface via sorting, filters, views, search, or
--     pagination;
--   - pinned rows sort first, with the existing view-dependent
--     ordering applied WITHIN the pinned and unpinned groups
--     (search and filters still apply to pinned rows — pinning
--     never bypasses them).
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_flow_table_rows(
  p_flow_id UUID,
  p_view TEXT DEFAULT 'all',
  p_search TEXT DEFAULT NULL,
  p_page INT DEFAULT 0,
  p_page_size INT DEFAULT 25,
  p_started_from TIMESTAMPTZ DEFAULT NULL,
  p_started_to TIMESTAMPTZ DEFAULT NULL,
  p_assignee TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_flow RECORD;
  v_page INT := GREATEST(COALESCE(p_page, 0), 0);
  v_page_size INT := LEAST(GREATEST(COALESCE(p_page_size, 25), 1), 100);
  v_offset INT;
  v_search TEXT := NULLIF(BTRIM(COALESCE(p_search, '')), '');
  v_assignee TEXT := NULLIF(BTRIM(COALESCE(p_assignee, '')), '');
  v_assignee_field_id UUID;
  v_result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id INTO v_account_id
  FROM profiles p
  WHERE p.user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  SELECT f.id, f.account_id, f.name, f.completion_node_id
  INTO v_flow
  FROM flows f
  WHERE f.id = p_flow_id;

  IF v_flow.id IS NULL OR v_flow.account_id IS DISTINCT FROM v_account_id THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_view IS NOT NULL AND p_view NOT IN ('all', 'completed', 'incomplete') THEN
    RAISE EXCEPTION 'Invalid view (all|completed|incomplete)' USING ERRCODE = '22023';
  END IF;

  -- "Assigned To" column for this flow (case-insensitive, same
  -- rule as the app). Missing/renamed → NULL and the assignee
  -- predicate below degrades gracefully.
  SELECT wf.id INTO v_assignee_field_id
  FROM workspace_fields wf
  WHERE wf.flow_id = p_flow_id
    AND lower(btrim(wf.name)) = 'assigned to'
  LIMIT 1;

  v_offset := v_page * v_page_size;

  WITH base AS (
    SELECT
      r.id AS run_id,
      r.contact_id AS contact_id,
      c.name AS contact_name,
      c.phone AS contact_phone,
      r.conversation_id AS conversation_id,
      r.status AS status,
      r.started_at AS started_at,
      r.last_advanced_at AS last_advanced_at,
      r.ended_at AS ended_at,
      r.vars AS vars,
      -- The caller's pin for this row (FALSE when never pinned).
      -- RLS on workspace_row_prefs scopes this join to the caller's
      -- own rows, so another user's pins can never leak in.
      COALESCE(rp.is_pinned, FALSE) AS is_pinned,
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN (
          SELECT MAX(e.created_at)
          FROM flow_run_events e
          WHERE e.flow_run_id = r.id
            AND e.node_key = v_flow.completion_node_id
        )
        ELSE NULL
      END AS reached_at
    FROM flow_runs r
    LEFT JOIN contacts c ON c.id = r.contact_id
    -- Personal row prefs: one row per (user, flow, run) at most, so
    -- this join can never fan out. Scoped to the caller — never to
    -- another user's preferences.
    LEFT JOIN workspace_row_prefs rp
      ON rp.flow_run_id = r.id
      AND rp.user_id = auth.uid()
    WHERE r.flow_id = p_flow_id
      AND r.account_id = v_account_id
      AND (
        v_search IS NULL
        OR c.name ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR c.phone ILIKE '%' || REPLACE(REPLACE(REPLACE(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
      -- Date filter: half-open window over Submission Time.
      AND (p_started_from IS NULL OR r.started_at >= p_started_from)
      AND (p_started_to IS NULL OR r.started_at < p_started_to)
      -- Assignee filter: conjunctive with view + search + date.
      AND (
        v_assignee IS NULL OR lower(v_assignee) = 'all'
        OR (
          lower(v_assignee) = 'unassigned'
          AND (
            v_assignee_field_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM workspace_values v
              WHERE v.field_id = v_assignee_field_id
                AND v.flow_run_id = r.id
                AND v.value_text IS NOT NULL
                AND btrim(v.value_text) <> ''
                AND v.value_text <> 'Unassigned'
            )
          )
        )
        OR (
          v_assignee_field_id IS NOT NULL
          AND lower(v_assignee) NOT IN ('all', 'unassigned')
          AND EXISTS (
            SELECT 1
            FROM workspace_values v
            WHERE v.field_id = v_assignee_field_id
              AND v.flow_run_id = r.id
              AND v.value_text = v_assignee
          )
        )
      )
      -- Hidden rows: the caller's hides are a visibility operation
      -- only — excluded here (rp NULL = never hidden), so they stay
      -- out of `total`, the page slice, and every view / filter /
      -- search combination. The underlying lead and flow-run rows
      -- are never touched.
      AND (rp.is_hidden IS NULL OR rp.is_hidden = FALSE)
  ),
  classified AS (
    SELECT
      b.*,
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN (b.reached_at IS NOT NULL)
        ELSE (b.status = 'completed')
      END AS is_completed,
      -- Real completion timestamp: custom-point reach time, else
      -- the END-completion timestamp. Used only by the completed
      -- view ordering below.
      CASE
        WHEN v_flow.completion_node_id IS NOT NULL THEN b.reached_at
        ELSE b.ended_at
      END AS completed_sort,
      -- Newest activity with submission fallback. Used only by
      -- the incomplete view ordering below.
      COALESCE(b.last_advanced_at, b.started_at) AS activity_sort
    FROM base b
  ),
  filtered AS (
    SELECT c.*
    FROM classified c
    WHERE p_view IS NULL OR p_view = 'all'
      OR (p_view = 'completed' AND c.is_completed)
      OR (p_view = 'incomplete' AND NOT c.is_completed)
  )
  SELECT jsonb_build_object(
    'flow', jsonb_build_object(
      'id', v_flow.id,
      'name', v_flow.name,
      'completion_node_id', v_flow.completion_node_id
    ),
    'total', (SELECT COUNT(*)::INT FROM filtered),
    'page', v_page,
    'page_size', v_page_size,
    'rows', COALESCE((
      SELECT jsonb_agg(
        row
        ORDER BY
          row_pinned DESC,
          CASE WHEN p_view = 'completed' THEN row_completed END DESC NULLS LAST,
          CASE WHEN p_view = 'incomplete' THEN row_activity END DESC NULLS LAST,
          CASE WHEN p_view NOT IN ('completed', 'incomplete') THEN row_started END DESC NULLS LAST,
          row_id DESC
      )
      FROM (
        SELECT jsonb_build_object(
          'run_id', f.run_id,
          'contact_id', f.contact_id,
          'contact_name', f.contact_name,
          'contact_phone', f.contact_phone,
          'conversation_id', f.conversation_id,
          'status', f.status,
          'started_at', f.started_at,
          'last_advanced_at', f.last_advanced_at,
          'ended_at', f.ended_at,
          'reached_at', f.reached_at,
          'is_completed', f.is_completed,
          'vars', COALESCE(f.vars, '{}'::JSONB)
        ) AS row,
        f.is_pinned AS row_pinned,
        f.completed_sort AS row_completed,
        f.activity_sort AS row_activity,
        f.started_at AS row_started,
        f.run_id AS row_id
        FROM filtered f
        ORDER BY
          f.is_pinned DESC,
          CASE WHEN p_view = 'completed' THEN f.completed_sort END DESC NULLS LAST,
          CASE WHEN p_view = 'incomplete' THEN f.activity_sort END DESC NULLS LAST,
          CASE WHEN p_view NOT IN ('completed', 'incomplete') THEN f.started_at END DESC NULLS LAST,
          f.run_id DESC
        LIMIT v_page_size OFFSET v_offset
      ) s
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
