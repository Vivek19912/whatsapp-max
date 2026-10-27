// ============================================================
// Meta Lead Ads → per-salesperson WhatsApp customer sequences.
//
// A salesperson's sequence is an ordered list of APPROVED
// templates (with per-template variable mappings and a
// per-sequence delay) keyed by (account, Meta form id,
// salesperson key). It starts ONLY on that salesperson's genuine
// initial assignment of a lead — never on reassignment, never on
// unrelated updates — and sends through the SAME durable queue,
// drain, retry, and Inbox pipeline as the table-wide auto-send
// (see queue.ts), distinguished only by `assignee_key`.
// Salespeople without a configured sequence get assignment
// notifications only, never customer templates.
//
// Meta-only. Nothing here is imported by Flow Tables, All Sheets,
// broadcasts, or the generic template sender. Pure helpers stay
// unit-testable; persistence goes through the caller's Supabase
// client with explicit account scoping.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ValidatedAutoSendTemplate } from "./config";

export interface AssigneeSequenceItem extends ValidatedAutoSendTemplate {
  id: string;
}

export interface AssigneeSequence {
  /** Stable salesperson identity (see salespersonKeyFor). */
  key: string;
  delay_seconds: number;
  items: AssigneeSequenceItem[];
}

/**
 * Stable salesperson identity shared by configuration and the
 * assignment engine: internal members by user id, external
 * contacts by lowercased email, else by phone digits. Returns
 * null when nothing usable identifies the salesperson. Pure.
 */
export function salespersonKeyFor(input: {
  user_id?: string | null;
  email?: string | null;
  phone?: string | null;
}): string | null {
  if (typeof input.user_id === "string" && input.user_id.trim() !== "") {
    return `user:${input.user_id.trim()}`;
  }
  if (typeof input.email === "string" && input.email.trim() !== "") {
    return `email:${input.email.trim().toLowerCase()}`;
  }
  if (typeof input.phone === "string") {
    const digits = input.phone.replace(/[^0-9]/g, "");
    if (digits !== "") return `phone:${digits}`;
  }
  return null;
}

/** Lenient mapping normalizer for stored rows (mirrors the queue's). Pure. */
function normalizeStoredMappings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [slotKey, fieldKey] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (typeof fieldKey === "string" && fieldKey.trim() !== "") {
      out[slotKey] = fieldKey.trim();
    }
  }
  return out;
}

/**
 * Load one salesperson's configured sequence. Null when never
 * configured. Throws on database errors (callers decide whether
 * to fail open or closed — enqueue paths fail closed to skip,
 * UI paths surface the error).
 */
export async function loadAssigneeSequence(
  db: SupabaseClient,
  accountId: string,
  formId: string,
  key: string,
): Promise<AssigneeSequence | null> {
  const { data: header, error: headerErr } = await db
    .from("meta_lead_assignee_sequences")
    .select("id, delay_seconds")
    .eq("account_id", accountId)
    .eq("form_id", formId)
    .eq("salesperson_key", key)
    .maybeSingle();
  if (headerErr) throw headerErr;
  if (!header) return null;
  const row = header as { id: string; delay_seconds: number | null };
  const { data: items, error: itemsErr } = await db
    .from("meta_lead_assignee_sequence_items")
    .select("id, template_name, template_language, position, variable_mappings")
    .eq("sequence_id", row.id)
    .order("position", { ascending: true });
  if (itemsErr) throw itemsErr;
  const ordered = ((items ?? []) as Array<{
    id: string;
    template_name: string;
    template_language: string;
    position: number;
    variable_mappings?: unknown;
  }>)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((t, index) => ({
      id: t.id,
      template_name: t.template_name,
      template_language: t.template_language,
      position: index,
      variable_mappings: normalizeStoredMappings(t.variable_mappings),
    }));
  return {
    key,
    delay_seconds:
      typeof row.delay_seconds === "number" && row.delay_seconds >= 0
        ? row.delay_seconds
        : 0,
    items: ordered,
  };
}

/**
 * Every salesperson key with a SAVED sequence row for the table
 * (independent of whether it currently holds items). Used for the
 * "configured for" picker state. Never throws — returns [] on
 * database errors so the dialog still renders the global config.
 */
export async function listAssigneeSequenceKeys(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from("meta_lead_assignee_sequences")
      .select("salesperson_key")
      .eq("account_id", accountId)
      .eq("form_id", formId);
    if (error) return [];
    return ((data ?? []) as Array<{ salesperson_key?: unknown }>)
      .map((r) => r.salesperson_key)
      .filter((k): k is string => typeof k === "string" && k !== "");
  } catch {
    return [];
  }
}

/**
 * Replace one salesperson's sequence (validated items + delay).
 * An empty item list deletes the sequence row instead of storing
 * an empty shell, so "no configured sequence" and "empty
 * sequence" behave identically downstream. Returns the stored
 * sequence (empty items when deleted).
 */
export async function saveAssigneeSequence(
  db: SupabaseClient,
  args: {
    accountId: string;
    formId: string;
    key: string;
    delay_seconds: number;
    items: ValidatedAutoSendTemplate[];
  },
): Promise<AssigneeSequence> {
  const { data: existing, error: lookupErr } = await db
    .from("meta_lead_assignee_sequences")
    .select("id")
    .eq("account_id", args.accountId)
    .eq("form_id", args.formId)
    .eq("salesperson_key", args.key)
    .maybeSingle();
  if (lookupErr) throw lookupErr;

  if (args.items.length === 0) {
    if (existing) {
      const sequenceId = (existing as { id: string }).id;
      // Delete items explicitly (in addition to the FK cascade)
      // so the sequence never lingers with stale items.
      const { error: itemsErr } = await db
        .from("meta_lead_assignee_sequence_items")
        .delete()
        .eq("sequence_id", sequenceId);
      if (itemsErr) throw itemsErr;
      const { error: deleteErr } = await db
        .from("meta_lead_assignee_sequences")
        .delete()
        .eq("id", sequenceId);
      if (deleteErr) throw deleteErr;
    }
    return { key: args.key, delay_seconds: 0, items: [] };
  }

  let sequenceId: string;
  if (existing) {
    sequenceId = (existing as { id: string }).id;
    const { error: updateErr } = await db
      .from("meta_lead_assignee_sequences")
      .update({ delay_seconds: args.delay_seconds, updated_at: new Date().toISOString() })
      .eq("id", sequenceId);
    if (updateErr) throw updateErr;
    const { error: deleteErr } = await db
      .from("meta_lead_assignee_sequence_items")
      .delete()
      .eq("sequence_id", sequenceId);
    if (deleteErr) throw deleteErr;
  } else {
    const { data: created, error: insertErr } = await db
      .from("meta_lead_assignee_sequences")
      .insert({
        account_id: args.accountId,
        form_id: args.formId,
        salesperson_key: args.key,
        delay_seconds: args.delay_seconds,
      })
      .select("id")
      .single();
    if (insertErr) throw insertErr;
    sequenceId = (created as { id: string }).id;
  }

  const { error: itemsErr } = await db
    .from("meta_lead_assignee_sequence_items")
    .insert(
      args.items.map((t) => ({
        sequence_id: sequenceId,
        template_name: t.template_name,
        template_language: t.template_language,
        position: t.position,
        variable_mappings: t.variable_mappings,
      })),
    );
  if (itemsErr) throw itemsErr;

  const loaded = await loadAssigneeSequence(db, args.accountId, args.formId, args.key);
  if (!loaded) throw new Error("Salesperson sequence could not be reloaded after saving.");
  return loaded;
}
