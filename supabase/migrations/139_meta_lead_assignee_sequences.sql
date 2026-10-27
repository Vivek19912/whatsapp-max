-- ============================================================
-- 139_meta_lead_assignee_sequences.sql — per-salesperson
-- WhatsApp customer sequences for Meta Lead Ads tables.
--
-- Scope protection: this migration touches ONLY new
-- `meta_lead_assignee_*` tables plus one nullable
-- `meta_lead_whatsapp_queue.assignee_key` column. It does NOT
-- alter flows, flow_runs, workspace_*, message_templates,
-- whatsapp_config, lead_assignment_* tables, or any Flow Tables /
-- All Sheets / Travel CRM state.
--
-- Design (extends 133_meta_lead_whatsapp_auto_send.sql):
--   * Each salesperson gets an optional ordered template sequence
--     per (account, Meta form id): delay between consecutive sends
--     plus an ordered list of approved template items with
--     per-template variable mappings. Absent row (or empty items)
--     = no customer-facing sequence for that salesperson; only the
--     assignment notifications still fire.
--   * `salesperson_key` identifies the assignee across the
--     assignment and auto-send systems: the internal member
--     user_id, else `email:` + lowercased email, else
--     `phone:` + digits. Derived identically at config and
--     assignment time (see salespersonKeyFor).
--   * `meta_lead_whatsapp_queue.assignee_key` (nullable) marks
--     rows that belong to a salesperson sequence instead of the
--     table-wide one. NULL = existing global behavior, unchanged.
--     The UNIQUE(account, submission, template, language) ledger
--     still prevents any duplicate send, so a template shared by
--     both sequences is sent at most once per lead.
--   * Tenant isolation: every table carries account_id and is
--     guarded by is_account_member. Queue writes happen
--     server-side (service role); members get SELECT-only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---------- 1. Per-salesperson sequence headers ----------------
-- One row per (account, Meta form id, salesperson). delay_seconds
-- spaces consecutive sends for that salesperson's leads (0 =
-- immediate, still in order). No per-salesperson pause flag:
-- the table-wide pause parks every row of the table.
CREATE TABLE IF NOT EXISTS public.meta_lead_assignee_sequences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  form_id             TEXT NOT NULL,
  salesperson_key     TEXT NOT NULL,
  delay_seconds       INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_assignee_sequences_account_form_key_check
    CHECK (char_length(salesperson_key) BETWEEN 1 AND 200),
  CONSTRAINT meta_lead_assignee_sequences_account_form_key
    UNIQUE (account_id, form_id, salesperson_key),
  CONSTRAINT meta_lead_assignee_sequences_delay_check
    CHECK (delay_seconds >= 0 AND delay_seconds <= 86400)
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_assignee_sequences_account_form
  ON public.meta_lead_assignee_sequences(account_id, form_id);

COMMENT ON TABLE public.meta_lead_assignee_sequences IS
  'Per-salesperson WhatsApp customer sequences for Meta Lead Ads tables. One row per (account, Meta form id, salesperson key); salespeople without a row get assignment notifications only, never customer templates.';

-- ---------- 2. Ordered template items --------------------------
-- Each row is one approved template in a salesperson's sequence.
-- `position` is the 0-based send order within (sequence).
CREATE TABLE IF NOT EXISTS public.meta_lead_assignee_sequence_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id         UUID NOT NULL REFERENCES public.meta_lead_assignee_sequences(id) ON DELETE CASCADE,
  template_name       TEXT NOT NULL,
  template_language   TEXT NOT NULL DEFAULT 'en_US',
  position            INT NOT NULL DEFAULT 0,
  variable_mappings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_assignee_sequence_items_seq_name_lang_key
    UNIQUE (sequence_id, template_name, template_language),
  CONSTRAINT meta_lead_assignee_sequence_items_position_check
    CHECK (position >= 0 AND position < 100)
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_assignee_sequence_items_seq_position
  ON public.meta_lead_assignee_sequence_items(sequence_id, position);

COMMENT ON TABLE public.meta_lead_assignee_sequence_items IS
  'Ordered approved templates in one salesperson sequence. Deduplicated per (sequence, name, language); position sets the send order. An empty item list means no customer-facing sequence.';

-- ---------- 3. Queue discriminator ------------------------------
-- Marks queue rows that belong to a salesperson sequence instead
-- of the table-wide one. NULL preserves the existing global
-- behavior exactly (no backfill needed, no existing rows change).
ALTER TABLE public.meta_lead_whatsapp_queue
  ADD COLUMN IF NOT EXISTS assignee_key TEXT;

CREATE INDEX IF NOT EXISTS idx_meta_lead_whatsapp_queue_assignee
  ON public.meta_lead_whatsapp_queue(account_id, submission_id, assignee_key);

COMMENT ON COLUMN public.meta_lead_whatsapp_queue.assignee_key IS
  'Salesperson sequence discriminator (see meta_lead_assignee_sequences.salesperson_key). NULL = table-wide sequence row; set = per-salesperson row. Blocking/order checks scope to the same key so the two automations never stall each other.';

-- ---------- 4. updated_at triggers -------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_assignee_sequences;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_assignee_sequences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.meta_lead_assignee_sequence_items;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_lead_assignee_sequence_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 5. RLS -----------------------------------------------
ALTER TABLE public.meta_lead_assignee_sequences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_lead_assignee_sequences_select ON public.meta_lead_assignee_sequences;
CREATE POLICY meta_lead_assignee_sequences_select ON public.meta_lead_assignee_sequences
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS meta_lead_assignee_sequences_insert ON public.meta_lead_assignee_sequences;
CREATE POLICY meta_lead_assignee_sequences_insert ON public.meta_lead_assignee_sequences
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_assignee_sequences_update ON public.meta_lead_assignee_sequences;
CREATE POLICY meta_lead_assignee_sequences_update ON public.meta_lead_assignee_sequences
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_lead_assignee_sequences_delete ON public.meta_lead_assignee_sequences;
CREATE POLICY meta_lead_assignee_sequences_delete ON public.meta_lead_assignee_sequences
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.meta_lead_assignee_sequence_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_lead_assignee_sequence_items_select ON public.meta_lead_assignee_sequence_items;
CREATE POLICY meta_lead_assignee_sequence_items_select ON public.meta_lead_assignee_sequence_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.meta_lead_assignee_sequences s
      WHERE s.id = meta_lead_assignee_sequence_items.sequence_id
        AND is_account_member(s.account_id)
    )
  );
DROP POLICY IF EXISTS meta_lead_assignee_sequence_items_insert ON public.meta_lead_assignee_sequence_items;
CREATE POLICY meta_lead_assignee_sequence_items_insert ON public.meta_lead_assignee_sequence_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.meta_lead_assignee_sequences s
      WHERE s.id = meta_lead_assignee_sequence_items.sequence_id
        AND is_account_member(s.account_id, 'admin')
    )
  );
DROP POLICY IF EXISTS meta_lead_assignee_sequence_items_update ON public.meta_lead_assignee_sequence_items;
CREATE POLICY meta_lead_assignee_sequence_items_update ON public.meta_lead_assignee_sequence_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.meta_lead_assignee_sequences s
      WHERE s.id = meta_lead_assignee_sequence_items.sequence_id
        AND is_account_member(s.account_id, 'admin')
    )
  );
DROP POLICY IF EXISTS meta_lead_assignee_sequence_items_delete ON public.meta_lead_assignee_sequence_items;
CREATE POLICY meta_lead_assignee_sequence_items_delete ON public.meta_lead_assignee_sequence_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.meta_lead_assignee_sequences s
      WHERE s.id = meta_lead_assignee_sequence_items.sequence_id
        AND is_account_member(s.account_id, 'admin')
    )
  );
