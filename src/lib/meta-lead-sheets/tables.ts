// ============================================================
// Meta Lead Ads → Google Sheets — Workspace table resolution.
//
// A Meta Workspace table is a `flows` row with kind =
// 'meta_lead_ads', linked to exactly one Instant Form through
// `flows.meta_form_id`. Every table-scoped Sheets route resolves
// the caller's selected table through this helper, which enforces
// three things at once:
//
//   * the flow belongs to the caller's account (tenant isolation),
//   * the flow is a Meta Lead Ads table (Flow Tables are rejected
//     with the same 404 as an unknown table),
//   * the linked Meta form belongs to the same account.
//
// Forms are identified by the stable Meta form_id string (never by
// display name). Workspace rows (`meta_lead_submissions`) carry the
// same Meta form_id, so the table's form is the sync scope.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface TableFormRef {
  /** Workspace table id (flows.id) the user selected. */
  flowId: string;
  /** Workspace table display name (labels only, never identity). */
  flowName: string | null;
  /** Meta Lead Ads form row id (meta_lead_forms.id). */
  formDbId: string;
  /** Stable Meta form id — the Sheets sync scope. */
  formId: string;
  /** Display name (labels only, never identity). */
  formName: string | null;
  /** Whether the form is currently enabled for lead capture. */
  formEnabled: boolean;
}

/**
 * Resolve the caller's selected Workspace table to its Meta form.
 * Returns null for unknown tables, other accounts' tables, Flow
 * Tables, and Meta tables whose form row is gone.
 */
export async function resolveTableForm(
  db: SupabaseClient,
  accountId: string,
  flowId: string
): Promise<TableFormRef | null> {
  const { data: flow, error: flowErr } = await db
    .from('flows')
    .select('id, name, kind, meta_form_id')
    .eq('id', flowId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (flowErr) throw flowErr;
  const flowRow = flow as {
    id: string;
    name: string | null;
    kind: string | null;
    meta_form_id: string | null;
  } | null;
  if (!flowRow || flowRow.kind !== 'meta_lead_ads' || !flowRow.meta_form_id) {
    return null;
  }

  const { data: form, error: formErr } = await db
    .from('meta_lead_forms')
    .select('id, form_id, form_name, enabled')
    .eq('id', flowRow.meta_form_id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (formErr) throw formErr;
  const formRow = form as {
    id: string;
    form_id: string;
    form_name: string | null;
    enabled: boolean | null;
  } | null;
  if (!formRow || !formRow.form_id) return null;

  return {
    flowId: flowRow.id,
    flowName: flowRow.name,
    formDbId: formRow.id,
    formId: formRow.form_id,
    formName: formRow.form_name,
    formEnabled: formRow.enabled === true,
  };
}

export type WorksheetChoice =
  | { ok: true; tab: string; needsCreate: boolean }
  | { ok: false; error: string; availableTabs: string[] };

/**
 * Pick the worksheet tab for a table config. Precedence: explicit
 * user pick > saved tab > first existing (leftmost) tab. Never
 * falls back to a different tab silently: a missing tab is an
 * error carrying the available tabs (unless creation was explicitly
 * requested), and an empty spreadsheet is an explicit error too.
 */
export function chooseWorksheetTab(args: {
  requestedTab: string | null;
  savedTab: string | null;
  availableTabs: string[];
  createTab: boolean;
}): WorksheetChoice {
  const tab =
    args.requestedTab ?? args.savedTab ?? args.availableTabs[0] ?? null;
  if (!tab) {
    return {
      ok: false,
      error:
        'This spreadsheet has no usable worksheet. Create one in Google Sheets first, or save with a tab name and tick “Create the tab if missing”.',
      availableTabs: [],
    };
  }
  if (args.availableTabs.includes(tab))
    return { ok: true, tab, needsCreate: false };
  if (!args.createTab) {
    return {
      ok: false,
      error: `Worksheet "${tab}" was not found. Select an existing tab or tick “Create the tab if missing”.`,
      availableTabs: args.availableTabs,
    };
  }
  return { ok: true, tab, needsCreate: true };
}
