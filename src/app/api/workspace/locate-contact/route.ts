import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  FLOW_TABLE_PAGE_SIZE,
  type LocateContactResponse,
  type LocateContactView,
} from '@/lib/flows/flow-tables'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Tabs a deep link may land on (the UI has no "all" tab). */
const VIEWS: readonly LocateContactView[] = ['completed', 'incomplete']
/** Upper bound on flows scanned per lookup (most-recent first). */
const MAX_LOCATE_FLOWS = 5
/** Upper bound on pages scanned per (flow, view). */
const MAX_LOCATE_PAGES = 10
/** Upper bound on runs read to order candidate flows by recency. */
const MAX_RUNS_FOR_FLOW_ORDER = 200

interface RpcRow {
  run_id?: unknown
  contact_id?: unknown
}

/**
 * GET /api/workspace/locate-contact?contact_id=<uuid>&page_size=<n>
 *
 * Deep-link helper for `/workspace?contact=`: locates the
 * (flow, view, page) window holding a contact's most relevant
 * flow-run row so the client can navigate there through the NORMAL
 * table path and select it with the existing mechanism.
 *
 * Search order is deterministic: candidate flows by most-recent
 * run first, `completed` tab before `incomplete`, pages ascending
 * (the table's own newest-first ordering) — the first hit is the
 * same row the user would reach by paging, no random pick.
 *
 * Bounded: at most MAX_LOCATE_FLOWS × 2 views × MAX_LOCATE_PAGES
 * paginated RPC reads, and only rows (≤ page_size each) cross —
 * never the full table. Fired only for `?contact=` navigations.
 *
 * Security: account-scoped throughout. Missing and foreign
 * contacts share one 404 shape (no oracle); the table RPC itself
 * re-checks account ownership under RLS.
 */
export async function GET(request: Request) {
  let ctx: Awaited<ReturnType<typeof getCurrentAccount>>
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId, userId, role } = ctx

  const params = new URL(request.url).searchParams
  const contactId = params.get('contact_id')?.trim() ?? ''
  if (!UUID_RE.test(contactId)) {
    return NextResponse.json(
      { error: 'contact_id must be a UUID.' },
      { status: 400 },
    )
  }
  // Same clamp as the table route so the returned page index
  // matches the page the client will request.
  const pageSize = Math.min(
    Math.max(
      Number(params.get('page_size')) || FLOW_TABLE_PAGE_SIZE,
      1,
    ),
    100,
  )

  const { data: contact, error: contactErr } = await supabase
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (contactErr) {
    return NextResponse.json({ error: contactErr.message }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json(
      { found: false } satisfies LocateContactResponse,
      { status: 404 },
    )
  }

  const { data: runRows, error: runsErr } = await supabase
    .from('flow_runs')
    .select('flow_id,started_at')
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
    .order('started_at', { ascending: false })
    .limit(MAX_RUNS_FOR_FLOW_ORDER)
  if (runsErr) {
    return NextResponse.json({ error: runsErr.message }, { status: 500 })
  }
  const flowIds: string[] = []
  for (const r of (runRows ?? []) as Array<{
    flow_id?: unknown
  }>) {
    if (typeof r.flow_id === 'string' && !flowIds.includes(r.flow_id)) {
      flowIds.push(r.flow_id)
      if (flowIds.length >= MAX_LOCATE_FLOWS) break
    }
  }
  if (flowIds.length === 0) {
    return NextResponse.json(
      { found: false } satisfies LocateContactResponse,
    )
  }

  // Agents work only their own assigned Meta leads: non-Meta
  // flows are skipped for them, and the RPC itself is forced to
  // their assignment so a located row is owned by construction.
  // Owners/admins/viewers scan exactly as before.
  const isAgent = role === "agent";
  let metaFlowIds: Set<string> | null = null
  if (isAgent) {
    const { data: kindRows, error: kindErr } = await supabase
      .from("flows")
      .select("id, kind")
      .eq("account_id", accountId)
      .in("id", flowIds)
    if (kindErr) {
      return NextResponse.json({ error: kindErr.message }, { status: 500 })
    }
    metaFlowIds = new Set(
      ((kindRows ?? []) as Array<{ id: string; kind: string | null }>)
        .filter((f) => f.kind === "meta_lead_ads")
        .map((f) => f.id),
    )
  }

  for (const flowId of flowIds) {
    const forceAssignee =
      isAgent && metaFlowIds !== null
        ? metaFlowIds.has(flowId)
          ? userId
          : null
        : null
    if (isAgent && metaFlowIds !== null && !metaFlowIds.has(flowId)) continue
    for (const view of VIEWS) {
      for (let page = 0; page < MAX_LOCATE_PAGES; page++) {
        let rows: RpcRow[]
        try {
          const { data, error } = await supabase.rpc(
            'get_flow_table_rows',
            {
              p_flow_id: flowId,
              p_view: view,
              p_search: null,
              p_page: page,
              p_page_size: pageSize,
              p_started_from: null,
              p_started_to: null,
              p_assignee: forceAssignee,
            },
          )
          if (error) throw error
          const payload = data as { rows?: unknown } | null
          rows = Array.isArray(payload?.rows)
            ? (payload.rows as RpcRow[])
            : []
        } catch (err) {
          // Best-effort like the table route's own enrichment
          // reads: a failing (flow, view) degrades to "not here",
          // never a broken lookup.
          console.error('[locate-contact] table read failed', {
            flowId,
            view,
            page,
            err: err instanceof Error ? err.message : String(err),
          })
          break
        }
        if (rows.length === 0) break
        const hit = rows.find((r) => r.contact_id === contactId)
        if (hit && typeof hit.run_id === 'string') {
          return NextResponse.json(
            {
              found: true,
              flow_id: flowId,
              view,
              page,
              run_id: hit.run_id,
            } satisfies LocateContactResponse,
          )
        }
      }
    }
  }

  return NextResponse.json(
    { found: false } satisfies LocateContactResponse,
  )
}
