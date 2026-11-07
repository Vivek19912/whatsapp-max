"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getDashboardRange,
  type DashboardDateFilter,
} from '@/lib/dashboard/date-utils'
import { loadMetaLeadsAnalytics } from '@/lib/meta-leads-dashboard/analytics-client'
import type { MetaLeadDay, MetaLeadMonth } from '@/lib/meta-leads-dashboard/types'
import { KpiCard } from '@/components/dashboard/kpi-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { MetaDailyChart } from '@/components/meta-leads-dashboard/meta-daily-chart'
import { MetaMonthlyChart } from '@/components/meta-leads-dashboard/meta-monthly-chart'

/**
 * Standalone Meta Lead Ads dashboard (acquisition analytics only).
 *
 * Counts DISTINCT Instant Form submissions from meta_lead_submissions
 * — never messages, contacts, conversations, or flow runs. Shares
 * the WhatsApp dashboard's timezone/date conventions (browser-local
 * day bounds, caller-timezone bucketing) and card styling, but reads
 * a dedicated RPC (`get_meta_leads_analytics`) so the existing
 * WhatsApp metrics are byte-for-byte untouched.
 */
export default function MetaLeadsDashboardPage() {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const years = useMemo(() => {
    const out: number[] = []
    for (let y = currentYear - 3; y <= currentYear; y++) out.push(y)
    return out
  }, [currentYear])

  // KPIs always cover Today / Yesterday in the browser-local timezone
  // (same getDashboardRange convention as the WhatsApp dashboard).
  const range = useMemo(
    () => getDashboardRange('today' satisfies DashboardDateFilter, new Date()),
    // Recompute once per mount; the page refetches on manual reload
    // like the main dashboard (no live subscription).
    [],
  )
  const requestKey = useMemo(
    () =>
      `${range.start.toISOString()}|${range.end.toISOString()}|${range.prevStart.toISOString()}|${range.prevEnd.toISOString()}|${year}`,
    [range, year],
  )

  const [todayLeads, setTodayLeads] = useState(0)
  const [yesterdayLeads, setYesterdayLeads] = useState(0)
  const [last7Leads, setLast7Leads] = useState(0)
  const [last30Leads, setLast30Leads] = useState(0)
  const [daily, setDaily] = useState<MetaLeadDay[] | null>(null)
  const [monthly, setMonthly] = useState<MetaLeadMonth[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    const tz =
      typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : 'UTC'
    loadMetaLeadsAnalytics(
      {
        startISO: range.start.toISOString(),
        endISO: range.end.toISOString(),
        prevStartISO: range.prevStart.toISOString(),
        prevEndISO: range.prevEnd.toISOString(),
        year,
        tz,
      },
      ctrl.signal,
    )
      .then((d) => {
        setTodayLeads(d.todayLeads)
        setYesterdayLeads(d.yesterdayLeads)
        setLast7Leads(d.last7Leads)
        setLast30Leads(d.last30Leads)
        setDaily(d.daily)
        setMonthly(d.monthly)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[meta-leads dashboard] analytics failed:', err)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => {
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  const handleYearChange = useCallback((y: number) => {
    setYear(y)
  }, [])

  const kpiLoading = loading

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpiLoading ? (
          <>
            <SkeletonCard key="kpi-today" />
            <SkeletonCard key="kpi-yesterday" />
            <SkeletonCard key="kpi-last7" />
            <SkeletonCard key="kpi-last30" />
          </>
        ) : (
          <>
            <KpiCard title="Today's Leads" value={todayLeads} prevLabel="yesterday" />
            <KpiCard title="Yesterday's Leads" value={yesterdayLeads} prevLabel="day before" />
            <KpiCard title="Last 7 Days" value={last7Leads} prevLabel="last 7 days" />
            <KpiCard title="Last 30 Days" value={last30Leads} prevLabel="last 30 days" />
          </>
        )}
      </div>

      <MetaDailyChart data={daily} loading={loading || daily == null} />

      <MetaMonthlyChart
        data={monthly}
        year={year}
        years={years}
        onYearChange={handleYearChange}
        loading={loading || monthly == null}
      />
    </div>
  )
}
