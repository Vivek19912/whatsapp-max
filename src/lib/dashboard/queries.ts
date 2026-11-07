import type { SupabaseClient } from '@supabase/supabase-js'
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  DashboardKpis,
  FlowBreakdown,
  FlowBreakdownRow,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types'

// ------------------------------------------------------------
// All client-side aggregation. RLS scopes every query to the
// signed-in user automatically, so we never pass user_id explicitly
// here. Perf is acceptable for the current scale (low thousands of
// messages) — if a tenant's dataset outgrows this, we'd migrate the
// heavy aggregations to SQL RPCs. Noted in the PR.
// ------------------------------------------------------------

type DB = SupabaseClient

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(db: DB): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString()
  const yesterdayStart = daysAgoStart(1).toISOString()

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDeals,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    db.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', todayStart),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('deals').select('value, status').eq('status', 'open'),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', todayStart),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
  ])

  const openDealsRows = (openDeals.data ?? []) as { value: number | null }[]
  const openDealsValue = openDealsRows.reduce((sum, d) => sum + (d.value ?? 0), 0)

  return {
    activeConversations: {
      current: openConvCur.count ?? 0,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: (newConvToday.count ?? 0) - (newConvYesterday.count ?? 0),
    },
    newContactsToday: {
      current: newContactsToday.count ?? 0,
      previous: newContactsYesterday.count ?? 0,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: messagesToday.count ?? 0,
      previous: messagesYesterday.count ?? 0,
    },
  }
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('created_at, sender_type')
    .gte('created_at', start)
    .order('created_at', { ascending: true })
  if (error) throw error

  const keys = lastNDayKeys(rangeDays)
  const buckets = new Map<string, { incoming: number; outgoing: number }>()
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 })

  for (const row of (data ?? []) as { created_at: string; sender_type: string }[]) {
    const key = localDayKey(row.created_at)
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (row.sender_type === 'customer') bucket.incoming += 1
    else bucket.outgoing += 1 // agent + bot both count as outgoing
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }))
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db.from('pipeline_stages').select('id, name, color, pipeline_id, position').order('position'),
    db.from('deals').select('stage_id, value, status').eq('status', 'open'),
  ])

  const stages =
    (stagesRes.data ?? []) as { id: string; name: string; color: string }[]
  const deals = (dealsRes.data ?? []) as { stage_id: string; value: number | null }[]

  const byStage = new Map<string, { count: number; total: number }>()
  for (const d of deals) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 }
    row.count += 1
    row.total += d.value ?? 0
    byStage.set(d.stage_id, row)
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(db: DB): Promise<ResponseTimeSummary> {
  // Pull the last 14 days of messages in one shot, then walk per
  // conversation to find each "first inbound" → "first subsequent
  // outbound" pair. 14 days gives us both "this week" + "last week"
  // with enough overlap if the user opens the dashboard late on a
  // Monday.
  const fourteenDaysAgo = daysAgoStart(13).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('conversation_id, sender_type, created_at')
    .gte('created_at', fourteenDaysAgo)
    .order('conversation_id', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as {
    conversation_id: string
    sender_type: string
    created_at: string
  }[]

  // Group per conversation, pair unreplied customer messages with the
  // next outbound message from the agent/bot. A single customer message
  // can only count once (avoids inflating averages if the customer
  // double-messages while the agent takes time to reply).
  interface Sample {
    customerAt: Date
    responseAt: Date
  }
  const samples: Sample[] = []

  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
    }
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts })
      pendingCustomer = null
    }
  }

  const now = new Date()
  const thisWeekStart = daysAgoStart(mondayIndex(now))
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7)

  // Per-day-of-week buckets, averaged over both weeks' worth of data
  // so each bar has more samples to stand on. If a day has no samples
  // its avgMinutes stays null and the chart renders the bar muted.
  const byDow = new Map<number, number[]>()
  for (let i = 0; i < 7; i++) byDow.set(i, [])
  const thisWeekMins: number[] = []
  const lastWeekMins: number[] = []

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000
    if (diffMin < 0) continue
    const dow = mondayIndex(s.customerAt)
    byDow.get(dow)!.push(diffMin)
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin)
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin)
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const samples = byDow.get(dow) ?? []
    return {
      dow,
      avgMinutes: avg(samples),
      samples: samples.length,
    }
  })

  // Silence unused-label warnings — keep the arrays explicitly named
  // for readability above.
  void DOW_SHORT_MON_FIRST

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  }
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, contacts, deals, broadcasts, autoLogs] = await Promise.all([
    db
      .from('messages')
      .select('id, content_text, sender_type, created_at, conversation_id, conversations(contact_id, contacts(name, phone))')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('contacts')
      .select('id, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('deals')
      .select('id, title, updated_at, stage:pipeline_stages(name)')
      .order('updated_at', { ascending: false })
      .limit(10),
    db
      .from('broadcasts')
      .select('id, name, status, total_recipients, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    db
      .from('automation_logs')
      .select('id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const items: ActivityItem[] = []

  // PostgREST returns nested selections as arrays by default, even when
  // the foreign key is 1:1. We normalise by taking [0] on each level.
  for (const m of (msgs.data ?? []) as unknown as Array<{
    id: string
    content_text: string | null
    created_at: string
    conversation_id: string
    conversations:
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }[]
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }
      | null
  }>) {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations
    const contact = Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts
    const who = contact?.name || contact?.phone || 'Unknown'
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: `New message from ${who}`,
      at: m.created_at,
      href: `/inbox?c=${m.conversation_id}`,
    })
  }

  for (const c of (contacts.data ?? []) as Array<{ id: string; name: string | null; phone: string; created_at: string }>) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: `New contact: ${c.name || c.phone}`,
      at: c.created_at,
    })
  }

  for (const d of (deals.data ?? []) as unknown as Array<{
    id: string
    title: string
    updated_at: string
    stage: { name: string }[] | { name: string } | null
  }>) {
    const stage = Array.isArray(d.stage) ? d.stage[0] : d.stage
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: stage?.name
        ? `Deal "${d.title}" in ${stage.name}`
        : `Deal "${d.title}" updated`,
      at: d.updated_at,
      href: '/pipelines',
    })
  }

  for (const b of (broadcasts.data ?? []) as Array<{
    id: string
    name: string
    status: string
    total_recipients: number
    created_at: string
  }>) {
    const label =
      b.status === 'sent'
        ? `sent to ${b.total_recipients} contacts`
        : `${b.status} (${b.total_recipients} recipients)`
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      text: `Broadcast "${b.name}" ${label}`,
      at: b.created_at,
      href: '/broadcasts',
    })
  }

  for (const l of (autoLogs.data ?? []) as unknown as Array<{
    id: string
    trigger_event: string
    status: string
    created_at: string
    automation: { name: string }[] | { name: string } | null
    contact: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null
  }>) {
    const automation = Array.isArray(l.automation) ? l.automation[0] : l.automation
    const contact = Array.isArray(l.contact) ? l.contact[0] : l.contact
    const who = contact?.name || contact?.phone || 'a contact'
    const autoName = automation?.name || 'Automation'
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: `Automation "${autoName}" ${l.status === 'failed' ? 'failed for' : 'triggered for'} ${who}`,
      at: l.created_at,
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}

// ------------------------------------------------------------
// Redesigned dashboard — SUPERSEDED by get_dashboard_analytics.
// (supabase/migrations/074_dashboard_analytics.sql via
// GET /api/dashboard/analytics + src/lib/dashboard/analytics-client.ts).
// The chunked helpers below (fetchMessageConvsInRange /
// fetchConvContactMap / distinctContactsInRange / fetchAllFlowRuns)
// downloaded raw message stubs into the browser (~89 requests /
// ~8.7 MB per load) and are no longer used by the dashboard page.
// Kept for reference; do not call from new code.
// Real message/contact/conversation/flow
// data only. RLS scopes every query to the caller's account; we
// never pass account_id explicitly.
//
// Timestamp semantics (matches spec):
// - TOTAL MESSAGES: count of `messages` rows with created_at in range.
// - UNIQUE CONTACTS MESSAGED: DISTINCT contacts with >=1 message in
//   range (via messages -> conversations -> contact_id).
// - NEW CONTACTS: `contacts.created_at` in range.
// - NEW CONVERSATIONS: `conversations.created_at` in range.
// - FLOW BREAKDOWN: distinct contacts messaged in range, each
//   attributed once via `flow_runs` (conversation-exact run first,
//   else contact's newest active run else newest run — same rule as
//   the Inbox `pickContactFlowRun`). Unattributed contacts form a
//   "No flow" row; pct denominator is distinct contacts in range.
// - MONTHLY UNIQUES: per month, DISTINCT contacts messaged.
// ------------------------------------------------------------

const PAGE_SIZE = 1000
const IN_CHUNK = 200

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

interface MessageConvRow {
  conversation_id: string
  created_at: string
}

/** All (conversation_id, created_at) for messages in range. ID-only — no bodies. */
async function fetchMessageConvsInRange(
  db: DB,
  startISO: string,
  endISO: string,
): Promise<MessageConvRow[]> {
  const out: MessageConvRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await db
      .from('messages')
      .select('conversation_id, created_at')
      .gte('created_at', startISO)
      .lt('created_at', endISO)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = (data ?? []) as MessageConvRow[]
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
    // Safety cap: 100k message ids per range is far beyond the
    // travel-agency scale; prevents an accidental infinite loop.
    if (from >= 100_000) break
  }
  return out
}

/** conversation_id -> contact_id (null when the conversation row is missing). */
async function fetchConvContactMap(db: DB, convIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  const uniq = [...new Set(convIds)]
  if (uniq.length === 0) return map
  for (const part of chunk(uniq, IN_CHUNK)) {
    const { data, error } = await db.from('conversations').select('id, contact_id').in('id', part)
    if (error) throw error
    for (const row of (data ?? []) as { id: string; contact_id: string | null }[]) {
      map.set(row.id, row.contact_id)
    }
  }
  return map
}

async function distinctContactsInRange(
  db: DB,
  startISO: string,
  endISO: string,
): Promise<number> {
  const msgs = await fetchMessageConvsInRange(db, startISO, endISO)
  if (msgs.length === 0) return 0
  const convIds = [...new Set(msgs.map((m) => m.conversation_id))]
  const convToContact = await fetchConvContactMap(db, convIds)
  const contacts = new Set<string>()
  for (const m of msgs) {
    const c = convToContact.get(m.conversation_id)
    if (c) contacts.add(c)
  }
  return contacts.size
}

export async function loadDashboardKpis(
  db: DB,
  startISO: string,
  endISO: string,
  prevStartISO: string,
  prevEndISO: string,
): Promise<DashboardKpis> {
  const [uniqCur, uniqPrev] = await Promise.all([
    distinctContactsInRange(db, startISO, endISO),
    distinctContactsInRange(db, prevStartISO, prevEndISO),
  ])

  return {
    uniqueContacts: { current: uniqCur, previous: uniqPrev },
  }
}

interface FlowRunLite {
  flow_id: string
  contact_id: string | null
  conversation_id: string | null
  started_at: string
  status: string
  flow: { id: string; name: string } | { id: string; name: string }[] | null
}

function flowNameOf(run: FlowRunLite): { id: string; name: string } | null {
  const f = run.flow
  if (!f) return null
  if (Array.isArray(f)) {
    const first = f[0]
    return first ? { id: first.id, name: first.name } : null
  }
  return { id: f.id, name: f.name }
}

function pickRun(runs: FlowRunLite[]): FlowRunLite | null {
  const withFlow = runs.filter((r) => flowNameOf(r))
  if (withFlow.length === 0) return null
  const newest = (a: FlowRunLite, b: FlowRunLite) => (a.started_at >= b.started_at ? a : b)
  const active = withFlow.filter((r) => r.status === 'active')
  return active.length > 0 ? active.reduce(newest) : withFlow.reduce(newest)
}

async function fetchAllFlowRuns(db: DB): Promise<FlowRunLite[]> {
  const out: FlowRunLite[] = []
  let from = 0
  for (;;) {
    const { data, error } = await db
      .from('flow_runs')
      .select('flow_id, contact_id, conversation_id, started_at, status, flow:flows(id, name)')
      .order('started_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = (data ?? []) as unknown as FlowRunLite[]
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
    if (from >= 20_000) break
  }
  return out
}

export async function loadFlowBreakdown(
  db: DB,
  startISO: string,
  endISO: string,
): Promise<FlowBreakdown> {
  const [msgs, runs, flowsRes] = await Promise.all([
    fetchMessageConvsInRange(db, startISO, endISO),
    fetchAllFlowRuns(db),
    db.from('flows').select('id, name'),
  ])
  if (msgs.length === 0) return { rows: [], totalContacts: 0 }
  if (flowsRes.error) throw flowsRes.error

  const flowNames = new Map<string, string>()
  for (const f of (flowsRes.data ?? []) as { id: string; name: string }[]) {
    flowNames.set(f.id, f.name)
  }

  const convIds = [...new Set(msgs.map((m) => m.conversation_id))]
  const convToContact = await fetchConvContactMap(db, convIds)

  // Index runs by conversation and by contact for O(1) attribution.
  const runsByConv = new Map<string, FlowRunLite[]>()
  const runsByContact = new Map<string, FlowRunLite[]>()
  for (const run of runs) {
    if (run.conversation_id) {
      const arr = runsByConv.get(run.conversation_id) ?? []
      arr.push(run)
      runsByConv.set(run.conversation_id, arr)
    }
    if (run.contact_id) {
      const arr = runsByContact.get(run.contact_id) ?? []
      arr.push(run)
      runsByContact.set(run.contact_id, arr)
    }
  }

  // Conversations per contact, then attribute each distinct contact
  // once (not per message): conv-exact run first, else the contact's
  // pick — the same rule the get_dashboard_analytics RPC uses.
  const convsByContact = new Map<string, string[]>()
  for (const convId of convIds) {
    const contactId = convToContact.get(convId) ?? null
    if (!contactId) continue
    const arr = convsByContact.get(contactId) ?? []
    arr.push(convId)
    convsByContact.set(contactId, arr)
  }

  const agg = new Map<string | null, { name: string; contacts: number }>()
  for (const [contactId, convs] of convsByContact) {
    let picked: FlowRunLite | null = null
    for (const convId of convs) {
      const convRuns = runsByConv.get(convId) ?? []
      if (convRuns.length === 0) continue
      const run = pickRun(convRuns)
      picked = pickRun([picked, run].filter((r): r is FlowRunLite => r !== null)) ?? picked
    }
    picked ??= pickRun(runsByContact.get(contactId) ?? [])
    const flow = picked ? flowNameOf(picked) : null
    const key = flow?.id ?? null
    const name = flow ? (flowNames.get(flow.id) ?? flow.name) : 'No flow'
    const entry = agg.get(key) ?? { name, contacts: 0 }
    entry.name = name
    entry.contacts += 1
    agg.set(key, entry)
  }

  const totalContacts = convsByContact.size
  const rows: FlowBreakdownRow[] = [...agg.entries()]
    .map(([flowId, v]) => ({
      flowId,
      flowName: v.name,
      contacts: v.contacts,
      pct: totalContacts > 0 ? (v.contacts / totalContacts) * 100 : 0,
    }))
    .filter((r) => r.contacts > 0)
    .sort((a, b) => b.contacts - a.contacts)

  return { rows, totalContacts }
}

/**
 * Unique contacts messaged per calendar month for `year`.
 * A contact messaged 20 times in Jan counts once for Jan; messaged
 * again in Feb counts once for Feb too.
 */
export async function loadMonthlyUniques(db: DB, year: number): Promise<number[]> {
  const startISO = new Date(year, 0, 1, 0, 0, 0, 0).toISOString()
  const endISO = new Date(year + 1, 0, 1, 0, 0, 0, 0).toISOString()
  const msgs = await fetchMessageConvsInRange(db, startISO, endISO)
  const months: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>())
  if (msgs.length === 0) return Array(12).fill(0)

  const convIds = [...new Set(msgs.map((m) => m.conversation_id))]
  const convToContact = await fetchConvContactMap(db, convIds)

  for (const m of msgs) {
    const contactId = convToContact.get(m.conversation_id)
    if (!contactId) continue
    const d = new Date(m.created_at)
    // Guard against TZ edge rows outside the year (DST/UTC skew).
    if (d.getFullYear() !== year) continue
    months[d.getMonth()].add(contactId)
  }
  return months.map((s) => s.size)
}
