'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import { WEEKDAY_LABELS } from '@/lib/calls/aggregate';

const HOUR_BAR_COLOR = '#8b5cf6';

function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

/**
 * Calls by Hour of Day: 24 in-viewer-timezone buckets. Counts only;
 * durations live in the trend chart.
 */
export function HourlyChart({
  data,
  loading,
}: {
  data: number[] | null;
  loading: boolean;
}) {
  const rows = (data ?? []).map((count, hour) => ({
    hour: hourLabel(hour),
    count,
  }));
  const hasData = rows.some((r) => r.count > 0);

  return (
    <section
      aria-label="Calls by hour of day"
      className="border-border bg-card flex h-full flex-col overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-foreground text-[15px] font-semibold tracking-tight">
          Calls by Hour of Day
        </h2>
        <p className="text-muted-foreground mt-0.5 text-[13px]">
          When calls happen (your local time)
        </p>
      </div>
      <div className="flex flex-1 flex-col p-5">
        {loading || !data ? (
          <Skeleton className="h-[220px] w-full" />
        ) : !hasData ? (
          <EmptyState
            title="No hourly activity"
            hint="Calls will appear here once recorded."
          />
        ) : (
          <div className="h-[220px] w-full flex-1">
            <ResponsiveContainer>
              <BarChart
                data={rows}
                margin={{ top: 8, right: 4, bottom: 0, left: -18 }}
              >
                <CartesianGrid stroke="#eef2f7" vertical={false} />
                <XAxis
                  dataKey="hour"
                  tick={{ fontSize: 10, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e9f0' }}
                  interval={2}
                />
                <YAxis
                  width={40}
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0]?.payload as
                      { hour?: string; count?: number } | undefined;
                    return (
                      <div className="border-border bg-popover rounded-lg border px-3 py-2 text-[13px] shadow-md">
                        <span className="text-foreground font-semibold">
                          {row?.hour ?? ''}
                        </span>{' '}
                        <span className="text-muted-foreground tabular-nums">
                          {row?.count ?? 0} calls
                        </span>
                      </div>
                    );
                  }}
                />
                <Bar
                  dataKey="count"
                  fill={HOUR_BAR_COLOR}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={18}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Calls by Day of Week: Monday-first weekday distribution in the
 * viewer's timezone. Counts only.
 */
export function WeekdayChart({
  data,
  loading,
}: {
  data: number[] | null;
  loading: boolean;
}) {
  const rows = WEEKDAY_LABELS.map((day, i) => ({ day, count: data?.[i] ?? 0 }));
  const hasData = rows.some((r) => r.count > 0);

  return (
    <section
      aria-label="Calls by day of week"
      className="border-border bg-card flex h-full flex-col overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-foreground text-[15px] font-semibold tracking-tight">
          Calls by Day of Week
        </h2>
        <p className="text-muted-foreground mt-0.5 text-[13px]">
          Call volume distribution
        </p>
      </div>
      <div className="flex flex-1 flex-col p-5">
        {loading || !data ? (
          <Skeleton className="h-[220px] w-full" />
        ) : !hasData ? (
          <EmptyState
            title="No weekday activity"
            hint="Calls will appear here once recorded."
          />
        ) : (
          <div className="h-[220px] w-full flex-1">
            <ResponsiveContainer>
              <BarChart
                data={rows}
                margin={{ top: 8, right: 4, bottom: 0, left: -18 }}
              >
                <CartesianGrid stroke="#eef2f7" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e9f0' }}
                />
                <YAxis
                  width={40}
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0]?.payload as
                      { day?: string; count?: number } | undefined;
                    return (
                      <div className="border-border bg-popover rounded-lg border px-3 py-2 text-[13px] shadow-md">
                        <span className="text-foreground font-semibold">
                          {row?.day ?? ''}
                        </span>{' '}
                        <span className="text-muted-foreground tabular-nums">
                          {row?.count ?? 0} calls
                        </span>
                      </div>
                    );
                  }}
                />
                <Bar
                  dataKey="count"
                  fill={HOUR_BAR_COLOR}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}
