"use client"

import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { MONTH_SHORT } from '@/lib/dashboard/date-utils'
import { assignFormColors } from '@/lib/meta-leads-dashboard/form-colors'
import type { MetaLeadDay } from '@/lib/meta-leads-dashboard/types'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'

interface MetaDailyChartProps {
  data: MetaLeadDay[] | null
  loading: boolean
}

function shortLabel(date: string): string {
  const parts = date.split('-')
  if (parts.length !== 3) return ''
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12) return ''
  return `${d} ${MONTH_SHORT[m - 1] ?? ''}`
}

function longLabel(date: string): string {
  const parts = date.split('-')
  if (parts.length !== 3) return date || 'Unknown date'
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return date
  return `${d} ${MONTH_SHORT[m - 1] ?? ''} ${y}`
}

/**
 * Daily Meta leads, trailing 30 days: one stacked bar per calendar
 * day (distinct submissions, zero days included), segments split by
 * Instant Form. Totals come straight from the RPC — never
 * recomputed here — so the number above a bar cannot drift from
 * its segments.
 */
export function MetaDailyChart({ data, loading }: MetaDailyChartProps) {
  const days = useMemo(() => data ?? [], [data])
  const hasData = days.some((d) => d.total > 0)

  const formNames = useMemo(() => {
    const names = new Set<string>()
    for (const d of days) for (const f of d.forms) names.add(f.formName)
    return [...names].sort()
  }, [days])
  const colors = useMemo(() => assignFormColors(formNames), [formNames])

  // Recharts rows: one key per form plus the date/total passthrough
  // for the tooltip. Missing segments default to 0 via `?? 0` at
  // render through `stackData`.
  const stackData = useMemo(
    () =>
      days.map((d) => {
        const row: Record<string, string | number> = { date: d.date, total: d.total }
        for (const f of d.forms) row[f.formName] = f.leads
        return row
      }),
    [days],
  )

  if (loading) {
    return (
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Meta Leads Last 30 Days">
        <div className="border-b border-border px-5 py-4">
          <div className="h-5 w-48 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="p-5">
          <Skeleton />
        </div>
      </section>
    )
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Meta Leads Last 30 Days">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold text-foreground">Leads — Last 30 Days</h2>
      </div>
      <div className="p-5">
        {!hasData ? (
          <EmptyState
            title="No Meta leads in the last 30 days"
            hint="New Instant Form submissions will appear here automatically."
          />
        ) : (
          <>
            <div style={{ width: '100%', height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={stackData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortLabel}
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0) return null
                      const day = days.find((d) => d.date === label)
                      const total = day?.total ?? 0
                      const forms = (day?.forms ?? []).filter((f) => f.leads > 0)
                      return (
                        <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                          <p className="font-semibold text-foreground">{longLabel(String(label ?? ''))}</p>
                          <p className="mt-0.5 text-muted-foreground">
                            {total} lead{total === 1 ? '' : 's'} total
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
                    <Bar key={name} dataKey={name} stackId="leads" fill={colors.get(name) ?? '#2563eb'} radius={i === formNames.length - 1 ? [3, 3, 0, 0] : 0}>
                      {stackData.map((row, idx) => (
                        <Cell key={`${name}-${idx}`} fill={colors.get(name) ?? '#2563eb'} fillOpacity={(row[name] as number ?? 0) > 0 ? 1 : 0.15} />
                      ))}
                    </Bar>
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
