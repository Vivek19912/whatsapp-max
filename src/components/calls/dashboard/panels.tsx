'use client';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { TopClientRow } from '@/lib/calls/client';
import { formatCallDateTime, formatTalkTime } from '@/lib/calls/formatters';
import { cn } from '@/lib/utils';

const AVATAR_HUES = [262, 210, 340, 28, 160];

function avatarHue(contactId: string): number {
  let h = 0;
  for (let i = 0; i < contactId.length; i += 1) h = (h * 31 + contactId.charCodeAt(i)) % 360;
  return h;
}

/**
 * Duration histogram as horizontal bars. Percentages are over
 * measured recordings only — NULL durations never enter the base.
 */
export function DurationBars({
  buckets,
  loading,
}: {
  buckets: { under30: number; from30To60: number; min1To5: number; min5To10: number; over10: number } | null;
  loading: boolean;
}) {
  const rows = buckets
    ? [
        { label: '< 30 seconds', count: buckets.under30 },
        { label: '30 - 60 seconds', count: buckets.from30To60 },
        { label: '1 - 5 minutes', count: buckets.min1To5 },
        { label: '5 - 10 minutes', count: buckets.min5To10 },
        { label: '> 10 minutes', count: buckets.over10 },
      ]
    : [];
  const total = rows.reduce((s, r) => s + r.count, 0);

  return (
    <section
      aria-label="Recording duration distribution"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
          Recording Duration Distribution
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Based on recording length</p>
      </div>
      <div className="flex flex-1 flex-col justify-center gap-4 p-5">
        {loading || !buckets ? (
          <Skeleton className="h-[190px] w-full" />
        ) : total === 0 ? (
          <EmptyState title="No duration data" hint="No measured recordings in this period." />
        ) : (
          rows.map((r) => {
            const pct = Math.round((r.count / total) * 100);
            return (
              <div key={r.label} className="grid grid-cols-[110px_1fr_auto_auto] items-center gap-3 text-[13px]">
                <span className="truncate text-muted-foreground">{r.label}</span>
                <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-blue-600"
                    style={{ width: `${pct}%` }}
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${r.label}: ${r.count} recordings`}
                  />
                </div>
                <span className="w-8 text-right font-semibold tabular-nums text-foreground">{r.count}</span>
                <span className="w-9 text-right tabular-nums text-muted-foreground">{pct}%</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/**
 * Top 5 linked contacts by recording count. Linked only — client
 * identity is never guessed from filenames.
 */
export function TopClients({
  clients,
  loading,
}: {
  clients: TopClientRow[] | null;
  loading: boolean;
}) {
  return (
    <section
      aria-label="Top clients by recordings"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
            Top Clients by Recordings
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Clients with most recorded calls</p>
        </div>
      </div>
      <div className="flex-1 p-2">
        {loading || !clients ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : clients.length === 0 ? (
          <div className="p-3">
            <EmptyState title="No linked clients yet" hint="Link recordings to contacts to see them here." />
          </div>
        ) : (
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8">#</TableHead>
                <TableHead>Client</TableHead>
                <TableHead className="text-right">Recordings</TableHead>
                <TableHead className="text-right">Talk Time</TableHead>
                <TableHead className="text-right">Last Recording</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((c, i) => {
                const display = c.name || c.phone || 'Unknown';
                return (
                  <TableRow key={c.contactId}>
                    <TableCell className="tabular-nums text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                          style={{
                            backgroundColor: `hsl(${AVATAR_HUES[i % AVATAR_HUES.length] ?? avatarHue(c.contactId)} 65% 55%)`,
                          }}
                        >
                          {display.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0">
                          <span className={cn('block truncate text-sm font-medium text-foreground')}>
                            {display}
                          </span>
                          {c.name && c.phone ? (
                            <span className="block truncate text-xs text-muted-foreground">{c.phone}</span>
                          ) : null}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {c.recordings.toLocaleString('en-US')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatTalkTime(c.talkTimeSecs)}
                    </TableCell>
                    <TableCell className="text-right text-[13px] text-muted-foreground">
                      {formatCallDateTime(c.lastRecordedAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>
        )}
      </div>
    </section>
  );
}
