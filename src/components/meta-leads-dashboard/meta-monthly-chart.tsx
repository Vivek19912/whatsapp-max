"use client"

import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { MONTH_SHORT } from '@/lib/dashboard/date-utils'
import { assignFormColors } from '@/lib/meta-leads-dashboard/form-colors'
import type { MetaLeadMonth } from '@/lib/meta-leads-dashboard/types'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'

interface MetaMonthlyChartProps {
  data: MetaLeadMonth[] | null
  year: number
  years: number[]
  onYearChange: (year: number) => void
  loading: boolean
}

const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/**
 * Month-wise Meta leads for one calendar year: one stacked bar per
 * month (distinct submissions, zero months included), segments
 * split by Instant Form. Totals come straight from the RPC.
 */
export function MetaMonthlyChart({ data, year, years, onYearChange, loading }: MetaMonthlyChartProps) {
  const months = useMemo(() => data ?? [], [data])
  const hasData = months.some((m) => m.total > 0)

  const formNames = useMemo(() => {
    const names = new Set<string>()
    for (const m of months) for (const f of m.forms) names.add(f.formName)
    return [...names].sort()
  }, [months])
  const colors = useMemo(() => assignFormColors(formNames), [formNames])

  const stackData = useMemo(
    () =>
      months.map((m) => {
        const row: Record<string, string | number> = {
          month: m.month,
          label: MONTH_SHORT[(m.month ?? 1) - 1] ?? '',
          total: m.total,
        }
        for (const f of m.forms) row[f.formName] = f.leads
        return row
      }),
    [months],
  )

  if (loading) {
    return (
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Month Wise Meta Leads">
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
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Month Wise Meta Leads">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Month Wise Meta Leads</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Instant Form submissions per month, including months with zero leads
          </p>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Year
          <select
            value={year}
            onChange={(e) => onYearChange(Number(e.target.value))}
            aria-label="Select year"
            className="h-8 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="p-5">
        {!hasData ? (
          <EmptyState
            title={`No Meta leads in ${year} yet`}
            hint="New Instant Form submissions will appear here automatically."
          />
        ) : (
          <>
            <div style={{ width: '100%', height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={stackData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0) return null
                      const row = payload[0]?.payload as Record<string, string | number> | undefined
                      const monthIdx = typeof row?.month === 'number' ? row.month : 0
                      const m = months.find((x) => x.month === monthIdx)
                      const total = m?.total ?? 0
                      const forms = (m?.forms ?? []).filter((f) => f.leads > 0)
                      return (
                        <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                          <p className="font-semibold text-foreground">
                            {MONTH_LONG[(monthIdx ?? 1) - 1] ?? ''} {year}
                          </p>
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
