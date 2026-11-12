'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import { INBOUND_COLOR, OUTBOUND_COLOR, UNKNOWN_COLOR } from './calls-chart';

/**
 * Recording-direction donut. NULL directions are shown as an honest
 * third "Unknown" segment — never folded into inbound/outbound.
 */
export function DirectionDonut({
  inbound,
  outbound,
  unknown,
  loading,
  title = 'Recording Direction',
  subtitle = 'Distribution of recorded calls',
}: {
  inbound: number;
  outbound: number;
  unknown: number;
  loading: boolean;
  title?: string;
  subtitle?: string;
}) {
  const total = inbound + outbound + unknown;
  const segments = [
    { name: 'Inbound', value: inbound, color: INBOUND_COLOR },
    { name: 'Outbound', value: outbound, color: OUTBOUND_COLOR },
    ...(unknown > 0
      ? [{ name: 'Unknown', value: unknown, color: UNKNOWN_COLOR }]
      : []),
  ];

  return (
    <section
      aria-label={title}
      className="border-border bg-card flex flex-col overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-foreground text-[15px] font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-[13px]">{subtitle}</p>
      </div>
      <div className="flex flex-1 flex-col justify-center gap-4 p-5">
        {loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : total === 0 ? (
          <EmptyState
            title="No direction data"
            hint="No recordings in this period."
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
                <p className="text-muted-foreground text-xs">
                  Total Recordings
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2.5">
              {segments.map((s) => (
                <div key={s.name} className="flex items-center gap-2 text-sm">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="text-muted-foreground flex-1">{s.name}</span>
                  <span className="text-foreground font-semibold tabular-nums">
                    {s.value.toLocaleString('en-US')}
                  </span>
                  <span className="text-muted-foreground w-11 text-right tabular-nums">
                    {total > 0 ? Math.round((s.value / total) * 100) : 0}%
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
