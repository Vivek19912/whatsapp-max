'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import {
  TREND_ANSWERED_COLOR,
  TREND_MISSED_COLOR,
  TREND_UNKNOWN_COLOR,
} from './trend-chart';

function LegendRow({
  color,
  name,
  value,
  total,
}: {
  color: string;
  name: string;
  value: number;
  total: number;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-muted-foreground flex-1">{name}</span>
      <span className="text-foreground font-semibold tabular-nums">
        {value.toLocaleString('en-US')}
      </span>
      <span className="text-muted-foreground w-11 text-right tabular-nums">
        {total > 0 ? Math.round((value / total) * 100) : 0}%
      </span>
    </div>
  );
}

/**
 * Call Outcome: answered vs missed vs unknown, sourced exclusively
 * from logged call events (route: call_event_outcomes_summary). The
 * center total is the sum of the displayed slices — never a mixed
 * recording/event total. Rejected is intentionally absent from this
 * dashboard view; backend support is unchanged.
 */
export function OutcomeDonut({
  answered,
  missed,
  unknown,
  loading,
}: {
  answered: number;
  missed: number;
  unknown: number;
  loading: boolean;
}) {
  const total = answered + missed + unknown;
  const segments = [
    { name: 'Answered', value: answered, color: TREND_ANSWERED_COLOR },
    { name: 'Missed', value: missed, color: TREND_MISSED_COLOR },
    ...(unknown > 0
      ? [{ name: 'Unknown', value: unknown, color: TREND_UNKNOWN_COLOR }]
      : []),
  ];

  return (
    <section
      aria-label="Call outcome"
      className="border-border bg-card flex h-full flex-col overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-foreground text-[15px] font-semibold tracking-tight">
          Call Outcome
        </h2>
        <p className="text-muted-foreground mt-0.5 text-[13px]">
          Based on logged call events
        </p>
      </div>
      <div className="flex flex-1 flex-col justify-center gap-4 p-5">
        {loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : total === 0 ? (
          <EmptyState
            title="No outcomes yet"
            hint="Outcomes appear once calls are logged."
          />
        ) : (
          <>
            <div className="relative mx-auto h-[190px] w-full max-w-[240px]">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={segments}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={62}
                    outerRadius={88}
                    paddingAngle={2}
                    strokeWidth={0}
                  >
                    {segments.map((s) => (
                      <Cell key={s.name} fill={s.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const seg = payload[0];
                      const v = Number(seg.value ?? 0);
                      return (
                        <div className="border-border bg-popover rounded-lg border px-3 py-2 text-[13px] shadow-md">
                          <span className="text-foreground font-semibold">
                            {seg.name}
                          </span>{' '}
                          <span className="text-muted-foreground tabular-nums">
                            {v} ({total > 0 ? Math.round((v / total) * 100) : 0}
                            %)
                          </span>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <p className="text-foreground text-2xl font-bold tabular-nums">
                  {total.toLocaleString('en-US')}
                </p>
                <p className="text-muted-foreground text-xs">Total events</p>
              </div>
            </div>
            <div className="flex flex-col gap-2.5">
              {segments.map((s) => (
                <LegendRow
                  key={s.name}
                  color={s.color}
                  name={s.name}
                  value={s.value}
                  total={total}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
