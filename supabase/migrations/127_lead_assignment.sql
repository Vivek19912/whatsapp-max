-- ============================================================
-- 127_lead_assignment.sql — Workspace Meta Lead Ads Lead Assignment.
--
-- Automatic, rule-based assignment of incoming Meta leads to team
-- members. Strictly separate from Chat Assignment (its tables,
-- APIs, and engine are untouched): own rules, own state, own
-- service. Applies ONLY to Meta Lead Ads Tables (flows.kind =
-- 'meta_lead_ads'); Flow Tables never read or write these tables.
--
-- Model:
--   lead_assignment_rules         one row per setup (name, scope,
--                               mode, status). scope 'specific' acts
--                               on its rule_tables rows; scope 'all'
--                               is the fallback for every other Meta
--                               table, including tables connected
--                               later (resolved dynamically).
--   lead_assignment_rule_tables   (rule_id, form_id) for specific
--                               rules. form_id is meta_lead_forms.id
--                               (stable internal UUID, never the
--                               display name).
--   lead_assignment_rule_members  (rule_id, user_id, position,
--                               weight). position = RR order,
--                               weight = SWRR percentage 0-100.
--                               user_id is profiles.user_id.
--   lead_assignment_table_state   per-(rule, table) algorithm state:
--                               RR cursor + SWRR current weights +
--                               version for compare-and-swap updates.
--                               Never shared across tables.
--   lead_assignment_events        audit trail (auto/manual/unassigned
--                               decisions with actor + prev/new).
--
-- Lead ownership itself reuses the existing "Assigned To"
-- workspace_values cell (value = member user_id) — no duplicate
-- ownership column. The unique workspace_values(field_id,
-- flow_run_id) constraint is the idempotency backstop.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- rules ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lead_assignment_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  scope TEXT NOT NULL CHECK (scope IN ('specific', 'all')),
  mode TEXT NOT NULL CHECK (mode IN ('round_robin', 'swrr')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one ACTIVE All-Tables fallback per account. Paused
-- fallbacks may coexist (only one can be activated at a time —
-- enforced by the API on status change).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_assignment_active_fallback
  ON public.lead_assignment_rules (account_id)
  WHERE scope = 'all' AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_lead_assignment_rules_account
  ON public.lead_assignment_rules (account_id);

-- ---- specific-table targets -------------------------------------
CREATE TABLE IF NOT EXISTS public.lead_assignment_rule_tables (
  rule_id UUID NOT NULL REFERENCES public.lead_assignment_rules(id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES public.meta_lead_forms(id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, form_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_assignment_tables_form
  ON public.lead_assignment_rule_tables (form_id);

-- ---- members ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lead_assignment_rule_members (
  rule_id UUID NOT NULL REFERENCES public.lead_assignment_rules(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  position INT NOT NULL CHECK (position >= 0),
  weight INT NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 100),
  PRIMARY KEY (rule_id, user_id)
);

-- ---- per-table algorithm state ----------------------------------
CREATE TABLE IF NOT EXISTS public.lead_assignment_table_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES public.lead_assignment_rules(id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES public.meta_lead_forms(id) ON DELETE CASCADE,
  rr_cursor BIGINT NOT NULL DEFAULT 0,
  current_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, form_id)
);

-- ---- audit events -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.lead_assignment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  rule_id UUID REFERENCES public.lead_assignment_rules(id) ON DELETE SET NULL,
  flow_id UUID,
  flow_run_id UUID,
  form_id UUID,
  assigned_user_id TEXT,
  previous_user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual', 'unassigned', 'cleared')),
  reason TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_assignment_events_account
  ON public.lead_assignment_events (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_assignment_events_run
  ON public.lead_assignment_events (flow_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_assignment_events_rule
  ON public.lead_assignment_events (rule_id, created_at DESC);

-- ---- RLS (mirror Chat Assignment conventions) -------------------
ALTER TABLE public.lead_assignment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_rule_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_rule_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_table_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_events ENABLE ROW LEVEL SECURITY;

-- Members read everything in their account.
CREATE POLICY "Members can read own account lead assignment rules"
  ON public.lead_assignment_rules FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
  ));
CREATE POLICY "Members can read own account lead assignment targets"
  ON public.lead_assignment_rule_tables FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.lead_assignment_rules r
    WHERE r.id = lead_assignment_rule_tables.rule_id
      AND r.account_id IN (
        SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
      )
  ));
CREATE POLICY "Members can read own account lead assignment members"
  ON public.lead_assignment_rule_members FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.lead_assignment_rules r
    WHERE r.id = lead_assignment_rule_members.rule_id
      AND r.account_id IN (
        SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
      )
  ));
CREATE POLICY "Members can read own account lead assignment state"
  ON public.lead_assignment_table_state FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.lead_assignment_rules r
    WHERE r.id = lead_assignment_table_state.rule_id
      AND r.account_id IN (
        SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
      )
  ));
CREATE POLICY "Members can read own account lead assignment events"
  ON public.lead_assignment_events FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
  ));

-- Owner/admin manage rules, targets, and members.
CREATE POLICY "Admins can manage own account lead assignment rules"
  ON public.lead_assignment_rules FOR ALL
  USING (account_id IN (
    SELECT account_id FROM public.profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ))
  WITH CHECK (account_id IN (
    SELECT account_id FROM public.profiles
    WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
  ));
CREATE POLICY "Admins can manage own account lead assignment targets"
  ON public.lead_assignment_rule_tables FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.lead_assignment_rules r
    WHERE r.id = lead_assignment_rule_tables.rule_id
      AND r.account_id IN (
        SELECT account_id FROM public.profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.lead_assignment_rules r
    WHERE r.id = lead_assignment_rule_tables.rule_id
      AND r.account_id IN (
        SELECT account_id FROM public.profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ));
CREATE POLICY "Admins can manage own account lead assignment members"
  ON public.lead_assignment_rule_members FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.lead_assignment_rules r
    WHERE r.id = lead_assignment_rule_members.rule_id
      AND r.account_id IN (
        SELECT account_id FROM public.profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.lead_assignment_rules r
    WHERE r.id = lead_assignment_rule_members.rule_id
      AND r.account_id IN (
        SELECT account_id FROM public.profiles
        WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin')
      )
  ));

-- Algorithm state is written by the service role during ingestion;
-- admins may read/repair via the API (service role bypasses RLS).
-- No client write policy: user clients never write state directly.

-- Agents record manual-assignment audit events (writes only their
-- own account's rows; reads stay member-scoped above).
CREATE POLICY "Agents can record own account lead assignment events"
  ON public.lead_assignment_events FOR INSERT
  WITH CHECK (account_id IN (
    SELECT account_id FROM public.profiles
    WHERE user_id = auth.uid()
      AND account_role IN ('owner', 'admin', 'agent')
  ));
