"use client"

import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

interface KpiCardProps {
  title: string
  value: number
  /** Leading icon. Omit to render a text-only card (no icon space). */
  icon?: ComponentType<{ className?: string }>
  /** Previous equivalent-period value. Omit when not reliably known. */
  previous?: number
  prevLabel?: string
  loading?: boolean
}

export function KpiCard({ title, value, icon: Icon, previous, prevLabel = 'previous period', loading }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{title}</p>
        {Icon ? (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
            <Icon className="h-[18px] w-[18px]" />
          </div>
        ) : null}
      </div>
      {loading ? (
        <div className="mt-3 h-8 w-20 animate-pulse rounded-md bg-muted" />
      ) : (
        <p className="mt-2 text-[30px] leading-none font-bold tracking-tight tabular-nums text-foreground">
          {value.toLocaleString()}
        </p>
      )}
      {!loading && <Comparison current={value} previous={previous} prevLabel={prevLabel} />}
    </div>
  )
}

function Comparison({
  current,
  previous,
  prevLabel,
}: {
  current: number
  previous?: number
  prevLabel: string
}) {
  // Per spec: never fabricate. Without a reliable previous value,
  // render nothing rather than a placeholder comparison.
  if (previous == null) return null
  const delta = current - previous
  if (previous === 0) {
    if (current === 0) return null
    return (
      <p className="mt-2 text-[13px] text-muted-foreground tabular-nums">
        <span className="font-semibold text-blue-600">+{current.toLocaleString()}</span> vs {prevLabel}
      </p>
    )
  }
  const pct = (delta / previous) * 100
  const tone = delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : delta < 0 ? 'text-rose-500' : 'text-muted-foreground'
  const Arrow = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus
  const pctLabel = `${delta === 0 ? '0' : `${delta > 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(pct >= 100 || pct <= -100 ? 0 : 1)}%`}`
  return (
    <div className={cn('mt-2 flex items-center gap-1 text-[13px] tabular-nums', tone)} title={`${delta >= 0 ? '+' : ''}${delta.toLocaleString()} vs ${prevLabel}`}>
      <Arrow className="h-3.5 w-3.5" aria-hidden />
      <span className="font-medium">{pctLabel}</span>
      <span className="font-normal text-muted-foreground">vs {prevLabel}</span>
    </div>
  )
}
