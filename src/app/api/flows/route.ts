import { NextResponse } from 'next/server'
import { requireAuthenticatedUser } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getFlowTemplate } from '@/lib/flows/templates'
import { DEFAULT_FALLBACK_POLICY } from '@/lib/flows/types'
import { ensureWorkspaceDefaultFields } from '@/lib/flows/workspace-defaults'

/**
 * GET /api/flows — list the caller's flows.
 * POST /api/flows — create a new (draft) flow.
 *
 * Available to every authenticated user. The previous per-account
 * beta gate was removed when Flows went to soft-GA; the UI still
 * shows a "Beta" label so users know the surface is young, but the
 * routes themselves are open.
 */

export async function GET(request: Request) {
  const guard = await requireAuthenticatedUser()
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { supabase } = guard

  // Optional `?kind=` filter. Omitted → every flow (Workspace needs
  // WhatsApp + Meta sources together); `kind=whatsapp_flow` keeps the
  // conversational builder list free of Meta Lead Ads virtual flows.
  const kind = new URL(request.url).searchParams.get('kind')

  let query = supabase
    .from('flows')
    .select('*')
    .order('created_at', { ascending: false })
  if (kind === 'whatsapp_flow' || kind === 'meta_lead_ads') {
    query = query.eq('kind', kind)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ flows: data ?? [] })
}

export async function POST(request: Request) {
  const guard = await requireAuthenticatedUser()
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { userId, supabase } = guard

  // Resolve the caller's account_id — `flows.account_id` is NOT NULL
  // post-017, so an INSERT without it trips the not-null constraint
  // even though the admin client below bypasses RLS.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const body = (await request.json().catch(() => null)) as
    | {
        name?: string
        description?: string | null
        trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
        trigger_config?: Record<string, unknown>
        /**
         * If set, clone the matching template's name + trigger +
         * entry_node_id + nodes[] into a fresh draft for this user.
         * `name` from the body overrides the template default if
         * provided.
         */
        template_slug?: string
      }
    | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  // Every flow's Workspace ships with the 12 default business
  // columns (Assigned To … Final Remark). Best-effort: flow
  // creation is primary, and the Workspace table read path
  // fills any gap lazily — a failure here must never fail the
  // create. The admin client bypasses RLS so provisioning works
  // for every role; scope is the flow's own account.
  async function provisionWorkspaceDefaults(
    accountId: string,
    flowId: string
  ) {
    try {
      await ensureWorkspaceDefaultFields(admin, accountId, flowId)
    } catch (err) {
      console.error('workspace defaults provisioning failed', err)
    }
  }

  // -------- Template clone path --------
  if (body.template_slug) {
    const template = getFlowTemplate(body.template_slug)
    if (!template) {
      return NextResponse.json(
        { error: `Unknown template_slug "${body.template_slug}"` },
        { status: 400 },
      )
    }
    const { data: flow, error: flowErr } = await admin
      .from('flows')
      .insert({
        user_id: userId,
        account_id: accountId,
        name: body.name?.trim() || template.name,
        description: template.description,
        status: 'draft',
        trigger_type: template.trigger_type,
        trigger_config: template.trigger_config,
        entry_node_id: template.entry_node_id,
        fallback_policy: DEFAULT_FALLBACK_POLICY,
      })
      .select()
      .single()
    if (flowErr || !flow) {
      return NextResponse.json(
        { error: flowErr?.message ?? 'flow insert failed' },
        { status: 500 },
      )
    }
    if (template.nodes.length > 0) {
      const { error: nodesErr } = await admin.from('flow_nodes').insert(
        template.nodes.map((n) => ({
          flow_id: flow.id,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
        })),
      )
      if (nodesErr) {
        // Roll back the parent flow so a half-cloned template doesn't
        // sit as an empty draft. CASCADE on flow_id removes the
        // (probably zero) nodes too.
        await admin.from('flows').delete().eq('id', flow.id)
        return NextResponse.json(
          { error: nodesErr.message },
          { status: 500 },
        )
      }
    }
    await provisionWorkspaceDefaults(
      accountId,
      (flow as { id: string }).id
    )
    return NextResponse.json({ flow }, { status: 201 })
  }

  // -------- Plain (empty) create path --------
  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  const trigger_type = body.trigger_type ?? 'keyword'

  const { data, error } = await admin
    .from('flows')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: body.name.trim(),
      description: body.description ?? null,
      status: 'draft',
      trigger_type,
      trigger_config: body.trigger_config ?? {},
      fallback_policy: DEFAULT_FALLBACK_POLICY,
    })
    .select()
    .single()
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'insert failed' },
      { status: 500 },
    )
  }
  await provisionWorkspaceDefaults(accountId, (data as { id: string }).id)
  return NextResponse.json({ flow: data }, { status: 201 })
}
