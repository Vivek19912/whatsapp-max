// Team Performance loader + normalizers for the owner-only
// Meta Lead Ads Team Performance dashboard.
//
// One GET /api/meta-lead-ads/team-performance per filter state
// (date range). Aggregates + optional paginated detail come from
// Postgres get_meta_leads_team_performance() — never recomputed
// here except for display pivots (pinned stages vs Other) which
// are pure sums over the server buckets.
//
// Conventions (verified against 156/157/170 + route):
// - Current assignee only (workspace Assigned To cell); reassigned
//   leads count under their current owner.
// - Reporting instant COALESCE(meta_created_time, created_at) in tz.
// - Missing Stage stays NULL — displayed as "No Stage", counted
//   inside "Other Stages" for the pinned table columns.
// - Pinned stage columns: New Lead, Contacted, Qualified,
//   Follow Up, Lost. Everything else (other canonical stages,
//   custom stages, NULL) folds into Other Stages so counts
//   always reconcile.

export type TeamDatePreset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom'
  | 'allTime'

export interface TeamDateRange {
  from: string | null
  to: string | null
  label: string
}

export interface TeamStageSplit {
  stage: string | null
  leads: number
}

export interface TeamMemberPerf {
  userId: string
  name: string
  email: string | null
  avatar: string | null
  total: number
  stages: TeamStageSplit[]
  types: { type: string | null; leads: number }[]
}

export interface TeamTablePerf {
  formId: string | null
  formName: string
  total: number
  assigned: number
  unassigned: number
  stages: TeamStageSplit[]
}

export interface TeamLeadRow {
  ts: string | null
  lead_id: string
  form_id: string | null
  form_name: string
  assignee_id: string | null
  assignee_name: string
  stage: string | null
  type: string | null
  contact_name: string | null
  contact_phone: string | null
}

export interface TeamPerformanceData {
  members: TeamMemberPerf[]
  unassigned: { total: number; stages: TeamStageSplit[] }
  summary: { total: number; assigned: number; unassigned: number }
  forms: { formId: string; formName: string }[]
  tables: TeamTablePerf[]
  leads: { total: number; rows: TeamLeadRow[] }
}

export interface TeamPerformanceParams {
  from?: string | null
  to?: string | null
  tz: string
  member?: string | null
  formId?: string | null
  stage?: string | null
  type?: string | null
  search?: string | null
  page?: number
  pageSize?: number
}

export const PINNED_STAGES = ['New Lead', 'Contacted', 'Qualified', 'Follow Up', 'Lost'] as const

function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

function toOptText(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return null
  return v
}

function normalizeStages(input: unknown): TeamStageSplit[] {
  if (!Array.isArray(input)) return []
  const out: TeamStageSplit[] = []
  for (const r of input) {
    if (!r || typeof r !== 'object') continue
    const rec = r as Record<string, unknown>
    const stage = rec.stage === null ? null : typeof rec.stage === 'string' ? rec.stage : undefined
    if (stage === undefined) continue
    if (typeof rec.leads !== 'number' || !Number.isFinite(rec.leads) || rec.leads < 0) continue
    out.push({ stage, leads: Math.floor(rec.leads) })
  }
  return out
}

function normalizeMembers(input: unknown): TeamMemberPerf[] {
  if (!Array.isArray(input)) return []
  const out: TeamMemberPerf[] = []
  for (const m of input) {
    if (!m || typeof m !== 'object') continue
    const r = m as Record<string, unknown>
    if (typeof r.userId !== 'string' || typeof r.name !== 'string') continue
    out.push({
      userId: r.userId,
      name: r.name,
      email: typeof r.email === 'string' ? r.email : null,
      avatar: typeof r.avatar === 'string' ? r.avatar : null,
      total: toCount(r.total),
      stages: normalizeStages(r.stages),
      types: Array.isArray(r.types)
        ? (r.types as unknown[]).flatMap((t) => {
            if (!t || typeof t !== 'object') return []
            const tr = t as Record<string, unknown>
            const type = tr.type === null ? null : typeof tr.type === 'string' ? tr.type : undefined
            if (type === undefined || typeof tr.leads !== 'number') return []
            return [{ type, leads: toCount(tr.leads) }]
          })
        : [],
    })
  }
  return out
}

function normalizeTables(input: unknown): TeamTablePerf[] {
  if (!Array.isArray(input)) return []
  const out: TeamTablePerf[] = []
  for (const t of input) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    if (typeof r.formName !== 'string') continue
    out.push({
      formId: typeof r.formId === 'string' ? r.formId : null,
      formName: r.formName,
      total: toCount(r.total),
      assigned: toCount(r.assigned),
      unassigned: toCount(r.unassigned),
      stages: normalizeStages(r.stages),
    })
  }
  return out.sort((a, b) => b.total - a.total || a.formName.localeCompare(b.formName))
}

function normalizeLeads(input: unknown): { total: number; rows: TeamLeadRow[] } {
  if (!input || typeof input !== 'object') return { total: 0, rows: [] }
  const r = input as Record<string, unknown>
  const rows = Array.isArray(r.rows) ? (r.rows as unknown[]) : []
  const out: TeamLeadRow[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const lr = row as Record<string, unknown>
    if (typeof lr.lead_id !== 'string') continue
    out.push({
      ts: typeof lr.ts === 'string' ? lr.ts : null,
      lead_id: lr.lead_id,
      form_id: typeof lr.form_id === 'string' ? lr.form_id : null,
      form_name: typeof lr.form_name === 'string' ? lr.form_name : 'Unknown form',
      assignee_id: typeof lr.assignee_id === 'string' ? lr.assignee_id : null,
      assignee_name: typeof lr.assignee_name === 'string' ? lr.assignee_name : 'Unnamed member',
      stage: lr.stage === null ? null : typeof lr.stage === 'string' ? lr.stage : null,
      type: lr.type === null ? null : typeof lr.type === 'string' ? lr.type : null,
      contact_name: typeof lr.contact_name === 'string' ? lr.contact_name : null,
      contact_phone: typeof lr.contact_phone === 'string' ? lr.contact_phone : null,
    })
  }
  return { total: toCount(r.total), rows: out }
}

export function normalizeTeamPerformance(json: unknown): TeamPerformanceData {
  const r = (json ?? {}) as Record<string, unknown>
  const summaryRaw = (r.summary ?? {}) as Record<string, unknown>
  const unRaw = (r.unassigned ?? {}) as Record<string, unknown>
  return {
    members: normalizeMembers(r.members),
    unassigned: { total: toCount(unRaw.total), stages: normalizeStages(unRaw.stages) },
    summary: {
      total: toCount(summaryRaw.total),
      assigned: toCount(summaryRaw.assigned),
      unassigned: toCount(summaryRaw.unassigned),
    },
    forms: Array.isArray(r.forms)
      ? (r.forms as unknown[]).flatMap((f) => {
          if (!f || typeof f !== 'object') return []
          const fr = f as Record<string, unknown>
          if (typeof fr.formId !== 'string' || typeof fr.formName !== 'string') return []
          return [{ formId: fr.formId, formName: fr.formName }]
        })
      : [],
    tables: normalizeTables(r.tables),
    leads: normalizeLeads(r.leads),
  }
}

export async function loadTeamPerformance(
  params: TeamPerformanceParams,
  signal?: AbortSignal,
): Promise<TeamPerformanceData> {
  const qs = new URLSearchParams({ tz: params.tz || 'UTC' })
  if (params.formId) qs.set('formId', params.formId)
  if (params.from && params.to) {
    qs.set('from', params.from)
    qs.set('to', params.to)
  }
  if (params.member) qs.set('member', params.member)
  if (params.stage) qs.set('stage', params.stage)
  if (params.type) qs.set('type', params.type)
  if (params.search) qs.set('search', params.search)
  qs.set('page', String(params.page ?? 1))
  qs.set('pageSize', String(params.pageSize ?? 25))
  const res = await fetch(`/api/meta-lead-ads/team-performance?${qs.toString()}`, {
    signal,
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Team performance failed: ${res.status}`)
  return normalizeTeamPerformance(await res.json())
}

// ---- Display pivots (pure sums, always reconcile) ----

export function stageCount(stages: TeamStageSplit[], name: string): number {
  const row = stages.find((s) => s.stage === name)
  return row ? row.leads : 0
}

/** Everything outside the 5 pinned columns (other canonical, custom, NULL). */
export function otherStagesCount(stages: TeamStageSplit[], total: number): number {
  const pinned = PINNED_STAGES.reduce((acc, n) => acc + stageCount(stages, n), 0)
  return Math.max(0, total - pinned)
}

/** Overall stage totals across members + unassigned (same filtered population). */
export function overallStageTotals(data: TeamPerformanceData): { total: number; byStage: Map<string | null, number> } {
  const byStage = new Map<string | null, number>()
  const add = (stages: TeamStageSplit[]) => {
    for (const s of stages) byStage.set(s.stage, (byStage.get(s.stage) ?? 0) + s.leads)
  }
  for (const m of data.members) add(m.stages)
  add(data.unassigned.stages)
  return { total: data.summary.total, byStage }
}

export function overallStageCount(data: TeamPerformanceData, name: string): number {
  let n = 0
  for (const m of data.members) n += stageCount(m.stages, name)
  n += stageCount(data.unassigned.stages, name)
  return n
}

export function overallOtherCount(data: TeamPerformanceData): number {
  const pinned = PINNED_STAGES.reduce((acc, n) => acc + overallStageCount(data, n), 0)
  return Math.max(0, data.summary.total - pinned)
}

// ---- Date presets → YYYY-MM-DD calendar bounds (inclusive) ----

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function resolveTeamDateRange(
  preset: TeamDatePreset,
  now: Date = new Date(),
  customFrom?: string,
  customTo?: string,
): TeamDateRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const key = (d: Date) => toDayKey(d)
  const addDays = (d: Date, n: number) => {
    const out = new Date(d)
    out.setDate(out.getDate() + n)
    return out
  }
  switch (preset) {
    case 'today':
      return { from: key(today), to: key(today), label: 'Today' }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: key(y), to: key(y), label: 'Yesterday' }
    }
    case 'last7':
      return { from: key(addDays(today, -6)), to: key(today), label: 'Last 7 Days' }
    case 'last30':
      return { from: key(addDays(today, -29)), to: key(today), label: 'Last 30 Days' }
    case 'thisMonth': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1)
      return { from: key(start), to: key(today), label: 'This Month' }
    }
    case 'lastMonth': {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const end = new Date(today.getFullYear(), today.getMonth(), 0)
      return { from: key(start), to: key(end), label: 'Last Month' }
    }
    case 'custom': {
      const ok = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
      if (ok(customFrom) && ok(customTo)) {
        const a = customFrom as string
        const b = customTo as string
        return { from: a <= b ? a : b, to: a <= b ? b : a, label: 'Custom Date Range' }
      }
      return { from: key(addDays(today, -29)), to: key(today), label: 'Last 30 Days' }
    }
    case 'allTime':
      return { from: null, to: null, label: 'All Time' }
  }
}
