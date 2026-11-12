'use client';

import { useState } from 'react';
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
import type { TrendBucket } from '@/lib/calls/aggregate';
import { formatTalkTime } from '@/lib/calls/formatters';
import { cn } from '@/lib/utils';

export const TREND_INBOUND_COLOR = '#22c55e';
export const TREND_OUTBOUND_COLOR = '#2563eb';
export const TREND_UNKNOWN_COLOR = '#94a3b8';
export const TREND_DURATION_COLOR = '#8b5cf6';
export const TREND_MISSED_COLOR = '#f43f5e';
export const TREND_ANSWERED_COLOR = '#22c55e';

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-muted-foreground text-[13px]">{label}</span>
    </span>
  );
}

function ChartTipRow({
  color,
  name,
  value,
}: {
  color: string;
  name: string;
  value: string;
}) {
  return (
    <p className="flex items-center gap-2 text-[13px]">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-muted-foreground">{name}</span>
      <span className="text-foreground ml-auto pl-4 font-semibold tabular-nums">
        {value}
      </span>
    </p>
  );
}

/**
 * Calls Over Time: stacked inbound/outbound(/unknown) bars per
 * period, or total talk time in Duration mode. Buckets are
 * zero-filled server-side, so gaps are real zeros — never
 * fabricated. Granularity (day/week/month) is chosen by span.
 */
export function TrendChart({
  buckets,
  loading,
}: {
  buckets: TrendBucket[] | null;
  loading: boolean;
}) {
  const [mode, setMode] = useState<'calls' | 'duration'>('calls');

  const hasData =
    !!buckets && buckets.some((b) => b.inbound + b.outbound + b.unknown > 0);
  const showUnknown = !!buckets && buckets.some((b) => b.unknown > 0);
  const totals = (buckets ?? []).reduce(
    (acc, b) => ({
      calls: acc.calls + b.inbound + b.outbound + b.unknown,
      duration: acc.duration + b.durationSecs,
      inbound: acc.inbound + b.inbound,
      outbound: acc.outbound + b.outbound,
      unknown: acc.unknown + b.unknown,
    }),
    { calls: 0, duration: 0, inbound: 0, outbound: 0, unknown: 0 }
  );

  return (
    <section
      aria-label="Calls over time"
      className="border-border bg-card flex h-full flex-col overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="border-border flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-foreground text-[15px] font-semibold tracking-tight">
            Calls Over Time
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[13px]">
            Call volume and duration trend
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Chart metric"
          className="border-border bg-muted/60 flex rounded-full border p-0.5 text-[13px]"
        >
          {(['calls', 'duration'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-full px-3.5 py-1 font-medium transition-colors',
                mode === m
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {m === 'calls' ? 'Calls' : 'Duration'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5">
        {loading || !buckets ? (
          <Skeleton className="h-[280px] w-full" />
        ) : !hasData ? (
          <EmptyState
            title="No calls in this period"
            hint="Try a wider date range or different filters."
          />
        ) : (
          <>
            <div className="h-[280px] w-full flex-1">
              <ResponsiveContainer>
                <BarChart
                  data={buckets}
                  margin={{ top: 12, right: 8, bottom: 0, left: -8 }}
                  barCategoryGap="28%"
                >
                  <CartesianGrid stroke="#eef2f7" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e5e9f0' }}
                    minTickGap={24}
                  />
                  <YAxis
                    width={48}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    tickFormatter={(v: number) =>
                      mode === 'duration' ? formatTalkTime(v) : String(v)
                    }
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0]?.payload as
                        TrendBucket | undefined;
                      return (
                        <div className="border-border bg-popover min-w-[200px] rounded-lg border px-3 py-2 shadow-md">
                          <p className="text-foreground mb-1 text-[13px] font-semibold">
                            {row?.label ?? ''}
                          </p>
                          {mode === 'calls' ? (
                            <>
                              <ChartTipRow
                                color={TREND_OUTBOUND_COLOR}
                                name="Outbound"
                                value={String(row?.outbound ?? 0)}
                              />
                              <ChartTipRow
                                color={TREND_INBOUND_COLOR}
                                name="Inbound"
                                value={String(row?.inbound ?? 0)}
                              />
                              {showUnknown ? (
                                <ChartTipRow
                                  color={TREND_UNKNOWN_COLOR}
                                  name="Unknown"
                                  value={String(row?.unknown ?? 0)}
                                />
                              ) : null}
                            </>
                          ) : (
                            <ChartTipRow
                              color={TREND_DURATION_COLOR}
                              name="Talk time"
                              value={formatTalkTime(row?.durationSecs ?? 0)}
                            />
                          )}
                        </div>
                      );
                    }}
                  />
                  {mode === 'calls' ? (
                    <>
                      <Bar
                        dataKey="outbound"
                        stackId="calls"
                        fill={TREND_OUTBOUND_COLOR}
                        radius={[0, 0, 0, 0]}
                      />
                      <Bar
                        dataKey="inbound"
                        stackId="calls"
                        fill={TREND_INBOUND_COLOR}
                        radius={[4, 4, 0, 0]}
                      />
                      {showUnknown ? (
                        <Bar
                          dataKey="unknown"
                          stackId="calls"
                          fill={TREND_UNKNOWN_COLOR}
                          radius={[4, 4, 0, 0]}
                        />
                      ) : null}
                    </>
                  ) : (
                    <Bar
                      dataKey="durationSecs"
                      fill={TREND_DURATION_COLOR}
                      radius={[4, 4, 0, 0]}
                      name="Talk time"
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="border-border text-muted-foreground mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-[13px]">
              {mode === 'calls' ? (
                <>
                  <LegendDot
                    color={TREND_OUTBOUND_COLOR}
                    label={`Outbound (${totals.outbound})`}
                  />
                  <LegendDot
                    color={TREND_INBOUND_COLOR}
                    label={`Inbound (${totals.inbound})`}
                  />
                  {showUnknown ? (
                    <LegendDot
                      color={TREND_UNKNOWN_COLOR}
                      label={`Unknown (${totals.unknown})`}
                    />
                  ) : null}
                </>
              ) : (
                <LegendDot
                  color={TREND_DURATION_COLOR}
                  label={`Duration (${formatTalkTime(totals.duration)})`}
                />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
