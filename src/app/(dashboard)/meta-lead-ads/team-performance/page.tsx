"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  CalendarDays,
  Crown,
  ExternalLink,
  Info,
  UserCheck,
  UserX,
  Users,
  UsersRound,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { KpiCard } from '@/components/dashboard/kpi-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  PINNED_STAGES,
  loadTeamPerformance,
  otherStagesCount,
  overallOtherCount,
  overallStageCount,
  resolveTeamDateRange,
  stageCount,
  type TeamDatePreset,
  type TeamPerformanceData,
} from '@/lib/meta-leads-dashboard/team-performance-client'

/**
 * Owner-only Team Performance dashboard (all Meta Lead Ads tables).
 *
 * One aggregates request per date range via
 * GET /api/meta-lead-ads/team-performance (no formId) backed by
 * get_meta_leads_team_performance(). Leads are grouped by their
 * creation date (COALESCE(meta_created_time, created_at)) and their
 * CURRENT assignee + CURRENT Stage. Reassigned leads count under
 * their current owner.
 */

const PRESETS: { value: TeamDatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 Days' },
  { value: 'last30', label: 'Last 30 Days' },
  { value: 'thisMonth', label: 'This Month' },
  { value: 'lastMonth', label: 'Last Month' },
  { value: 'custom', label: 'Custom Date Range' },
  { value: 'allTime', label: 'All Time' },
]

const STAGE_COLORS: Record<string, string> = {
  'New Lead': '#2563eb',
  Contacted: '#06b6d4',
  Qualified: '#16a34a',
  'Follow Up': '#9333ea',
  Lost: '#ef4444',
}
const OTHER_COLOR = '#9ca3af'
const MEMBER_BAR_COLOR = '#2563eb'
const UNASSIGNED_BAR_COLOR = '#9ca3af'

function formatLeadDate(ts: string | null): string {
  if (!ts) return '—'
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return '—'
  return new Date(t).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function stageLabel(stage: string | null): string {
  if (!stage || stage.trim() === '') return 'No Stage'
  return stage
}

interface LeadsDialogState {
  kind: 'member' | 'table'
  memberId: string | null
  memberName: string
  formId: string | null
  formName: string
}

export default function TeamPerformancePage() {
  const { accountRole, profileLoading } = useAuth()
  const isOwner = !profileLoading && accountRole === 'owner'
  const isDenied = !profileLoading && accountRole !== 'owner'

  const [preset, setPreset] = useState<TeamDatePreset>('last30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const range = useMemo(
    () => resolveTeamDateRange(preset, new Date(), customFrom || undefined, customTo || undefined),
    [preset, customFrom, customTo],
  )

  const [data, setData] = useState<TeamPerformanceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dialog, setDialog] = useState<LeadsDialogState | null>(null)
  const [dialogPage, setDialogPage] = useState(1)

  useEffect(() => {
    if (!isOwner) return
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    const tz =
      typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : 'UTC'
    loadTeamPerformance({ from: range.from, to: range.to, tz }, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[team-performance] load failed:', err)
        if (!ctrl.signal.aborted) setError('Failed to load team performance.')
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [isOwner, range.from, range.to])

  const openMemberLeads = useCallback((memberId: string | null, memberName: string) => {
    setDialog({ kind: 'member', memberId, memberName, formId: null, formName: '' })
    setDialogPage(1)
  }, [])

  const openTableLeads = useCallback((formId: string | null, formName: string) => {
    setDialog({ kind: 'table', memberId: null, memberName: '', formId, formName })
    setDialogPage(1)
  }, [])

  if (profileLoading) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Team Performance – Meta Lead Ads</h1>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SkeletonCard key="t1" />
          <SkeletonCard key="t2" />
          <SkeletonCard key="t3" />
          <SkeletonCard key="t4" />
        </div>
      </div>
    )
  }

  if (isDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Team Performance – Meta Lead Ads</h1>
        <EmptyState title="Owner only" hint="Only the account owner can view team performance." />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Team Performance – Meta Lead Ads
            </h1>
            <Badge variant="secondary" className="gap-1 text-blue-700">
              <Crown className="h-3 w-3" aria-hidden />
              Owner only
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Team-wise lead assignment and status performance for <strong>all</strong> Meta Lead Ads
            tables.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <CalendarDays className="h-4 w-4" aria-hidden />
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as TeamDatePreset)}
              aria-label="Select date range"
              className="h-8 rounded-lg border border-input bg-background px-2 py-1 text-sm text-foreground"
            >
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {preset === 'custom' && (
            <span className="flex items-center gap-2 text-[13px]">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="Custom from date"
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="Custom to date"
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
              />
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading || !data ? (
          <>
            <SkeletonCard key="k1" />
            <SkeletonCard key="k2" />
            <SkeletonCard key="k3" />
            <SkeletonCard key="k4" />
          </>
        ) : (
          <>
            <KpiCard title="Total Leads" value={data.summary.total} icon={Users} />
            <KpiCard title="Assigned Leads" value={data.summary.assigned} icon={UserCheck} />
            <KpiCard title="Unassigned Leads" value={data.summary.unassigned} icon={UserX} />
            <KpiCard title="Team Members" value={data.members.length} icon={UsersRound} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MemberBarCard data={data} loading={loading || !data} />
        <StatusDistributionCard data={data} loading={loading || !data} />
      </div>

      <MemberTableCard data={data} loading={loading || !data} onView={openMemberLeads} />

      <TablesSummaryCard
        data={data}
        loading={loading || !data}
        rangeLabel={range.label}
        onView={openTableLeads}
      />

      <LeadsDialog
        dialog={dialog}
        page={dialogPage}
        onPageChange={setDialogPage}
        onClose={() => setDialog(null)}
        rangeFrom={range.from}
        rangeTo={range.to}
      />
    </div>
  )
}

function MemberBarCard({ data, loading }: { data: TeamPerformanceData | null; loading: boolean }) {
  const rows = useMemo(() => {
    if (!data) return []
    const members = [...data.members]
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .map((m) => ({ name: m.name, total: m.total, unassigned: false }))
    if (data.unassigned.total > 0 || members.length === 0) {
      members.push({ name: 'Unassigned', total: data.unassigned.total, unassigned: true })
    }
    return members
  }, [data])
  const hasData = rows.some((r) => r.total > 0)

  if (loading) {
    return (
      <section
        className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        aria-label="Assigned Leads by Team Member"
      >
        <div className="border-b border-border px-5 py-4">
          <div className="h-5 w-56 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="p-5">
          <Skeleton />
        </div>
      </section>
    )
  }

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      aria-label="Assigned Leads by Team Member"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold text-foreground">Assigned Leads by Team Member</h2>
      </div>
      <div className="p-5">
        {!hasData ? (
          <EmptyState
            title="No assigned leads in this period"
            hint="Leads created in the selected range will appear here grouped by their current assignee."
          />
        ) : (
          <div style={{ width: '100%', height: Math.max(180, rows.length * 44) }}>
            <ResponsiveContainer>
              <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 40, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  width={110}
                  tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null
                    const row = payload[0]?.payload as { name: string; total: number } | undefined
                    if (!row) return null
                    return (
                      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                        <p className="font-semibold text-foreground">{row.name}</p>
                        <p className="text-muted-foreground tabular-nums">{row.total} leads</p>
                      </div>
                    )
                  }}
                />
                <Bar dataKey="total" radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 12 }}>
                  {rows.map((r) => (
                    <Cell key={r.name} fill={r.unassigned ? UNASSIGNED_BAR_COLOR : MEMBER_BAR_COLOR} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  )
}

function StatusDistributionCard({
  data,
  loading,
}: {
  data: TeamPerformanceData | null
  loading: boolean
}) {
  const dist = useMemo(() => {
    if (!data) return null
    const total = data.summary.total
    const entries = PINNED_STAGES.map((name) => ({ name, leads: overallStageCount(data, name) }))
    const other = overallOtherCount(data)
    return { total, entries, other }
  }, [data])

  if (loading || !dist) {
    return (
      <section
        className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        aria-label="Lead Status Distribution"
      >
        <div className="border-b border-border px-5 py-4">
          <div className="h-5 w-64 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="p-5">
          <Skeleton />
        </div>
      </section>
    )
  }

  const segments = [...dist.entries.map((e) => ({ ...e, color: STAGE_COLORS[e.name] ?? OTHER_COLOR })), { name: 'Other stages', leads: dist.other, color: OTHER_COLOR }]

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      aria-label="Lead Status Distribution"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold text-foreground">
          Lead Status Distribution <span className="font-normal text-muted-foreground">(All Meta Lead Ads)</span>
        </h2>
      </div>
      <div className="p-5">
        {dist.total === 0 ? (
          <EmptyState
            title="No leads in this period"
            hint="Stage counts will appear here once leads are created in the selected range."
          />
        ) : (
          <>
            <div className="flex h-8 w-full overflow-hidden rounded-md" role="img" aria-label={`Total ${dist.total} leads`}>
              {segments
                .filter((s) => s.leads > 0)
                .map((s) => (
                  <div
                    key={s.name}
                    className="flex h-full items-center justify-center text-xs font-semibold text-white"
                    style={{ width: `${(s.leads / dist.total) * 100}%`, backgroundColor: s.color, minWidth: s.leads > 0 ? 28 : 0 }}
                    title={`${s.name}: ${s.leads}`}
                  >
                    {s.leads}
                  </div>
                ))}
            </div>
            <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {segments.map((s) => (
                <li key={s.name} className="flex items-center gap-2 text-sm">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                  <span className="flex-1 text-foreground">{s.name}</span>
                  <span className="font-semibold tabular-nums text-foreground">{s.leads.toLocaleString()}</span>
                  <span className="w-14 text-right text-muted-foreground tabular-nums">
                    ({dist.total > 0 ? ((s.leads / dist.total) * 100).toFixed(1) : '0.0'}%)
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Total {dist.total.toLocaleString()} leads. Missing stages are counted as No Stage inside
              Other stages.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

function MemberTableCard({
  data,
  loading,
  onView,
}: {
  data: TeamPerformanceData | null
  loading: boolean
  onView: (memberId: string | null, memberName: string) => void
}) {
  if (loading || !data) {
    return (
      <section
        className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        aria-label="Team Member Performance"
      >
        <div className="border-b border-border px-5 py-4">
          <div className="h-5 w-72 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="p-5">
          <Skeleton />
        </div>
      </section>
    )
  }

  const members = [...data.members].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  const totals = {
    assigned: data.summary.total,
    pinned: PINNED_STAGES.map((n) => overallStageCount(data, n)),
    other: overallOtherCount(data),
  }

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      aria-label="Team Member Performance"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold text-foreground">
          Team Member Performance <span className="font-normal text-muted-foreground">(All Meta Lead Ads)</span>
        </h2>
        <p className="flex max-w-md items-start gap-1 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Counts use leads from all Meta Lead Ads tables in the selected period and each lead&apos;s
          current assignee.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-[13px] text-muted-foreground">
              <th className="px-5 py-3 font-medium">Team Member</th>
              <th className="px-3 py-3 text-right font-medium">Assigned Leads</th>
              {PINNED_STAGES.map((s) => (
                <th key={s} className="px-3 py-3 text-right font-medium">
                  {s}
                </th>
              ))}
              <th className="px-3 py-3 text-right font-medium">Other Stages</th>
              <th className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => (
              <tr key={m.userId} className="hover:bg-muted/30">
                <td className="max-w-56 truncate px-5 py-2.5 font-medium text-foreground" title={m.name}>
                  {m.name}
                </td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{m.total.toLocaleString()}</td>
                {PINNED_STAGES.map((s) => (
                  <td key={s} className="px-3 py-2.5 text-right tabular-nums text-foreground">
                    {stageCount(m.stages, s).toLocaleString()}
                  </td>
                ))}
                <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                  {otherStagesCount(m.stages, m.total).toLocaleString()}
                </td>
                <td className="px-5 py-2.5 text-right">
                  <Button variant="link" size="sm" onClick={() => onView(m.userId, m.name)}>
                    View leads <ExternalLink className="h-3 w-3" aria-hidden />
                  </Button>
                </td>
              </tr>
            ))}
            <tr className="hover:bg-muted/30">
              <td className="px-5 py-2.5 font-medium text-foreground">Unassigned</td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                {data.unassigned.total.toLocaleString()}
              </td>
              {PINNED_STAGES.map((s) => (
                <td key={s} className="px-3 py-2.5 text-right tabular-nums text-foreground">
                  {stageCount(data.unassigned.stages, s).toLocaleString()}
                </td>
              ))}
              <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                {otherStagesCount(data.unassigned.stages, data.unassigned.total).toLocaleString()}
              </td>
              <td className="px-5 py-2.5 text-right">
                <Button variant="link" size="sm" onClick={() => onView('unassigned', 'Unassigned')}>
                  View leads <ExternalLink className="h-3 w-3" aria-hidden />
                </Button>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="bg-blue-50 font-semibold text-foreground dark:bg-blue-500/10">
              <td className="px-5 py-2.5">Total</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{totals.assigned.toLocaleString()}</td>
              {totals.pinned.map((n, i) => (
                <td key={PINNED_STAGES[i]} className="px-3 py-2.5 text-right tabular-nums">
                  {n.toLocaleString()}
                </td>
              ))}
              <td className="px-3 py-2.5 text-right tabular-nums">{totals.other.toLocaleString()}</td>
              <td className="px-5 py-2.5" />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        Reassigned leads count under their current owner. Missing stages are counted inside Other
        Stages and shown as No Stage in lead details.
      </p>
    </section>
  )
}

function TablesSummaryCard({
  data,
  loading,
  rangeLabel,
  onView,
}: {
  data: TeamPerformanceData | null
  loading: boolean
  rangeLabel: string
  onView: (formId: string | null, formName: string) => void
}) {
  if (loading || !data) {
    return (
      <section
        className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        aria-label="Meta Lead Ads Table-wise Summary"
      >
        <div className="border-b border-border px-5 py-4">
          <div className="h-5 w-80 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="p-5">
          <Skeleton />
        </div>
      </section>
    )
  }

  const tables = [...data.tables].sort((a, b) => b.total - a.total || a.formName.localeCompare(b.formName))
  const pinnedTotals = PINNED_STAGES.map((n) =>
    tables.reduce((acc, t) => acc + stageCount(t.stages, n), 0),
  )
  const otherTotal = Math.max(
    0,
    data.summary.total - pinnedTotals.reduce((a, b) => a + b, 0),
  )

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      aria-label="Meta Lead Ads Table-wise Summary"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold text-foreground">
          Meta Lead Ads Table-wise Summary{' '}
          <span className="font-normal text-muted-foreground">({rangeLabel})</span>
        </h2>
      </div>
      <div className="overflow-x-auto">
        {tables.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No Meta Lead Ads tables with leads in this period"
              hint="New Instant Form submissions will appear here automatically."
            />
          </div>
        ) : (
          <table className="w-full min-w-[1020px] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-[13px] text-muted-foreground">
                <th className="px-5 py-3 font-medium">Meta Lead Ads Table</th>
                <th className="px-3 py-3 text-right font-medium">Total Leads</th>
                <th className="px-3 py-3 text-right font-medium">Assigned</th>
                <th className="px-3 py-3 text-right font-medium">Unassigned</th>
                {PINNED_STAGES.map((s) => (
                  <th key={s} className="px-3 py-3 text-right font-medium">
                    {s}
                  </th>
                ))}
                <th className="px-3 py-3 text-right font-medium">Other Stages</th>
                <th className="px-5 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tables.map((t) => (
                <tr key={t.formId ?? t.formName} className="hover:bg-muted/30">
                  <td className="max-w-64 truncate px-5 py-2.5 font-medium text-foreground" title={t.formName}>
                    {t.formName}
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                    {t.total.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{t.assigned.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{t.unassigned.toLocaleString()}</td>
                  {PINNED_STAGES.map((s) => (
                    <td key={s} className="px-3 py-2.5 text-right tabular-nums text-foreground">
                      {stageCount(t.stages, s).toLocaleString()}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                    {otherStagesCount(t.stages, t.total).toLocaleString()}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <Button variant="link" size="sm" onClick={() => onView(t.formId, t.formName)}>
                      View <ExternalLink className="h-3 w-3" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-blue-50 font-semibold text-foreground dark:bg-blue-500/10">
                <td className="px-5 py-2.5">Total</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{data.summary.total.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{data.summary.assigned.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {data.summary.unassigned.toLocaleString()}
                </td>
                {pinnedTotals.map((n, i) => (
                  <td key={PINNED_STAGES[i]} className="px-3 py-2.5 text-right tabular-nums">
                    {n.toLocaleString()}
                  </td>
                ))}
                <td className="px-3 py-2.5 text-right tabular-nums">{otherTotal.toLocaleString()}</td>
                <td className="px-5 py-2.5" />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </section>
  )
}

function LeadsDialog({
  dialog,
  page,
  onPageChange,
  onClose,
  rangeFrom,
  rangeTo,
}: {
  dialog: LeadsDialogState | null
  page: number
  onPageChange: (page: number) => void
  onClose: () => void
  rangeFrom: string | null
  rangeTo: string | null
}) {
  const [rows, setRows] = useState<TeamPerformanceData['leads']['rows']>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')

  useEffect(() => {
    if (!dialog) {
      setRows([])
      setTotal(0)
      setSearch('')
      setAppliedSearch('')
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    const tz =
      typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : 'UTC'
    loadTeamPerformance(
      {
        from: rangeFrom,
        to: rangeTo,
        tz,
        member: dialog.kind === 'member' ? dialog.memberId : null,
        formId: dialog.kind === 'table' ? dialog.formId : null,
        search: appliedSearch || null,
        page,
        pageSize: 25,
      },
      ctrl.signal,
    )
      .then((d) => {
        if (!ctrl.signal.aborted) {
          setRows(d.leads.rows)
          setTotal(d.leads.total)
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[team-performance] leads failed:', err)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [dialog, page, appliedSearch, rangeFrom, rangeTo])

  const title = dialog
    ? dialog.kind === 'member'
      ? `Leads — ${dialog.memberName}`
      : `Leads — ${dialog.formName}`
    : 'Leads'

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-popover sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Leads created in the selected period, grouped by current assignee and current Stage.
            {dialog?.kind === 'member' ? ' Member scope.' : ' Table scope.'} Total {total.toLocaleString()}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onPageChange(1)
            setAppliedSearch(search.trim())
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or phone…"
            aria-label="Search leads by name or phone"
            className="h-8 flex-1 rounded-lg border border-input bg-background px-2 text-sm"
          />
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
        </form>
        {loading ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <EmptyState title="No leads found" hint="Try a different date range or search." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Contact</th>
                  <th className="py-2 pr-3 font-medium">Phone</th>
                  <th className="py-2 pr-3 font-medium">Table</th>
                  <th className="py-2 pr-3 font-medium">Stage</th>
                  <th className="py-2 pr-3 text-right font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.lead_id}>
                    <td className="py-2 pr-3 font-medium text-foreground">{r.contact_name ?? '—'}</td>
                    <td className="py-2 pr-3 tabular-nums text-foreground">{r.contact_phone ?? '—'}</td>
                    <td className="max-w-48 truncate py-2 pr-3 text-muted-foreground" title={r.form_name}>
                      {r.form_name}
                    </td>
                    <td className="py-2 pr-3 text-foreground">{stageLabel(r.stage)}</td>
                    <td className="py-2 pr-3 text-right text-muted-foreground">{formatLeadDate(r.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-2">
          <p className="text-xs text-muted-foreground tabular-nums">
            Page {page} · {total.toLocaleString()} total
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => onPageChange(Math.max(1, page - 1))}
            >
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={loading || rows.length < 25} onClick={() => onPageChange(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
