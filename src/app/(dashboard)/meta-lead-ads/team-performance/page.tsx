"use client"

import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  CalendarDays,
  Crown,
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
import { Badge } from '@/components/ui/badge'
import { TeamActivityFeed } from '@/components/dashboard/team-activity-feed'
import { assignFormColors } from '@/lib/meta-leads-dashboard/form-colors'
import {
  loadTeamPerformance,
  resolveTeamDateRange,
  type TeamDatePreset,
  type TeamFormSplit,
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

      <MemberBarCard data={data} loading={loading || !data} />

      <TeamActivityFeed />
    </div>
  )
}

function MemberBarCard({ data, loading }: { data: TeamPerformanceData | null; loading: boolean }) {
  const rows = useMemo(() => {
    if (!data) return []
    const members = [...data.members]
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .map((m) => ({ name: m.name, total: m.total, unassigned: false, forms: m.forms }))
    if (data.unassigned.total > 0 || members.length === 0) {
      members.push({
        name: 'Unassigned',
        total: data.unassigned.total,
        unassigned: true,
        forms: data.unassigned.forms,
      })
    }
    return members
  }, [data])
  const hasData = rows.some((r) => r.total > 0)
  const needsRotation = useMemo(
    () => rows.length > 4 || rows.some((r) => r.name.length > 12),
    [rows],
  )
  // One stable colour per Meta Lead Ads table (same mapping as the
  // Meta Lead Ads dashboard daily/monthly charts, keyed by display
  // name). Every segment of a form shares its colour in all bars.
  const formNames = useMemo(() => {
    const names = new Set<string>()
    for (const r of rows) for (const f of r.forms) if (f.leads > 0) names.add(f.formName)
    return [...names].sort()
  }, [rows])
  const colors = useMemo(() => assignFormColors(formNames), [formNames])
  // Recharts rows: one key per form plus the name/total passthrough
  // for the tooltip. Missing segments default to 0 via `?? 0`, so a
  // bar's stacked height always equals its total.
  const stackData = useMemo(
    () =>
      rows.map((r) => {
        const row: {
          name: string
          total: number
          __forms: TeamFormSplit[]
          __total: number
        } & Record<string, string | number | TeamFormSplit[]> = {
          name: r.name,
          total: r.total,
          __forms: [...r.forms].sort((a, b) => b.leads - a.leads),
          __total: r.total,
        }
        for (const f of r.forms) row[f.formName] = f.leads
        return row
      }),
    [rows],
  )

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
          <>
          <div style={{ width: '100%', height: 300 }}>
            <ResponsiveContainer>
              <BarChart data={stackData} margin={{ top: 20, right: 8, bottom: needsRotation ? 56 : 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  interval={0}
                  angle={needsRotation ? -25 : 0}
                  dy={needsRotation ? 12 : 0}
                  height={needsRotation ? 52 : 30}
                  textAnchor={needsRotation ? 'end' : 'middle'}
                  tickFormatter={(v: string) => (needsRotation ? v : v.length > 14 ? `${v.slice(0, 13)}…` : v)}
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null
                    const row = stackData.find((d) => d.name === label)
                    if (!row) return null
                    const forms = row.__forms.filter((f) => f.leads > 0)
                    return (
                      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                        <p className="font-semibold text-foreground">{String(label ?? '')}</p>
                        <p className="mt-0.5 text-muted-foreground tabular-nums">
                          {row.__total} lead{row.__total === 1 ? '' : 's'} total
                        </p>
                        {forms.map((f) => (
                          <p key={f.formName} className="mt-0.5 flex items-center gap-1.5 text-foreground">
                            <span
                              className="inline-block h-2 w-2 rounded-sm"
                              style={{ backgroundColor: colors.get(f.formName) ?? '#2563eb' }}
                            />
                            <span className="max-w-48 truncate">{f.formName}</span>
                            <span className="ml-auto pl-2 tabular-nums">{f.leads}</span>
                          </p>
                        ))}
                      </div>
                    )
                  }}
                />
                {formNames.map((name, i) => (
                  <Bar
                    key={name}
                    dataKey={name}
                    stackId="leads"
                    fill={colors.get(name) ?? '#2563eb'}
                    radius={i === formNames.length - 1 ? [4, 4, 0, 0] : 0}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          {formNames.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1" aria-label="Forms legend">
              {formNames.map((name) => (
                <span key={name} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: colors.get(name) ?? '#2563eb' }}
                  />
                  <span className="max-w-56 truncate">{name}</span>
                </span>
              ))}
            </div>
          )}
          </>
        )}
      </div>
    </section>
  )
}
