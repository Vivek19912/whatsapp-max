"use client"

import { useMemo } from 'react'
import type { MetaLeadStageSplit } from '@/lib/meta-leads-dashboard/types'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'

interface MetaStatusOverviewProps {
  data: MetaLeadStageSplit[] | null
  loading: boolean
}

/**
 * Lead Status Overview for the agent dashboard: the agent's
 * assigned leads grouped by their existing Stage values (same
 * definitions as the Workspace/team-performance Stage field).
 * Leads without a Stage render as "No Stage" (display label only).
 * Same card design system as the owner dashboard.
 */
export function MetaStatusOverview({ data, loading }: MetaStatusOverviewProps) {
  const rows = useMemo(() => [...(data ?? [])].sort((a, b) => b.leads - a.leads), [data])
  const total = useMemo(() => rows.reduce((acc, r) => acc + r.leads, 0), [rows])
  const hasData = total > 0

  if (loading) {
    return (
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Lead Status Overview">
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
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Lead Status Overview">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold text-foreground">Lead Status Overview</h2>
      </div>
      <div className="p-5">
        {!hasData ? (
          <EmptyState
            title="No assigned leads yet"
            hint="Leads assigned to you will appear here grouped by status."
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const label = r.stage && r.stage.trim() !== '' ? r.stage : 'No Stage'
              const pct = total > 0 ? (r.leads / total) * 100 : 0
              return (
                <li key={label} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
                  <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-blue-600"
                      style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                    />
                  </span>
                  <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
                    {r.leads.toLocaleString()}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
