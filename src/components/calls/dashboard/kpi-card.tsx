'use client';

import { cn } from '@/lib/utils';

/**
 * KPI card: label + value only. No sparklines, deltas, percentages,
 * or secondary text — the dashboards show plain totals; trends live
 * in the charts below.
 */
export function KpiCard({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border-border bg-card rounded-xl border p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
        className
      )}
    >
      <p className="text-muted-foreground truncate text-[13px] font-medium">
        {label}
      </p>
      <p className="text-foreground mt-1 text-[26px] leading-8 font-bold tracking-tight tabular-nums">
        {value}
      </p>
    </div>
  );
}
