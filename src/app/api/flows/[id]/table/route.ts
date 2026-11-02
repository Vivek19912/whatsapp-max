import { NextResponse } from 'next/server'
import { requireAuthenticatedUser } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ensureWorkspaceDefaultFields } from '@/lib/flows/workspace-defaults'
import {
  parseAssigneeParam,
  serializeAssigneeSelection,
  validateWorkspaceDateRange,
  isCalendarDateString,
  isCallsTriedOp,
  CALLS_TRIED_MIN,
  CALLS_TRIED_MAX,
  COLUMN_FILTER_VALUES_MAX,
  COLUMN_FILTER_VALUE_MAX,
  type WorkspaceAssigneeSelection,
  type WorkspaceDateRange,
} from '@/lib/flows/workspace-filters'
import {
  buildFlowTableColumns,
  toFlowTableRow,
  FLOW_TABLE_PAGE_SIZE,
  type AttachmentMediaEntry,
  type FlowTableRpcRow,
  type FlowTableView,
  type LatestRecordingEntry,
} from '@/lib/flows/flow-tables'
import { latestByContact } from '@/lib/recordings/recordings'
import { uploaderNamesByUserId } from '@/lib/recordings/uploaders'
import { standardContactFromAnswers } from '@/lib/meta-lead-ads/normalize'
import {
  excludeMetaFullNameColumns,
  metaFullNameAnswerKeys,
  metaWorkspaceDisplayName,
} from '@/lib/meta-lead-ads/workspace-name'
import {
  applyOptionLabelsToAnswers,
  buildOptionLabelMap,
  choiceQuestionKeys,
  type StoredFormQuestion,
} from '@/lib/meta-lead-ads/option-labels'
import {
  META_SOURCE_COLUMN_KEY,
  questionVarKeys,
} from '@/lib/meta-lead-ads/virtual-flow'

/**
 * GET /api/flows/[id]/table?view=all|completed|incomplete&search=&page=&pageSize=&dateFrom=&dateTo=&assignee=
 *
 * Workspace foundation read: one row per flow_run (identity =
 * flow_run_id), columns derived from the flow's own nodes,
 * Completed/Incomplete classified by execution reach of the
 * configured completion node (END fallback). Server-side filter +
 * pagination — runs are never fanned out to the browser.
 * RLS scopes every read to the caller's account.
 *
 * Exactly two additive filters (both optional, combinable AND):
 *   dateFrom/dateTo — half-open [from, to) ISO window over
 *     Submission Time (flow_runs.started_at). The client resolves
 *     Today / Yesterday / Last 7 / Last 30 / Custom to concrete
 *     bounds in the viewer's local timezone; the server only
 *     validates ISO shape + from <= to (400 otherwise) and pushes
 *     both into the paginated RPC, so total + page stay correct.
 *   assignee — "all" (default) | "unassigned" | <member user_id>.
 *     Member filtering matches the stable ID server-side; unknown
 *     or foreign IDs match zero rows (account isolation holds
 *     inside the account-scoped RPC).
 *
 * Plus five optional column filters over existing business columns
 * (migration 118 — absent = inactive, AND with everything else):
 *   callStatus[] / followUpStatus[] — repeated query keys; stored
 *     single-select value must equal ANY listed value (OR within
 *     the section). Unknown values simply match nothing.
 *   callsTriedOp (eq|gt|lt|between) + callsTriedValue (eq/gt/lt)
 *     or callsTriedMin+callsTriedMax (between) — numeric conditions
 *     over the stored "No. of Calls Tried" count.
 *   lastContactFrom/lastContactTo — YYYY-MM-DD calendar days,
 *     half-open [from, to) over "Last Contact Date".
 *   nextFollowUpFrom/nextFollowUpTo — UTC ISO instants, half-open
 *     [from, to) over "Next Follow-up Date & Time" (stored values
 *     normalize to toISOString() on write; bounds normalize the
 *     same way — no tz skew). Rows with no follow-up never match.
 * All column-filter inputs validate here (400 otherwise) and push
 * into the paginated RPC, so total + page stay correct with any
 * combination active — including search, views, pin ordering, and
 * hidden exclusion. Applying or clearing filters never writes
 * lead data; the meta.filters echo shape is unchanged.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const url = new URL(request.url)
  const rawView = url.searchParams.get('view') ?? 'all'
  if (rawView !== 'all' && rawView !== 'completed' && rawView !== 'incomplete') {
    return NextResponse.json(
      { error: 'view must be all, completed, or incomplete' },
      { status: 400 },
    )
  }
  const view = rawView as FlowTableView
  const search = url.searchParams.get('search')?.slice(0, 120) ?? ''
  const page = Math.max(Number(url.searchParams.get('page') ?? 0) || 0, 0)
  const pageSize = Math.min(
    Math.max(Number(url.searchParams.get('pageSize') ?? FLOW_TABLE_PAGE_SIZE) || FLOW_TABLE_PAGE_SIZE, 1),
    100,
  )

  // Workspace filters — additive query keys; absent = inactive.
  // Date bounds are validated ISO instants (400 on garbage or an
  // inverted range); the assignee keyword/id is parsed leniently
  // (unknown ids match zero rows rather than 400ing the table).
  let dateRange: WorkspaceDateRange | null = null
  const rawFrom = url.searchParams.get('dateFrom')
  const rawTo = url.searchParams.get('dateTo')
  if (rawFrom !== null || rawTo !== null) {
    if (!rawFrom || !rawTo) {
      return NextResponse.json(
        { error: 'dateFrom and dateTo are required together.' },
        { status: 400 },
      )
    }
    try {
      dateRange = validateWorkspaceDateRange({ from: rawFrom, to: rawTo })
    } catch {
      return NextResponse.json(
        { error: 'dateFrom/dateTo must be valid ISO datetimes with from <= to.' },
        { status: 400 },
      )
    }
  }
  let assignee: WorkspaceAssigneeSelection
  try {
    assignee = parseAssigneeParam(url.searchParams.get('assignee'))
  } catch {
    return NextResponse.json(
      { error: 'Invalid assignee filter.' },
      { status: 400 }
    )
  }

  // Column filters — additive query keys; absent = inactive. Every
  // input validates here (400 otherwise) and pushes into the
  // paginated RPC. Categorical values match stored single-select
  // values by exact equality server-side, so unknown values simply
  // match zero rows rather than 400ing the table.
  const badColumnFilter = (message: string) =>
    NextResponse.json({ error: message }, { status: 400 })

  function parseMultiValues(key: string): string[] | null {
    const raw = url.searchParams.getAll(key)
    const seen = new Set<string>()
    const out: string[] = []
    for (const entry of raw) {
      const v = entry.trim()
      if (v === '' || seen.has(v)) continue
      if (v.length > COLUMN_FILTER_VALUE_MAX) {
        throw new Error(
          `Filter values must be ${COLUMN_FILTER_VALUE_MAX} characters or fewer.`
        )
      }
      seen.add(v)
      out.push(v)
    }
    if (out.length > COLUMN_FILTER_VALUES_MAX) {
      throw new Error(
        `At most ${COLUMN_FILTER_VALUES_MAX} values per filter.`
      )
    }
    return out.length > 0 ? out : null
  }

  function parseCallsTriedInt(raw: string | null, what: string): number {
    // Number("") is 0 — blank inputs must 400, not filter for 0.
    if (raw === null || raw.trim() === '') {
      throw new Error(
        `${what} must be a whole number between ${CALLS_TRIED_MIN} and ${CALLS_TRIED_MAX}.`
      )
    }
    const num = Number(raw.trim())
    if (!Number.isInteger(num) || num < CALLS_TRIED_MIN || num > CALLS_TRIED_MAX) {
      throw new Error(
        `${what} must be a whole number between ${CALLS_TRIED_MIN} and ${CALLS_TRIED_MAX}.`
      )
    }
    return num
  }

  function parseInstant(raw: string | null, what: string): string | null {
    if (raw === null || raw.trim() === '') return null
    const ms = Date.parse(raw.trim())
    if (Number.isNaN(ms)) {
      throw new Error(`${what} must be a valid datetime.`)
    }
    // Canonical UTC ISO (toISOString shape) — the same
    // normalization stored values carry, so text comparison in the
    // RPC is chronological with no tz skew.
    return new Date(ms).toISOString()
  }

  let callStatus: string[] | null = null
  let followUpStatus: string[] | null = null
  let callsTriedOp: string | null = null
  let callsTriedValue: number | null = null
  let callsTriedMin: number | null = null
  let callsTriedMax: number | null = null
  let lastContactFrom: string | null = null
  let lastContactTo: string | null = null
  let nextFollowUpFrom: string | null = null
  let nextFollowUpTo: string | null = null
  try {
    callStatus = parseMultiValues('callStatus')
    followUpStatus = parseMultiValues('followUpStatus')

    const rawOp = url.searchParams.get('callsTriedOp')
    if (rawOp !== null && rawOp.trim() !== '') {
      if (!isCallsTriedOp(rawOp.trim())) {
        throw new Error('callsTriedOp must be eq, gt, lt, or between.')
      }
      callsTriedOp = rawOp.trim()
      if (callsTriedOp === 'between') {
        callsTriedMin = parseCallsTriedInt(
          url.searchParams.get('callsTriedMin'), 'Min calls'
        )
        callsTriedMax = parseCallsTriedInt(
          url.searchParams.get('callsTriedMax'), 'Max calls'
        )
        if (callsTriedMin > callsTriedMax) {
          throw new Error('Min calls must be on or below max calls.')
        }
      } else {
        callsTriedValue = parseCallsTriedInt(
          url.searchParams.get('callsTriedValue'), 'Call count'
        )
      }
    }

    const rawLcFrom = url.searchParams.get('lastContactFrom')
    const rawLcTo = url.searchParams.get('lastContactTo')
    if (rawLcFrom !== null || rawLcTo !== null) {
      if (
        (rawLcFrom !== null && !isCalendarDateString(rawLcFrom)) ||
        (rawLcTo !== null && !isCalendarDateString(rawLcTo))
      ) {
        throw new Error('lastContactFrom/To must be valid dates (YYYY-MM-DD).')
      }
      if (
        rawLcFrom !== null &&
        rawLcTo !== null &&
        rawLcFrom.trim() > rawLcTo.trim()
      ) {
        throw new Error('lastContactFrom must be on or before lastContactTo.')
      }
      lastContactFrom = rawLcFrom?.trim() ?? null
      lastContactTo = rawLcTo?.trim() ?? null
    }

    nextFollowUpFrom = parseInstant(url.searchParams.get('nextFollowUpFrom'), 'nextFollowUpFrom')
    nextFollowUpTo = parseInstant(url.searchParams.get('nextFollowUpTo'), 'nextFollowUpTo')
    if (
      nextFollowUpFrom !== null &&
      nextFollowUpTo !== null &&
      nextFollowUpFrom > nextFollowUpTo
    ) {
      throw new Error('nextFollowUpFrom must be on or before nextFollowUpTo.')
    }
  } catch (err) {
    return badColumnFilter(
      err instanceof Error ? err.message : 'Invalid column filter.'
    )
  }

  const guard = await requireAuthenticatedUser()
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { supabase, userId: callerUserId } = guard

  const { data: flow, error: flowErr } = await supabase
    .from('flows')
    .select('id, name, account_id, completion_node_id, entry_node_id, kind, meta_form_id')
    .eq('id', id)
    .maybeSingle()
  if (flowErr) {
    return NextResponse.json({ error: flowErr.message }, { status: 500 })
  }
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const flowKind = (flow as { kind?: string | null }).kind ?? null

  // Agents on Meta Lead Ads Tables see only their own assigned
  // leads. The assignee filter is forced to the caller's user id
  // here, so search, filters, pagination, counts, and every
  // enrichment below compose over the owned set and the client
  // cannot override it. Owners, admins, viewers, and every Flow
  // Table keep existing behavior exactly.
  if (flowKind === 'meta_lead_ads') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_role')
      .eq('user_id', callerUserId)
      .maybeSingle()
    if (
      (profile as { account_role?: string } | null)?.account_role === 'agent'
    ) {
      assignee = { type: 'member', userId: callerUserId }
    }
  }

  const { data: nodes, error: nodesErr } = await supabase
    .from('flow_nodes')
    .select('node_key, node_type, config, created_at')
    .eq('flow_id', id)
    .order('created_at', { ascending: true })
  if (nodesErr) {
    return NextResponse.json({ error: nodesErr.message }, { status: 500 })
  }

  const { data: payload, error: rpcErr } = await supabase.rpc(
    'get_flow_table_rows',
    {
      p_flow_id: id,
      p_view: view,
      p_search: search || null,
      p_page: page,
      p_page_size: pageSize,
      // Server-side filters (migration 094 — NULL/absent = inactive,
      // so unfiltered reads behave exactly as before). Pagination
      // applies to the FILTERED set, keeping total + row numbering
      // correct with any combination active.
      p_started_from: dateRange?.from ?? null,
      p_started_to: dateRange?.to ?? null,
      p_assignee: serializeAssigneeSelection(assignee),
      // Column filters (migration 118 — NULL/absent = inactive).
      // Conjunctive with every predicate above; total + page slice
      // stay correct, and pin ordering + hidden exclusion compose.
      p_call_status: callStatus,
      p_calls_tried_op: callsTriedOp,
      p_calls_tried_value: callsTriedValue,
      p_calls_tried_min: callsTriedMin,
      p_calls_tried_max: callsTriedMax,
      p_followup_status: followUpStatus,
      p_last_contact_from: lastContactFrom,
      p_last_contact_to: lastContactTo,
      p_next_followup_from: nextFollowUpFrom,
      p_next_followup_to: nextFollowUpTo,
    },
  )
  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 })
  }

  const completionNodeId =
    (flow as { completion_node_id?: string | null }).completion_node_id ?? null
  const { columns, nameKey, answerKeys } = buildFlowTableColumns(
    (nodes ?? []).map((n) => ({
      node_key: (n as { node_key: string }).node_key,
      node_type: (n as { node_type: string }).node_type,
      config: ((n as { config?: unknown }).config ?? {}) as Record<string, unknown>,
      created_at: (n as { created_at?: string | null }).created_at ?? null,
    })),
    (flow as { entry_node_id?: string | null }).entry_node_id ?? null,
  )
  const rpcRows = ((payload as { rows?: unknown }).rows ?? []) as FlowTableRpcRow[]
  const total = Number((payload as { total?: unknown }).total ?? 0) || 0
  // Meta Instant Form leads without a contact row (no usable phone)
  // still carry the name/phone Meta supplied. The phone fallback
  // below surfaces those in the system Phone column as a read-only
  // fallback — contact data wins whenever it exists, and nothing
  // is invented for absent fields. The system NAME column follows
  // a different, Meta-only rule (see the per-row projection
  // below): the current submission's own Full Name answer wins over
  // the shared contact's WhatsApp profile name. Other flow kinds
  // are untouched.
  const isMetaLeadFlow = flowKind === 'meta_lead_ads'
  // Full Name twin keys for this form (Meta-only). Defaults to the
  // canonical `full_name` key so forms whose question metadata was
  // never synced still suppress the twin; refined from the stored
  // FULL_NAME question metadata when available.
  let metaFullNameKeys = metaFullNameAnswerKeys(null, [])

  // Meta-only column order: the Source answer column moves to the
  // end of the dynamic Instant Form question columns (just before
  // Latest Recording), instead of leading them. Display order only
  // — keys, values, visibility ids, Sheets (node-derived), filters,
  // and Travel CRM are untouched, and every other flow kind keeps
  // builder order. Applies uniformly regardless of how many
  // questions the form has; a missing Source column is a no-op.
  if (isMetaLeadFlow) {
    const sourceIdx = columns.findIndex((c) => c.key === META_SOURCE_COLUMN_KEY)
    if (sourceIdx > -1) {
      const [sourceCol] = columns.splice(sourceIdx, 1)
      const recordIdx = columns.findIndex((c) => c.key === 'latest_recording')
      columns.splice(recordIdx === -1 ? columns.length : recordIdx, 0, sourceCol)
    }
  }

  // Meta-only display mapping: human-readable Instant Form option
  // labels resolved from the form's stored question metadata, plus
  // an underscore-to-spaces fallback for known choice questions
  // whose options were never synced (older enabled forms). Display-
  // only: stored answers, keys, filtering, Sheets exports, and
  // Travel CRM reads are untouched — only the rendered cell text
  // changes, preferring exact option-key matches first.
  let metaOptionLabels: Map<string, Map<string, string>> | null = null
  let metaChoiceKeys: Set<string> | null = null
  if (isMetaLeadFlow) {
    const formId = (flow as { meta_form_id?: string | null }).meta_form_id ?? null
    if (formId) {
      const { data: formRow } = await supabase
        .from('meta_lead_forms')
        .select('questions')
        .eq('id', formId)
        .eq('account_id', (flow as { account_id: string }).account_id)
        .maybeSingle()
      // Options live in the raw stored JSON (parseFormQuestions
      // drops them). Keys must match node var_keys exactly: reuse
      // the same deterministic derivation the virtual flow was
      // built with.
      const rawQuestions = (formRow as { questions?: unknown } | null)?.questions
      const rawList = Array.isArray(rawQuestions) ? rawQuestions : []
      const stored: StoredFormQuestion[] = rawList.map((entry) => {
        const e =
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>)
            : {};
        const rawOptions = Array.isArray(e.options) ? e.options : []
        return {
          key: typeof e.key === "string" ? e.key : null,
          label: typeof e.label === "string" ? e.label : null,
          type: typeof e.type === "string" ? e.type : null,
          options: rawOptions.map((o) => {
            const oo =
              o && typeof o === "object" ? (o as Record<string, unknown>) : {}
            return {
              key: typeof oo.key === "string" ? oo.key : null,
              value: typeof oo.value === "string" ? oo.value : null,
            }
          }),
        }
      })
      const keys = questionVarKeys(stored)
      metaOptionLabels = buildOptionLabelMap(stored, keys)
      metaChoiceKeys = choiceQuestionKeys(stored, keys)
      // Meta-only: resolve which answer keys are the Full Name
      // twin (stored FULL_NAME question type, aligned by index).
      metaFullNameKeys = metaFullNameAnswerKeys(stored, keys)
    }
  }

  // Meta-only Full Name twin suppression: the `flow:full_name`
  // question column is excluded from the table column list so the
  // Full Name answer renders ONLY under the system Name header.
  // Presentation-only — `answerKeys`, stored answers, visibility
  // ids for every other column, and all downstream data readers
  // (Sheets, variables, notifications, Travel CRM) are untouched.
  // Flow Tables keep every column exactly as derived.
  const responseColumns = isMetaLeadFlow
    ? excludeMetaFullNameColumns(columns, metaFullNameKeys)
    : columns

  const rows = rpcRows.map((r) => {
    const identityFallback = isMetaLeadFlow
      ? standardContactFromAnswers(
          (r.vars ?? {}) as Record<string, string | null | undefined>,
        )
      : null
    const row = toFlowTableRow(
      r,
      completionNodeId,
      nameKey,
      answerKeys,
      identityFallback,
    )
    // Meta-only display-name projection: the system Name cell shows
    // the CURRENT submission's own Full Name answer first
    // (flow_runs.vars["full_name"]), then the normalized
    // standard-name fallback for that submission, and only then the
    // shared contact's name. Each lead row therefore displays its
    // own Instant Form answer even when the contact's WhatsApp
    // profile name (shared across that contact's rows) differs.
    // The stored contact, vars, and answers are never modified.
    if (isMetaLeadFlow) {
      row.name = metaWorkspaceDisplayName(
        (r.vars ?? {}) as Record<string, unknown>,
        row.name,
      )
    }
    // Meta-only, dynamic answers only: system Name/Phone columns
    // keep their contact/fallback values untouched. `rawAnswers`
    // preserves the exact ingested values (needed for Restore
    // Original Answer); `answers` carries the display mapping.
    if (isMetaLeadFlow) {
      row.rawAnswers = { ...row.answers }
      if (
        (metaOptionLabels && metaOptionLabels.size > 0) ||
        (metaChoiceKeys && metaChoiceKeys.size > 0)
      ) {
        row.answers = applyOptionLabelsToAnswers(
          row.answers,
          metaOptionLabels ?? new Map(),
          metaChoiceKeys ?? new Set(),
        )
      }
    }
    return row
  });

  // Contact source URLs for this page: one batched contacts lookup
  // (flow_run.contact_id → contacts.source_url), never N+1.
  // RLS scopes the read like every other query on this route.
  // The client uses them read-only for the "Lead Received"
  // auto-detect default (Facebook/Instagram ad platform) — the
  // response shape is unchanged.
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))] as string[];
  const sourceByContact: Record<string, string | null> = {};
  if (contactIds.length > 0) {
    const { data: sourceRows } = await supabase
      .from("contacts")
      .select("id, source_url")
      .in("id", contactIds);
    for (const c of (sourceRows ?? []) as Array<{ id: string; source_url: string | null }>) {
      sourceByContact[c.id] = c.source_url;
    }
  }
  for (const r of rows) {
    r.sourceUrl = r.contactId ? (sourceByContact[r.contactId] ?? null) : null;
  }

  // Media messages for this page's runs, one batched lookup keyed by
  // conversation id (never N+1), additive to the response. Lets the
  // Workspace turn a flow-answer filename captured from an inbound
  // document/image into a clickable link that opens the ACTUAL stored
  // media URL — the existing `/api/whatsapp/media/{mediaId}` proxy the
  // inbox already uses (serves images/PDFs inline). Purely additive:
  // filtering, pagination, and RLS scope are unchanged, and rows with
  // no media simply have no entry here.
  const conversationIds = [...new Set(rows.map((r) => r.conversationId).filter(Boolean))] as string[];
  const mediaByConversation: Record<string, AttachmentMediaEntry[]> = {};
  if (conversationIds.length > 0) {
    const { data: mediaRows } = await supabase
      .from("messages")
      .select("conversation_id, content_text, media_url, content_type")
      .in("conversation_id", conversationIds)
      .not("media_url", "is", null)
      .order("created_at", { ascending: true });
    for (const m of (mediaRows ?? []) as Array<{
      conversation_id: string;
      content_text: string | null;
      media_url: string | null;
      content_type: string | null;
    }>) {
      // Defensive skip: only rows with a real file URL belong in the
      // media map (the `.not` filter is the primary guard).
      if (!m.media_url) continue;
      (mediaByConversation[m.conversation_id] ??= []).push({
        contentText: m.content_text,
        mediaUrl: m.media_url,
        contentType: m.content_type,
      });
    }
  }

  // Latest call recording per contact for this page's rows: one
  // batched call_recordings read for the page's contacts plus one
  // batched profiles read for the uploaders (never N+1). Additive
  // to the response — contacts without a recording simply have no
  // entry. RLS scopes both reads like every other query here.
  // No DISTINCT ON (PostgREST has no per-group limit and no new
  // RPC/migration is wanted): the page holds ≤100 contacts, so
  // reducing to latest-per-contact in JS is one small pass.
  // Best-effort like the overrides read: a failure (e.g. the
  // call_recordings table predates migration 105) degrades to no
  // recording badges, never a broken table.
  const latestRecordingByContact: Record<string, LatestRecordingEntry> = {};
  if (contactIds.length > 0) {
    try {
      const { data: recordingRows, error: recordingsError } = await supabase
        .from('call_recordings')
        .select('id, contact_id, duration_seconds, recorded_at, created_at, file_name, uploaded_by')
        .eq('account_id', (flow as { account_id: string }).account_id)
        .in('contact_id', contactIds)
        .order('contact_id', { ascending: true })
        .order('recorded_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
      if (recordingsError) throw recordingsError;
      const latestById = latestByContact(
        ((recordingRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
          id: r.id as string,
          contact_id: (r.contact_id as string | null) ?? null,
          duration_seconds: (r.duration_seconds as number | null) ?? null,
          recorded_at: (r.recorded_at as string | null) ?? null,
          created_at: r.created_at as string,
          file_name: (r.file_name as string | null) ?? null,
          uploaded_by: (r.uploaded_by as string | null) ?? null,
        })),
        (r) => r.contact_id
      );
      const winnerIds = [...latestById.values()].map((r) => r.uploaded_by).filter(Boolean) as string[];
      const names = await uploaderNamesByUserId(supabase, winnerIds);
      for (const [contactId, r] of latestById) {
        latestRecordingByContact[contactId] = {
          id: r.id,
          contact_id: contactId,
          duration_seconds: r.duration_seconds,
          recorded_at: r.recorded_at,
          created_at: r.created_at,
          file_name: r.file_name,
          uploader_name: r.uploaded_by
            ? (names[r.uploaded_by] ?? 'Unknown')
            : null,
        };
      }
    } catch (err) {
      console.error('workspace latest recordings read failed', err);
    }
  }

  // Workspace custom columns + this page's values (two queries, no
  // N+1). Additive to the response — existing shape untouched.
  // Google Sheets never reads these tables.
  // First-use safety net: flows predating default business columns
  // (or created outside the API) get their missing defaults here,
  // so Completed and Incomplete — views over the SAME flow fields
  // — always share one configuration. Best-effort and
  // role-independent (service-role write scoped to this flow's own
  // account, which the RLS-scoped fetch above already proved the
  // caller may see); a failure never breaks the read.
  try {
    const typed = flow as { id: string; account_id: string }
    await ensureWorkspaceDefaultFields(supabaseAdmin(), typed.account_id, typed.id)
  } catch (err) {
    console.error('workspace defaults provisioning failed', err)
  }
  const { data: customFields } = await supabase
    .from("workspace_fields")
    .select("*")
    .eq("flow_id", id)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  const runIds = rows.map((r) => r.runId);
  const customValues: Record<string, Record<string, string | null>> = {};
  if (runIds.length > 0) {
    const { data: valueRows } = await supabase
      .from("workspace_values")
      .select("flow_run_id, field_id, value_text")
      .in("flow_run_id", runIds);
    for (const v of (valueRows ?? []) as Array<{
      flow_run_id: string;
      field_id: string;
      value_text: string | null;
    }>) {
      (customValues[v.flow_run_id] ??= {})[v.field_id] = v.value_text;
    }
  }
  // Agent overrides for flow-derived cells (one batched read, no
  // N+1). Originals stay in `rows[].answers`; this additive map
  // drives Workspace display + restore UI only — flow_runs.vars,
  // Sheets, and history are untouched. Best-effort: a read failure
  // (e.g. migration not yet applied) degrades to originals.
  const flowOverrides: Record<string, Record<string, string | null>> = {};
  if (runIds.length > 0) {
    try {
      const { data: overrideRows, error: overrideErr } = await supabase
        .from("workspace_flow_overrides")
        .select("flow_run_id, field_key, value_text")
        .eq("account_id", (flow as { account_id: string }).account_id)
        .eq("flow_id", id)
        .in("flow_run_id", runIds);
      if (overrideErr) throw overrideErr;
      for (const v of (overrideRows ?? []) as Array<{
        flow_run_id: string;
        field_key: string;
        value_text: string | null;
      }>) {
        (flowOverrides[v.flow_run_id] ??= {})[v.field_key] = v.value_text;
      }
    } catch (err) {
      console.error("workspace flow overrides read failed", err);
    }
  }
  return NextResponse.json({
    meta: {
      flowId: (flow as { id: string }).id,
      flowName: (flow as { name: string }).name,
      kind: (flow as { kind?: string | null }).kind ?? null,
      completionNodeId,
      view,
      total,
      page,
      pageSize,
      // Echo of the applied filters (additive — existing shape
      // untouched). Nulls/absent-equivalent mean "inactive".
      filters: {
        dateFrom: dateRange?.from ?? null,
        dateTo: dateRange?.to ?? null,
        assignee: serializeAssigneeSelection(assignee),
      },
    },
    columns: responseColumns,
    rows,
    customFields: (customFields ?? []).map((f) => {
      const row = f as Record<string, unknown>;
      return {
        id: row.id,
        name: row.name,
        field_type: row.field_type,
        position: row.position,
        options: row.options ?? null,
        default_value: row.default_value ?? null,
        currency_code: row.currency_code ?? null,
      };
    }),
    customValues,
    flowOverrides,
    mediaByConversation,
    latestRecordingByContact,
  });
}
