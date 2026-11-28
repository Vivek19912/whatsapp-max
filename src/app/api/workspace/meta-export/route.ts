// ============================================================
// GET /api/workspace/meta-export
//
// Excel (.xlsx) export for Meta Lead Ads tables ONLY.
// Rejects whatsapp_flow with 400. Supports:
//
//   tableId=all-meta-leads | <meta flow UUID>
//   formId=<flow UUID> (All view only: filter to one form)
//   dateFrom+dateTo (ISO, both-or-neither, Submission Time)
//   assignee, search, stage[], leadType[] (+type[] alias),
//   callStatus[], followUpStatus[],
//   source=all|organic|paid, campaign, ad
//   options=1 (distinct filter options, no file)
//
// Auth: getCurrentAccount (RLS). Agent isolation mirrors
// GET /api/workspace/all-meta-leads (forced own assignee when
// restricted) — including the ?options=1 filter-options branch,
// which scopes forms/campaigns/ads to the caller's visible set.
// Tenant isolation via account_id + RPC invoker.
// Single source of export truth — no parallel column system:
// columns reuse buildFlowTableColumns / allMetaFlowColumns /
// header-label overrides / formatColumnLabel.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import {
  parseAssigneeParam,
  serializeAssigneeSelection,
  validateWorkspaceDateRange,
  COLUMN_FILTER_VALUES_MAX,
  COLUMN_FILTER_VALUE_MAX,
  type WorkspaceDateRange,
  type WorkspaceAssigneeSelection,
} from '@/lib/flows/workspace-filters';
import { standardContactFromAnswers } from '@/lib/meta-lead-ads/normalize';
import { isAssigneeField } from '@/lib/flows/workspace-assignee';
import { metaWorkspaceDisplayName } from '@/lib/meta-lead-ads/workspace-name';
import {
  applyOptionLabelsToAnswers,
  buildOptionLabelMap,
  choiceQuestionKeys,
  mapAnswerValue,
  type StoredFormQuestion,
} from '@/lib/meta-lead-ads/option-labels';
import {
  parseFormQuestions,
  questionVarKeys,
  META_SOURCE_COLUMN_KEY,
} from '@/lib/meta-lead-ads/virtual-flow';
import { buildAllMetaFormAnswers } from '@/lib/workspace/all-meta-leads';
import {
  buildAllMetaExportColumns,
  buildSingleTableExportColumns,
  filterColumnsByKeys,
} from '@/lib/meta-leads-export/columns';
import {
  buildExportFilename,
  EXCEL_MAX_ROWS,
  EXPORT_RPC_PAGE_SIZE,
  isAllMetaExportTarget,
  isExportSourceFilter,
  matchesSourceFilter,
  type ExportSourceFilter,
} from '@/lib/meta-leads-export/constants';
import {
  buildMetaLeadsWorkbook,
  type ExportColumn,
  type ExportRow,
} from '@/lib/meta-leads-export/workbook';
import {
  fetchAssigneeDisplayNames,
  resolveExportAssigneeName,
} from '@/lib/meta-leads-export/assignees';
import type { FlowNodeLite } from '@/lib/flows/sheet-columns';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Selected Step-2 column identifiers from repeated `col` params
 * (comma-tolerant, trimmed, deduped, order as sent — the workbook
 * layer re-imposes canonical order). Returns null when the client
 * sent none, meaning "all columns" (existing single-step behavior).
 */
function parseSelectedColumns(url: URL): string[] | null {
  const seen = new Set<string>();
  for (const raw of url.searchParams.getAll('col')) {
    for (const part of raw.split(',')) {
      const key = part.trim();
      if (key !== '' && !seen.has(key)) seen.add(key);
    }
  }
  return seen.size > 0 ? [...seen] : null;
}

/**
 * Step-2 column narrowing always runs through filterColumnsByKeys
 * (columns.ts), so validation uses the same builder output that
 * the columns endpoint lists. Unknown keys are rejected with 400;
 * an empty result is rejected so we never emit a header-less file.
 */
function parseMultiValues(url: URL, key: string): string[] | null {
  const raw = url.searchParams.getAll(key);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const v = entry.trim();
    if (v === '' || seen.has(v)) continue;
    if (v.length > COLUMN_FILTER_VALUE_MAX) {
      throw new Error(
        `Filter values must be ${COLUMN_FILTER_VALUE_MAX} characters or fewer.`
      );
    }
    seen.add(v);
    out.push(v);
  }
  if (out.length > COLUMN_FILTER_VALUES_MAX) {
    throw new Error(`At most ${COLUMN_FILTER_VALUES_MAX} values per filter.`);
  }
  return out.length > 0 ? out : null;
}

function textOrNull(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t !== '' ? t : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/**
 * Flow ids containing at least one lead assigned to the caller
 * (my-tables visibility pattern: restricted agents see only their
 * own tables). Used by the columns endpoint and by Step-2 column
 * filtering so both agree on scoping. Empty input yields an empty
 * set (avoids an empty SQL IN list).
 */
async function loadOwnedFlowIds(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  flowIds: readonly string[]
): Promise<Set<string>> {
  const owned = new Set<string>();
  if (flowIds.length === 0) return owned;
  const { data: af } = await supabase
    .from('workspace_fields')
    .select('id, flow_id, name')
    .eq('account_id', accountId)
    .in('flow_id', [...flowIds]);
  const aFields = (
    (af ?? []) as Array<{ id: string; flow_id: string; name: string }>
  ).filter((f) => isAssigneeField({ name: f.name }));
  if (aFields.length === 0) return owned;
  const fieldToFlow = new Map(aFields.map((f) => [f.id, f.flow_id]));
  const { data: ov } = await supabase
    .from('workspace_values')
    .select('field_id')
    .eq('account_id', accountId)
    .eq('value_text', userId)
    .in(
      'field_id',
      aFields.map((f) => f.id)
    );
  for (const v of (ov ?? []) as Array<{ field_id: string }>) {
    const fid = fieldToFlow.get(v.field_id);
    if (fid) owned.add(fid);
  }
  return owned;
}

interface MetaWorkspaceFieldDef {
  id: string;
  name: string;
  field_type: string;
  options: string[] | null;
  default_value: string | null;
  position: number | null;
}

/**
 * Workspace field definitions keyed by flow, batched in one query
 * (never N+1). Same select + normalization as the export path so
 * Step-2 column lists and workbooks can never disagree.
 */
async function loadFieldDefsByFlow(
  supabase: SupabaseClient,
  accountId: string,
  flowIds: readonly string[]
): Promise<Record<string, MetaWorkspaceFieldDef[]>> {
  const out: Record<string, MetaWorkspaceFieldDef[]> = {};
  if (flowIds.length === 0) return out;
  const { data: fieldsData } = await supabase
    .from('workspace_fields')
    .select('id, flow_id, name, field_type, options, default_value, position')
    .eq('account_id', accountId)
    .in('flow_id', [...flowIds]);
  for (const f of (fieldsData ?? []) as Array<{
    id: string;
    flow_id: string;
    name: string;
    field_type?: unknown;
    options?: unknown;
    default_value?: unknown;
    position?: unknown;
  }>) {
    (out[f.flow_id] ??= []).push({
      id: f.id,
      name: f.name,
      field_type: typeof f.field_type === 'string' ? f.field_type : 'text',
      options: Array.isArray(f.options) ? (f.options as string[]) : null,
      default_value:
        typeof f.default_value === 'string' ? f.default_value : null,
      position: typeof f.position === 'number' ? f.position : null,
    });
  }
  return out;
}

/**
 * Full export column list for one Meta Lead Ads table (same
 * builders, same inputs as the export path): nodes, entry node,
 * form questions, header-label overrides, workspace fields.
 * Used by the columns endpoint so Step 2 lists exactly what the
 * workbook can contain.
 */
async function loadSingleTableColumns(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string
): Promise<ExportColumn[]> {
  const { data: nodesData } = await supabase
    .from('flow_nodes')
    .select('node_key, node_type, config, created_at')
    .eq('flow_id', flowId)
    .order('created_at', { ascending: true });
  const nodes: FlowNodeLite[] = (
    (nodesData ?? []) as Array<{
      node_key: string;
      node_type: string;
      config?: unknown;
      created_at?: string | null;
    }>
  ).map((n) => ({
    node_key: n.node_key,
    node_type: n.node_type,
    config: (n.config ?? {}) as Record<string, unknown>,
    created_at: n.created_at ?? null,
  }));
  const { data: flowRow } = await supabase
    .from('flows')
    .select('id, entry_node_id, meta_form_id')
    .eq('id', flowId)
    .eq('account_id', accountId)
    .maybeSingle();
  const entryNodeKey = ((flowRow as { entry_node_id?: string | null } | null)
    ?.entry_node_id ?? null) as string | null;
  const formDbId = ((flowRow as { meta_form_id?: string | null } | null)
    ?.meta_form_id ?? null) as string | null;

  // Form questions (deterministic per-question storage keys, same
  // derivation the virtual flow was built with).
  let fullNameQuestions: Array<{
    key: string | null;
    label: string | null;
    type: string | null;
  }> = [];
  let questionKeys: string[] = [];
  if (formDbId) {
    const { data: formRow } = await supabase
      .from('meta_lead_forms')
      .select('questions')
      .eq('id', formDbId)
      .eq('account_id', accountId)
      .maybeSingle();
    const rawQuestions = (formRow as { questions?: unknown } | null)?.questions;
    const parsed = parseFormQuestions(rawQuestions);
    questionKeys = questionVarKeys(parsed);
    fullNameQuestions = parsed.map((q) => ({
      key: q.key ?? null,
      label: q.label ?? null,
      type: q.type ?? null,
    }));
  }

  // Header-label overrides (same two sources as the export path).
  let headerLabels: Record<string, string> | null = null;
  try {
    const { data: labelRows } = await supabase
      .from('meta_lead_header_labels')
      .select('label_key, label_value')
      .eq('account_id', accountId)
      .eq('flow_id', flowId);
    if (labelRows) {
      headerLabels = {};
      for (const l of labelRows as Array<{
        label_key: string;
        label_value: string;
      }>) {
        if (l.label_key && typeof l.label_value === 'string')
          headerLabels[l.label_key] = l.label_value;
      }
    }
  } catch {
    headerLabels = null;
  }
  if (!headerLabels && formDbId) {
    try {
      const { data: formRow } = await supabase
        .from('meta_lead_forms')
        .select('header_labels')
        .eq('id', formDbId)
        .eq('account_id', accountId)
        .maybeSingle();
      const hl = (formRow as { header_labels?: unknown } | null)?.header_labels;
      if (hl && typeof hl === 'object')
        headerLabels = hl as Record<string, string>;
    } catch {
      headerLabels = null;
    }
  }

  const fieldDefs = await loadFieldDefsByFlow(supabase, accountId, [flowId]);
  const wsFields = (fieldDefs[flowId] ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    field_type: f.field_type,
  }));
  return buildSingleTableExportColumns({
    nodes,
    entryNodeKey,
    fullNameQuestions,
    questionKeys,
    headerLabels,
    workspaceFields: wsFields,
  }).columns;
}

interface AllMetaRpcRow {
  meta_lead_id: string | null;
  submission_form_id: string | null;
  submission_form_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  campaign_name: string | null;
  is_organic: boolean | null;
  meta_created_time: string | null;
  submission_answers: Record<string, unknown> | null;
  run_id: string;
  flow_id: string;
  flow_name: string | null;
  meta_form_db_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  conversation_id: string | null;
  run_status: string;
  started_at: string;
  last_advanced_at: string | null;
  ended_at: string | null;
  vars: Record<string, unknown> | null;
}

export async function GET(request: Request) {
  try {
    const ctx: AccountContext = await getCurrentAccount();
    const { supabase, accountId, userId, role } = ctx;
    const url = new URL(request.url);

    const rawTableId = (url.searchParams.get('tableId') ?? '').trim();
    if (!rawTableId) {
      return NextResponse.json(
        { error: 'tableId is required.' },
        { status: 400 }
      );
    }
    const isAllView = isAllMetaExportTarget(rawTableId);

    // Resolve + validate scope flow(s). Rejects whatsapp_flow.
    let scopeFlowIds: string[] = [];
    let exportLabel = 'All_Meta_Leads';
    if (isAllView) {
      const { data: flowsData, error: flowsErr } = await supabase
        .from('flows')
        .select('id, name')
        .eq('account_id', accountId)
        .eq('kind', 'meta_lead_ads')
        .order('name', { ascending: true });
      if (flowsErr) throw flowsErr;
      const allIds = (
        (flowsData ?? []) as Array<{ id: string; name: string | null }>
      )
        .filter((f) => typeof f.id === 'string')
        .map((f) => f.id);
      const rawFormId = (url.searchParams.get('formId') ?? '').trim();
      if (rawFormId) {
        if (!allIds.includes(rawFormId)) {
          return NextResponse.json(
            { error: 'Form not found.' },
            { status: 404 }
          );
        }
        scopeFlowIds = [rawFormId];
        const found = (
          (flowsData ?? []) as Array<{ id: string; name: string | null }>
        ).find((f) => f.id === rawFormId);
        exportLabel = (found?.name ?? 'Meta_Leads').replace(
          /^Meta Lead Ads\s*·\s*/,
          ''
        );
      } else {
        scopeFlowIds = allIds;
      }
      if (scopeFlowIds.length === 0) {
        return NextResponse.json(
          { error: 'No Meta Lead Ads tables found.' },
          { status: 404 }
        );
      }
    } else {
      const { data: flowRow, error: flowErr } = await supabase
        .from('flows')
        .select('id, name, kind')
        .eq('id', rawTableId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (flowErr) throw flowErr;
      if (!flowRow)
        return NextResponse.json(
          { error: 'Table not found.' },
          { status: 404 }
        );
      const kind = (flowRow as { kind?: string | null }).kind ?? null;
      if (kind !== 'meta_lead_ads') {
        return NextResponse.json(
          { error: 'Excel export is available only for Meta Lead Ads tables.' },
          { status: 400 }
        );
      }
      scopeFlowIds = [rawTableId];
      exportLabel = (
        (flowRow as { name?: string | null }).name ?? 'Meta_Leads'
      ).replace(/^Meta Lead Ads\s*·\s*/, '');
    }

    // ---- Filters (same validators as table routes) ----
    let dateRange: WorkspaceDateRange | null = null;
    const rawFrom = url.searchParams.get('dateFrom');
    const rawTo = url.searchParams.get('dateTo');
    if (rawFrom !== null || rawTo !== null) {
      if (!rawFrom || !rawTo) {
        return NextResponse.json(
          { error: 'dateFrom and dateTo are required together.' },
          { status: 400 }
        );
      }
      try {
        dateRange = validateWorkspaceDateRange({ from: rawFrom, to: rawTo });
      } catch {
        return NextResponse.json(
          {
            error:
              'dateFrom/dateTo must be valid ISO datetimes with from <= to.',
          },
          { status: 400 }
        );
      }
    }

    let assignee: WorkspaceAssigneeSelection;
    try {
      assignee = parseAssigneeParam(url.searchParams.get('assignee'));
    } catch {
      return NextResponse.json(
        { error: 'Invalid assignee filter.' },
        { status: 400 }
      );
    }

    // Agent isolation: mirror all-meta-leads/table routes.
    if (role === 'agent') {
      try {
        const { resolveWorkspaceVisibility } =
          await import('@/lib/inbox/assignment-access');
        const { restricted } = await resolveWorkspaceVisibility(
          supabase,
          accountId,
          userId,
          role
        );
        if (restricted) assignee = { type: 'member', userId };
      } catch {
        assignee = { type: 'member', userId };
      }
    }

    let stage: string[] | null = null;
    let leadType: string[] | null = null;
    let callStatus: string[] | null = null;
    let followUpStatus: string[] | null = null;
    try {
      stage = parseMultiValues(url, 'stage');
      leadType = parseMultiValues(url, 'leadType');
      const typeAlias = parseMultiValues(url, 'type');
      if (typeAlias && !leadType) leadType = typeAlias;
      else if (typeAlias && leadType) {
        const seen = new Set(leadType);
        for (const v of typeAlias) if (!seen.has(v)) leadType.push(v);
      }
      callStatus = parseMultiValues(url, 'callStatus');
      followUpStatus = parseMultiValues(url, 'followUpStatus');
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid filter.' },
        { status: 400 }
      );
    }

    const rawSource = (url.searchParams.get('source') ?? 'all')
      .trim()
      .toLowerCase();
    const source: ExportSourceFilter = isExportSourceFilter(rawSource)
      ? rawSource
      : 'all';
    if (!isExportSourceFilter(rawSource) && rawSource !== '') {
      return NextResponse.json(
        { error: 'source must be all, organic, or paid.' },
        { status: 400 }
      );
    }
    const campaign = (url.searchParams.get('campaign') ?? '')
      .trim()
      .slice(0, 200);
    const ad = (url.searchParams.get('ad') ?? '').trim().slice(0, 200);
    const search = url.searchParams.get('search')?.slice(0, 120) ?? '';

    // Step-2 column selection (`col` params, repeatable/comma-separated).
    // Null = no selection sent → export every column (existing
    // single-step behavior). Validation happens against the
    // scope-aware column definitions below, never trusted blindly.
    const selectedKeys = parseSelectedColumns(url);

    // ---- Options mode (distinct campaigns/ads/forms, no file) ----
    // Same visibility contract as the export path: restricted agents
    // see only tables and leads they may access (my-tables scopeToOwn
    // pattern + forced own assignee). Resolvers fail closed — a
    // lookup failure never widens to account-wide options.
    if (url.searchParams.get('options') === '1') {
      let restricted = false;
      if (role === 'agent') {
        try {
          const { resolveWorkspaceVisibility } =
            await import('@/lib/inbox/assignment-access');
          restricted = (
            await resolveWorkspaceVisibility(supabase, accountId, userId, role)
          ).restricted;
        } catch {
          restricted = true;
        }
      }
      const scopeToOwn = role === 'agent' && restricted;

      const { data: flowsData } = await supabase
        .from('flows')
        .select('id, name, meta_form_id')
        .eq('account_id', accountId)
        .eq('kind', 'meta_lead_ads')
        .order('name', { ascending: true });
      const allFlows = (
        (flowsData ?? []) as Array<{
          id: string;
          name: string | null;
          meta_form_id: string | null;
        }>
      ).filter((f) => typeof f.id === 'string');
      const stripTableName = (name: string | null): string =>
        (name ?? 'Untitled').replace(/^Meta Lead Ads\s*·\s*/, '');

      // Distinct campaign/ad names through the permission-aware
      // get_all_meta_leads RPC (same assignee semantics as the
      // export), so restricted agents only ever observe their own
      // leads. Early-exits once both lists are full; otherwise scans
      // to exhaustion (no silent row cap beyond the 200-item lists).
      const collectScopedOptions = async (args: {
        flowId: string | null;
        assignee: string;
      }): Promise<{ campaigns: string[]; ads: string[] }> => {
        const seenC = new Set<string>();
        const seenA = new Set<string>();
        let page = 0;
        for (;;) {
          const { data, error } = await supabase.rpc('get_all_meta_leads', {
            p_search: null,
            p_page: page,
            p_page_size: EXPORT_RPC_PAGE_SIZE,
            p_started_from: null,
            p_started_to: null,
            p_assignee: args.assignee,
            p_flow_id: args.flowId,
            p_stage: null,
            p_lead_type: null,
            p_call_status: null,
            p_followup_status: null,
            // Pin the 13-arg overload (migration 180): without these
            // keys PostgREST cannot choose between the 11-arg (179)
            // and 13-arg (180) signatures and the call fails with an
            // ambiguity error. Null = inactive, export unchanged.
            p_next_followup_from: null,
            p_next_followup_to: null,
          });
          if (error) throw new Error(`Options read failed: ${error.message}`);
          const rows = ((data as { rows?: unknown }).rows ?? []) as Array<{
            campaign_name: string | null;
            ad_name: string | null;
          }>;
          for (const r of rows) {
            if (r.campaign_name && r.campaign_name.trim())
              seenC.add(r.campaign_name.trim());
            if (r.ad_name && r.ad_name.trim()) seenA.add(r.ad_name.trim());
            if (seenC.size >= 200 && seenA.size >= 200) break;
          }
          if (seenC.size >= 200 && seenA.size >= 200) break;
          if (rows.length < EXPORT_RPC_PAGE_SIZE) break;
          page += 1;
        }
        return {
          campaigns: [...seenC]
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 200),
          ads: [...seenA].sort((a, b) => a.localeCompare(b)).slice(0, 200),
        };
      };

      if (!isAllView) {
        // Single table: existence + kind already validated above
        // (404/400). Restricted agents must additionally hold at
        // least one own assignment in this table; otherwise 404 with
        // the identical message (no existence oracle for table names
        // or flow UUIDs they cannot access).
        if (scopeToOwn) {
          const { data: tableFields } = await supabase
            .from('workspace_fields')
            .select('id, flow_id, name')
            .eq('account_id', accountId)
            .eq('flow_id', rawTableId);
          const assigneeIds = (
            (tableFields ?? []) as Array<{ id: string; name: string }>
          )
            .filter((f) => isAssigneeField({ name: f.name }))
            .map((f) => f.id);
          let hasOwn = false;
          if (assigneeIds.length > 0) {
            const { data: ownValues } = await supabase
              .from('workspace_values')
              .select('field_id')
              .eq('account_id', accountId)
              .eq('value_text', userId)
              .in('field_id', assigneeIds);
            hasOwn = ((ownValues ?? []) as unknown[]).length > 0;
          }
          if (!hasOwn) {
            return NextResponse.json(
              { error: 'Table not found.' },
              { status: 404 }
            );
          }
        }
        const only = allFlows.find((f) => f.id === rawTableId);
        const scoped = await collectScopedOptions({
          flowId: rawTableId,
          assignee: scopeToOwn ? userId : 'all',
        });
        return NextResponse.json({
          forms: only
            ? [{ flowId: only.id, tableName: stripTableName(only.name) }]
            : [],
          campaigns: scoped.campaigns,
          ads: scoped.ads,
        });
      }

      // All Meta Leads mode.
      if (!scopeToOwn) {
        const forms = allFlows.map((f) => ({
          flowId: f.id,
          tableName: stripTableName(f.name),
        }));
        // Account-wide distinct scan (existing behavior for
        // owner/admin/viewer and unrestricted agents). Best-effort.
        let campaigns: string[] = [];
        let ads: string[] = [];
        try {
          const { data: subRows } = await supabase
            .from('meta_lead_submissions')
            .select('campaign_name, ad_name')
            .eq('account_id', accountId)
            .order('created_at', { ascending: false })
            .limit(2000);
          const cSet = new Set<string>();
          const aSet = new Set<string>();
          for (const s of (subRows ?? []) as Array<{
            campaign_name: string | null;
            ad_name: string | null;
          }>) {
            if (s.campaign_name && s.campaign_name.trim())
              cSet.add(s.campaign_name.trim());
            if (s.ad_name && s.ad_name.trim()) aSet.add(s.ad_name.trim());
            if (cSet.size >= 200 && aSet.size >= 200) break;
          }
          campaigns = [...cSet]
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 200);
          ads = [...aSet].sort((a, b) => a.localeCompare(b)).slice(0, 200);
        } catch {
          campaigns = [];
          ads = [];
        }
        return NextResponse.json({ forms, campaigns, ads });
      }

      // Restricted agent: visible tables mirror my-tables (tables
      // containing at least one own assigned lead — never other
      // agents' counts or names).
      const visibleIds = allFlows.map((f) => f.id);
      const { data: allFields } = await supabase
        .from('workspace_fields')
        .select('id, flow_id, name')
        .eq('account_id', accountId)
        .in('flow_id', visibleIds);
      const assigneeFields = (
        (allFields ?? []) as Array<{
          id: string;
          flow_id: string;
          name: string;
        }>
      ).filter((f) => isAssigneeField({ name: f.name }));
      const fieldToFlow = new Map(assigneeFields.map((f) => [f.id, f.flow_id]));
      const owned = new Set<string>();
      if (assigneeFields.length > 0) {
        const { data: ownValues } = await supabase
          .from('workspace_values')
          .select('field_id')
          .eq('account_id', accountId)
          .eq('value_text', userId)
          .in(
            'field_id',
            assigneeFields.map((f) => f.id)
          );
        for (const v of (ownValues ?? []) as Array<{ field_id: string }>) {
          const fid = fieldToFlow.get(v.field_id);
          if (fid) owned.add(fid);
        }
      }
      const forms = allFlows
        .filter((f) => owned.has(f.id))
        .map((f) => ({ flowId: f.id, tableName: stripTableName(f.name) }));
      const scoped = await collectScopedOptions({
        flowId: null,
        assignee: userId,
      });
      return NextResponse.json({
        forms,
        campaigns: scoped.campaigns,
        ads: scoped.ads,
      });
    }

    // ---- Columns mode (available export columns, grouped — Step 2) ----
    // Same visibility contract as options/export: table existence and
    // kind were validated above; restricted agents only see tables
    // they may access (my-tables scopeToOwn pattern, fail closed).
    // Returns the builders' canonical columns ({key, header, group})
    // so Step 2 lists exactly what the workbook can contain. No rows
    // are read; nothing is created, modified, or deleted.
    if (url.searchParams.get('columns') === '1') {
      let columnsRestricted = false;
      if (role === 'agent') {
        try {
          const { resolveWorkspaceVisibility } =
            await import('@/lib/inbox/assignment-access');
          columnsRestricted = (
            await resolveWorkspaceVisibility(supabase, accountId, userId, role)
          ).restricted;
        } catch {
          columnsRestricted = true;
        }
      }
      const columnsScopeToOwn = role === 'agent' && columnsRestricted;

      const { data: colFlowsData, error: colFlowsErr } = await supabase
        .from('flows')
        .select('id, name, meta_form_id')
        .eq('account_id', accountId)
        .eq('kind', 'meta_lead_ads')
        .order('name', { ascending: true });
      if (colFlowsErr) throw colFlowsErr;
      const colAllFlows = (
        (colFlowsData ?? []) as Array<{
          id: string;
          name: string | null;
          meta_form_id: string | null;
        }>
      ).filter((f) => typeof f.id === 'string');

      if (!isAllView) {
        // Existence + kind already validated above (404/400).
        // Restricted agents must hold at least one own assignment
        // in this table; otherwise 404 with the identical message
        // (no existence oracle for table names they cannot access).
        if (columnsScopeToOwn) {
          const owned = await loadOwnedFlowIds(supabase, accountId, userId, [
            rawTableId,
          ]);
          if (!owned.has(rawTableId)) {
            return NextResponse.json(
              { error: 'Table not found.' },
              { status: 404 }
            );
          }
        }
        const singleColumns = await loadSingleTableColumns(
          supabase,
          accountId,
          rawTableId
        );
        return NextResponse.json({
          columns: singleColumns.map((c) => ({
            key: c.key,
            header: c.header,
            group: c.group,
          })),
        });
      }

      // All Meta Leads: tables the caller may access…
      let visibleFlows = colAllFlows;
      if (columnsScopeToOwn) {
        const owned = await loadOwnedFlowIds(
          supabase,
          accountId,
          userId,
          colAllFlows.map((f) => f.id)
        );
        visibleFlows = colAllFlows.filter((f) => owned.has(f.id));
      }
      // …optionally narrowed to one form (same validation as export).
      const rawColFormId = (url.searchParams.get('formId') ?? '').trim();
      if (rawColFormId) {
        if (!colAllFlows.some((f) => f.id === rawColFormId)) {
          return NextResponse.json(
            { error: 'Form not found.' },
            { status: 404 }
          );
        }
        if (!visibleFlows.some((f) => f.id === rawColFormId)) {
          return NextResponse.json(
            { error: 'Table not found.' },
            { status: 404 }
          );
        }
        visibleFlows = visibleFlows.filter((f) => f.id === rawColFormId);
      }
      const scopeIds = visibleFlows.map((f) => f.id);
      const fieldDefs = await loadFieldDefsByFlow(
        supabase,
        accountId,
        scopeIds
      );
      const allColumns = buildAllMetaExportColumns({
        tables: scopeIds.map((flowId) => ({ flowId })),
        fieldsByFlow: fieldDefs,
      });
      return NextResponse.json({
        columns: allColumns.map((c) => ({
          key: c.key,
          header: c.header,
          group: c.group,
        })),
      });
    }

    // ---- Fetch all matching base rows (batched RPC, no browser paging) ----
    const pFlowId = isAllView
      ? (url.searchParams.get('formId') ?? '').trim() || null
      : rawTableId;
    const serializedAssignee = serializeAssigneeSelection(assignee);

    async function fetchPage(
      page: number
    ): Promise<{ total: number; rows: AllMetaRpcRow[] }> {
      const { data, error } = await supabase.rpc('get_all_meta_leads', {
        p_search: search || null,
        p_page: page,
        p_page_size: EXPORT_RPC_PAGE_SIZE,
        p_started_from: dateRange?.from ?? null,
        p_started_to: dateRange?.to ?? null,
        p_assignee: serializedAssignee,
        p_flow_id: pFlowId,
        p_stage: stage,
        p_lead_type: leadType,
        p_call_status: callStatus,
        p_followup_status: followUpStatus,
        // Pin the 13-arg overload (migration 180): without these keys
        // PostgREST cannot choose between the 11-arg (179) and 13-arg
        // (180) signatures. Null = inactive, export unchanged.
        p_next_followup_from: null,
        p_next_followup_to: null,
      });
      if (error) throw new Error(`Export read failed: ${error.message}`);
      const total = Number((data as { total?: unknown })?.total ?? 0) || 0;
      const rows = ((data as { rows?: unknown }).rows ?? []) as AllMetaRpcRow[];
      return { total, rows };
    }

    const first = await fetchPage(0);
    if (first.total + 1 > EXCEL_MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Export has ${first.total.toLocaleString()} rows, exceeding Excel's 1,048,575-row limit. Narrow the filters and try again.`,
        },
        { status: 400 }
      );
    }
    const baseRows: AllMetaRpcRow[] = [...first.rows];
    const totalPages = Math.ceil(first.total / EXPORT_RPC_PAGE_SIZE);
    for (let page = 1; page < totalPages; page += 1) {
      // Safety cap: never fetch more than Excel can hold.
      if (baseRows.length + 1 >= EXCEL_MAX_ROWS) break;
      const { rows } = await fetchPage(page);
      if (rows.length === 0) break;
      baseRows.push(...rows);
      if (rows.length < EXPORT_RPC_PAGE_SIZE) break;
    }

    // In-memory source/campaign/ad (no migration; real stored fields).
    const filtered = baseRows.filter((r) => {
      if (!matchesSourceFilter(r.is_organic, source)) return false;
      if (campaign && (r.campaign_name ?? '').trim() !== campaign) return false;
      if (ad) {
        const a = (r.ad_name ?? '').trim();
        if (a !== ad) return false;
      }
      return true;
    });

    if (filtered.length + 1 > EXCEL_MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Export has ${filtered.length.toLocaleString()} rows, exceeding Excel's limit. Narrow the filters.`,
        },
        { status: 400 }
      );
    }
    if (filtered.length === 0) {
      return NextResponse.json(
        { error: 'No leads match the selected filters.' },
        { status: 404 }
      );
    }

    // ---- Shared enrichment (batched, never N+1) ----
    const flowIds = [...new Set(filtered.map((r) => r.flow_id))];
    const { data: flowsData } = await supabase
      .from('flows')
      .select('id, name, meta_form_id')
      .eq('account_id', accountId)
      .in('id', flowIds);
    const flowNameById = new Map(
      ((flowsData ?? []) as Array<{ id: string; name: string | null }>).map(
        (f) => [f.id, f.name ?? 'Untitled']
      )
    );
    const metaFormIdByFlow = new Map(
      (
        (flowsData ?? []) as Array<{ id: string; meta_form_id: string | null }>
      ).map((f) => [f.id, f.meta_form_id])
    );

    const { data: formsData } = await supabase
      .from('meta_lead_forms')
      .select('id, form_id, form_name, questions, enabled')
      .eq('account_id', accountId);
    const formsById = new Map(
      (
        (formsData ?? []) as Array<{
          id: string;
          form_id: string | null;
          form_name: string | null;
          questions: unknown;
        }>
      ).map((f) => [f.id, f])
    );

    const formDefByFlow = new Map<
      string,
      {
        questions: Array<{
          key: string | null;
          label: string | null;
          type: string | null;
        }>;
        questionKeys: string[];
        optionLabels: Map<string, Map<string, string>>;
        choiceKeys: Set<string>;
      }
    >();
    for (const fid of flowIds) {
      const formDbId = metaFormIdByFlow.get(fid) ?? null;
      const form = formDbId ? formsById.get(formDbId) : null;
      const rawQuestions = (form as { questions?: unknown } | undefined)
        ?.questions;
      const parsed = parseFormQuestions(rawQuestions);
      const keys = questionVarKeys(parsed);
      const rawList = Array.isArray(rawQuestions) ? rawQuestions : [];
      const stored: StoredFormQuestion[] = rawList.map((entry) => {
        const e =
          entry && typeof entry === 'object'
            ? (entry as Record<string, unknown>)
            : {};
        const rawOptions = Array.isArray(e.options) ? e.options : [];
        return {
          key: typeof e.key === 'string' ? e.key : null,
          label: typeof e.label === 'string' ? e.label : null,
          type: typeof e.type === 'string' ? e.type : null,
          options: rawOptions.map((o) => {
            const oo =
              o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
            return {
              key: typeof oo.key === 'string' ? oo.key : null,
              value: typeof oo.value === 'string' ? oo.value : null,
            };
          }),
        };
      });
      formDefByFlow.set(fid, {
        questions: parsed.map((q) => ({
          key: q.key ?? null,
          label: q.label ?? null,
          type: q.type ?? null,
        })),
        questionKeys: keys,
        optionLabels: buildOptionLabelMap(stored, keys),
        choiceKeys: choiceQuestionKeys(stored, keys),
      });
    }

    // Workspace business values (batched in chunks to bound IN lists).
    const runIds = filtered.map((r) => r.run_id);
    const valueByRunAndField = new Map<string, Map<string, string | null>>();
    const CHUNK = 500;
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const slice = runIds.slice(i, i + CHUNK);
      const { data: valueRows } = await supabase
        .from('workspace_values')
        .select('flow_run_id, field_id, value_text')
        .in('flow_run_id', slice);
      for (const v of (valueRows ?? []) as Array<{
        flow_run_id: string;
        field_id: string;
        value_text: string | null;
      }>) {
        if (!valueByRunAndField.has(v.flow_run_id))
          valueByRunAndField.set(v.flow_run_id, new Map());
        valueByRunAndField.get(v.flow_run_id)!.set(v.field_id, v.value_text);
      }
    }
    const { data: fieldsData } = await supabase
      .from('workspace_fields')
      .select('id, flow_id, name, field_type, options, default_value, position')
      .eq('account_id', accountId)
      .in('flow_id', flowIds);
    const fieldsByFlow = new Map<
      string,
      Array<{ id: string; name: string; field_type: string }>
    >();
    const fieldDefsByFlow: Record<
      string,
      Array<{
        id: string;
        name: string;
        field_type: string;
        options: string[] | null;
        default_value: string | null;
        position: number | null;
      }>
    > = {};
    for (const f of (fieldsData ?? []) as Array<{
      id: string;
      flow_id: string;
      name: string;
      field_type?: unknown;
      options?: unknown;
      default_value?: unknown;
      position?: unknown;
    }>) {
      if (!fieldsByFlow.has(f.flow_id)) {
        fieldsByFlow.set(f.flow_id, []);
        fieldDefsByFlow[f.flow_id] = [];
      }
      fieldsByFlow.get(f.flow_id)!.push({
        id: f.id,
        name: f.name,
        field_type: typeof f.field_type === 'string' ? f.field_type : 'text',
      });
      fieldDefsByFlow[f.flow_id].push({
        id: f.id,
        name: f.name,
        field_type: typeof f.field_type === 'string' ? f.field_type : 'text',
        options: Array.isArray(f.options) ? (f.options as string[]) : null,
        default_value:
          typeof f.default_value === 'string' ? f.default_value : null,
        position: typeof f.position === 'number' ? f.position : null,
      });
    }
    const fieldIdByFlowAndName = new Map<string, Map<string, string>>();
    for (const [flowIdKey, fields] of fieldsByFlow) {
      const byName = new Map<string, string>();
      for (const f of fields) byName.set(f.name.trim().toLowerCase(), f.id);
      fieldIdByFlowAndName.set(flowIdKey, byName);
    }
    const readValue = (
      runId: string,
      flowIdKey: string,
      names: string[]
    ): string | null => {
      const byName = fieldIdByFlowAndName.get(flowIdKey);
      if (!byName) return null;
      for (const n of names) {
        const id = byName.get(n.trim().toLowerCase());
        if (id) {
          const v = valueByRunAndField.get(runId)?.get(id);
          if (v !== undefined) return v;
          return null;
        }
      }
      return null;
    };
    const findFieldId = (flowIdKey: string, names: string[]): string | null => {
      const byName = fieldIdByFlowAndName.get(flowIdKey);
      if (!byName) return null;
      for (const n of names) {
        const id = byName.get(n.trim().toLowerCase());
        if (id) return id;
      }
      return null;
    };

    const stripPrefix = (name: string | null): string => {
      const t = (name ?? '').trim();
      if (t === '') return 'Untitled';
      return t.replace(/^Meta Lead Ads\s*·\s*/, '');
    };

    // Resolve Assigned-To user_ids to display names in one batched,
    // account-scoped roster read (never N+1). Raw UUIDs must never
    // reach the workbook: unassigned → "Unassigned", roster hit →
    // name, UUID-shaped miss → "Unknown" (+ reported below).
    const assigneeFieldIds = new Set<string>();
    for (const fields of fieldsByFlow.values()) {
      for (const f of fields) {
        if (isAssigneeField({ name: f.name })) assigneeFieldIds.add(f.id);
      }
    }
    const assigneeUserIds: string[] = [];
    {
      const seen = new Set<string>();
      for (const byField of valueByRunAndField.values()) {
        for (const [fieldId, v] of byField) {
          if (!assigneeFieldIds.has(fieldId)) continue;
          const t = (v ?? '').trim();
          if (t === '' || t === 'Unassigned' || seen.has(t)) continue;
          seen.add(t);
          assigneeUserIds.push(t);
        }
      }
    }
    const assigneeNames = await fetchAssigneeDisplayNames(
      supabase,
      accountId,
      assigneeUserIds
    );
    // Stored UUIDs whose profile cannot be resolved (removed member
    // or stale id). Reported via response header + server log; the
    // cells themselves render "Unknown", never the raw id.
    const unresolvedAssignees = new Set<string>();
    const displayAssignee = (stored: string | null | undefined): string => {
      const resolved = resolveExportAssigneeName(stored, assigneeNames);
      if (resolved.unresolved) {
        unresolvedAssignees.add((stored ?? '').trim());
      }
      return resolved.text;
    };
    const unresolvedHeader = (): Record<string, string> =>
      unresolvedAssignees.size > 0
        ? { 'X-Export-Unresolved-Assignees': String(unresolvedAssignees.size) }
        : {};
    const logUnresolved = () => {
      if (unresolvedAssignees.size === 0) return;
      console.warn('[meta-export] unresolved assignee ids', {
        count: unresolvedAssignees.size,
        sample: [...unresolvedAssignees].slice(0, 20),
      });
    };

    // ---- Build export rows ----
    if (isAllView) {
      const columns = buildAllMetaExportColumns({
        tables: flowIds.map((flowId) => ({ flowId })),
        fieldsByFlow: Object.fromEntries(
          flowIds.map((fid) => [
            fid,
            (fieldDefsByFlow[fid] ?? []) as Array<{
              id: string;
              name: string;
              field_type: string;
              options: string[] | null;
              default_value: string | null;
              position: number | null;
            }>,
          ])
        ),
      });
      // Stable per-flow field lookup for union columns (recompute keys).
      const { buildAllMetaUnionColumns, findUnionFieldDef } =
        await import('@/lib/workspace/all-meta-leads');
      const unionCols = buildAllMetaUnionColumns(
        flowIds.map((flowId) => ({ flowId })),
        Object.fromEntries(
          flowIds.map((fid) => [fid, fieldDefsByFlow[fid] ?? []])
        )
      );
      // Step-2 column selection: validate against the scope-aware
      // definition (identical scope to GET ?columns=1), then keep
      // canonical order. Unselected columns are omitted from the
      // workbook; without `col` params everything exports as before.
      let exportColumns = columns;
      if (selectedKeys !== null) {
        let scopeIds = scopeFlowIds;
        if (role === 'agent') {
          try {
            const { resolveWorkspaceVisibility } =
              await import('@/lib/inbox/assignment-access');
            const { restricted } = await resolveWorkspaceVisibility(
              supabase,
              accountId,
              userId,
              role
            );
            if (restricted) {
              const owned = await loadOwnedFlowIds(
                supabase,
                accountId,
                userId,
                scopeFlowIds
              );
              scopeIds = scopeFlowIds.filter((id) => owned.has(id));
            }
          } catch {
            // Fail closed for scoping: validate against only the
            // rows' own tables (row-level auth still enforced).
            scopeIds = [...new Set(filtered.map((r) => r.flow_id))];
          }
        }
        const missingIds = scopeIds.filter((id) => !(id in fieldDefsByFlow));
        let scopeDefs = fieldDefsByFlow;
        if (missingIds.length > 0) {
          const extra = await loadFieldDefsByFlow(
            supabase,
            accountId,
            missingIds
          );
          scopeDefs = { ...fieldDefsByFlow, ...extra };
        }
        const scopeColumns = buildAllMetaExportColumns({
          tables: scopeIds.map((flowId) => ({ flowId })),
          fieldsByFlow: Object.fromEntries(
            scopeIds.map((fid) => [
              fid,
              (scopeDefs[fid] ?? []) as Array<{
                id: string;
                name: string;
                field_type: string;
                options: string[] | null;
                default_value: string | null;
                position: number | null;
              }>,
            ])
          ),
        });
        const sel = filterColumnsByKeys(scopeColumns, selectedKeys);
        if (sel.unknownKeys.length > 0) {
          return NextResponse.json(
            { error: 'Unknown column selected.' },
            { status: 400 }
          );
        }
        if (sel.columns.length === 0) {
          return NextResponse.json(
            { error: 'Select at least one column to export.' },
            { status: 400 }
          );
        }
        exportColumns = sel.columns;
      }
      const showAssignedColumn =
        selectedKeys === null || selectedKeys.includes('assigned_to');
      const rows: ExportRow[] = filtered.map((r, idx) => {
        const vars = (r.vars ?? {}) as Record<string, unknown>;
        const def = formDefByFlow.get(r.flow_id);
        const questions = def?.questions ?? [];
        const questionKeys = def?.questionKeys ?? [];
        const optionLabels = def?.optionLabels ?? new Map();
        const choiceKeys = def?.choiceKeys ?? new Set<string>();
        const displayFor = (key: string, raw: string): string => {
          const mapped = mapAnswerValue(
            optionLabels.get(key),
            raw,
            choiceKeys.has(key)
          );
          return mapped ?? raw;
        };
        const formAnswers = buildAllMetaFormAnswers({
          vars,
          questions,
          questionKeys,
          displayFor,
        });
        const combined =
          formAnswers.map((a) => `${a.question}: ${a.answer}`).join('\n') ||
          null;
        const fallback = standardContactFromAnswers(
          vars as Record<string, string | null | undefined>
        );
        const name =
          metaWorkspaceDisplayName(vars, r.contact_name) ??
          fallback.name ??
          null;
        const phone = r.contact_phone ?? fallback.phone ?? null;
        const sourceRaw = textOrNull(vars[META_SOURCE_COLUMN_KEY]) ?? 'Other';
        const flowName =
          r.flow_name ?? flowNameById.get(r.flow_id) ?? 'Untitled';
        const out: ExportRow = {
          __row: idx + 1,
          submission_time: r.started_at ? new Date(r.started_at) : null,
          name,
          phone,
          meta_table: stripPrefix(flowName),
          source: sourceRaw,
          form_answers: combined,
          assigned_to: showAssignedColumn
            ? displayAssignee(readValue(r.run_id, r.flow_id, ['assigned to']))
            : null,
          lead_type: readValue(r.run_id, r.flow_id, ['lead type']) ?? 'Fresh',
          stage: readValue(r.run_id, r.flow_id, ['stage']) ?? 'New Lead',
          call_status: readValue(r.run_id, r.flow_id, ['call status']),
          follow_up: readValue(r.run_id, r.flow_id, [
            'next follow-up date & time',
          ])
            ? new Date(
                readValue(r.run_id, r.flow_id, [
                  'next follow-up date & time',
                ]) as string
              )
            : null,
          meta_ad: textOrNull(r.ad_name),
          meta_campaign: textOrNull(r.campaign_name),
          meta_source_type:
            r.is_organic === true
              ? 'Organic'
              : r.is_organic === false
                ? 'Paid'
                : null,
          meta_created: r.meta_created_time
            ? new Date(r.meta_created_time)
            : null,
          meta_lead_id: textOrNull(r.meta_lead_id),
        };
        const defs = fieldDefsByFlow[r.flow_id] ?? [];
        for (const u of unionCols) {
          const match = findUnionFieldDef(defs, u);
          out[`union:${u.key}`] = match
            ? (valueByRunAndField.get(r.run_id)?.get(match.id) ?? null)
            : null;
        }
        return out;
      });

      const buffer = await buildMetaLeadsWorkbook({
        columns: exportColumns,
        rows,
      });
      const filename = buildExportFilename(
        isAllView && pFlowId
          ? stripPrefix(flowNameById.get(pFlowId) ?? null)
          : 'All_Meta_Leads'
      );
      logUnresolved();
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(buffer.length),
          ...unresolvedHeader(),
        },
      });
    }

    // ---- Single Meta table export (same rows, per-form columns) ----
    const flowId = rawTableId;
    const { data: nodesData } = await supabase
      .from('flow_nodes')
      .select('node_key, node_type, config, created_at')
      .eq('flow_id', flowId)
      .order('created_at', { ascending: true });
    const nodes: FlowNodeLite[] = (
      (nodesData ?? []) as Array<{
        node_key: string;
        node_type: string;
        config?: unknown;
        created_at?: string | null;
      }>
    ).map((n) => ({
      node_key: n.node_key,
      node_type: n.node_type,
      config: (n.config ?? {}) as Record<string, unknown>,
      created_at: n.created_at ?? null,
    }));
    const { data: flowRow } = await supabase
      .from('flows')
      .select('id, entry_node_id, meta_form_id')
      .eq('id', flowId)
      .eq('account_id', accountId)
      .maybeSingle();
    const entryNodeKey = ((flowRow as { entry_node_id?: string | null } | null)
      ?.entry_node_id ?? null) as string | null;
    const formDbId = ((flowRow as { meta_form_id?: string | null } | null)
      ?.meta_form_id ?? null) as string | null;

    let headerLabels: Record<string, string> | null = null;
    try {
      const { data: labelRows } = await supabase
        .from('meta_lead_header_labels')
        .select('label_key, label_value')
        .eq('account_id', accountId)
        .eq('flow_id', flowId);
      if (labelRows) {
        headerLabels = {};
        for (const l of labelRows as Array<{
          label_key: string;
          label_value: string;
        }>) {
          if (l.label_key && typeof l.label_value === 'string')
            headerLabels[l.label_key] = l.label_value;
        }
      }
    } catch {
      headerLabels = null;
    }
    // Fallback: labels may live on meta_lead_forms.header_labels (older shape).
    if (!headerLabels && formDbId) {
      try {
        const { data: formRow } = await supabase
          .from('meta_lead_forms')
          .select('header_labels')
          .eq('id', formDbId)
          .eq('account_id', accountId)
          .maybeSingle();
        const hl = (formRow as { header_labels?: unknown } | null)
          ?.header_labels;
        if (hl && typeof hl === 'object')
          headerLabels = hl as Record<string, string>;
      } catch {
        headerLabels = null;
      }
    }

    const def = formDefByFlow.get(flowId);
    const wsFields = (fieldsByFlow.get(flowId) ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      field_type: f.field_type,
    }));
    const { columns } = buildSingleTableExportColumns({
      nodes,
      entryNodeKey,
      fullNameQuestions: (def?.questions ?? []).map((q) => ({
        key: q.key,
        label: q.label,
        type: (q as { type?: string | null }).type ?? null,
      })),
      questionKeys: def?.questionKeys ?? [],
      headerLabels,
      workspaceFields: wsFields,
    });
    // Step-2 column selection: the table's own builder output is the
    // scope, so validation and filtering stay consistent with Step 2.
    let singleExportColumns = columns;
    let showSingleAssignee = true;
    if (selectedKeys !== null) {
      const sel = filterColumnsByKeys(columns, selectedKeys);
      if (sel.unknownKeys.length > 0) {
        return NextResponse.json(
          { error: 'Unknown column selected.' },
          { status: 400 }
        );
      }
      if (sel.columns.length === 0) {
        return NextResponse.json(
          { error: 'Select at least one column to export.' },
          { status: 400 }
        );
      }
      singleExportColumns = sel.columns;
      showSingleAssignee = wsFields.some(
        (f) =>
          isAssigneeField({ name: f.name }) &&
          selectedKeys.includes(`field:${f.id}`)
      );
    }

    // Display-mapped answers per row (same rules as table route).
    const optionLabels = def?.optionLabels ?? new Map();
    const choiceKeys = def?.choiceKeys ?? new Set<string>();
    const rows: ExportRow[] = filtered
      .filter((r) => r.flow_id === flowId)
      .map((r, idx) => {
        const vars = (r.vars ?? {}) as Record<string, unknown>;
        const rawAnswers: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(vars)) {
          if (typeof v === 'string') rawAnswers[k] = v === '' ? null : v;
          else if (typeof v === 'number' || typeof v === 'boolean')
            rawAnswers[k] = String(v);
          else rawAnswers[k] = null;
        }
        const displayAnswers = applyOptionLabelsToAnswers(
          rawAnswers,
          optionLabels,
          choiceKeys
        );
        const fallback = standardContactFromAnswers(
          vars as Record<string, string | null | undefined>
        );
        const name =
          metaWorkspaceDisplayName(vars, r.contact_name) ??
          fallback.name ??
          null;
        const phone = r.contact_phone ?? fallback.phone ?? null;
        const out: ExportRow = {
          __row: idx + 1,
          submission_time: r.started_at ? new Date(r.started_at) : null,
          name,
          phone,
          meta_ad: textOrNull(r.ad_name),
          meta_campaign: textOrNull(r.campaign_name),
          meta_source_type:
            r.is_organic === true
              ? 'Organic'
              : r.is_organic === false
                ? 'Paid'
                : null,
          meta_created: r.meta_created_time
            ? new Date(r.meta_created_time)
            : null,
          meta_lead_id: textOrNull(r.meta_lead_id),
        };
        for (const [k, v] of Object.entries(displayAnswers))
          out[`answer:${k}`] = v;
        // Source column also lives in answers (var key) — ensured above.
        for (const f of wsFields) {
          const v = valueByRunAndField.get(r.run_id)?.get(f.id) ?? null;
          if (isAssigneeField({ name: f.name })) {
            out[`field:${f.id}`] = showSingleAssignee
              ? displayAssignee(v)
              : null;
            continue;
          }
          out[`field:${f.id}`] =
            v && /follow-up|date|time/i.test(f.name) && Date.parse(v)
              ? new Date(v)
              : v;
        }
        void findFieldId;
        return out;
      });

    const buffer = await buildMetaLeadsWorkbook({
      columns: singleExportColumns,
      rows,
    });
    const filename = buildExportFilename(exportLabel);
    logUnresolved();
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
        ...unresolvedHeader(),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
