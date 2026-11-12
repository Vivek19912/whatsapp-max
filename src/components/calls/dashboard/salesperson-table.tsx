'use client';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import type { SalespersonRow } from '@/lib/calls/client';
import { formatTalkTime } from '@/lib/calls/formatters';
import { cn } from '@/lib/utils';

const AVATAR_BG = [
  'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  'bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

/**
 * Salesperson Performance: per-member recorded calls + duration with
 * answered/missed counts from logged call events. Answer rate =
 * answered / (answered + missed); shown as "—" when there are no
 * events to rate. Zero-activity members (from the roster) render at
 * the bottom so every authorized salesperson is visible.
 */
export function SalespersonTable({
  rows,
  loading,
}: {
  rows: SalespersonRow[] | null;
  loading: boolean;
}) {
  return (
    <section
      aria-label="Salesperson performance"
      className="border-border bg-card flex h-full flex-col overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-foreground text-[15px] font-semibold tracking-tight">
          Salesperson Performance
        </h2>
        <p className="text-muted-foreground mt-0.5 text-[13px]">
          Call activity and team performance
        </p>
      </div>
      <div className="flex-1 overflow-x-auto p-2">
        {loading || !rows ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No salespeople"
            hint="Invite team members to see per-person activity."
          />
        ) : (
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th className="w-8 px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Salesperson</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2 text-right font-medium">Answered</th>
                <th className="px-3 py-2 text-right font-medium">Missed</th>
                <th className="px-3 py-2 text-right font-medium">
                  Answer Rate
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.userId}
                  className="border-border/60 border-t first:border-t-0"
                >
                  <td className="text-muted-foreground px-3 py-2 tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2.5">
                      <span
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                          AVATAR_BG[i % AVATAR_BG.length]
                        )}
                        aria-hidden
                      >
                        {initials(r.name || '?')}
                      </span>
                      <span className="text-foreground truncate font-medium">
                        {r.name || 'Unknown user'}
                      </span>
                    </span>
                  </td>
                  <td className="text-foreground px-3 py-2 text-right tabular-nums">
                    {r.recordings.toLocaleString('en-US')}
                  </td>
                  <td className="text-foreground px-3 py-2 text-right whitespace-nowrap tabular-nums">
                    {formatTalkTime(r.durationSecs)}
                  </td>
                  <td className="text-foreground px-3 py-2 text-right tabular-nums">
                    {r.answered.toLocaleString('en-US')}
                  </td>
                  <td className="text-foreground px-3 py-2 text-right tabular-nums">
                    {r.missed.toLocaleString('en-US')}
                  </td>
                  <td className="px-3 py-2">
                    {r.answerRate === null ? (
                      <span className="text-muted-foreground float-right">
                        —
                      </span>
                    ) : (
                      <span className="flex items-center justify-end gap-2">
                        <span
                          className="bg-muted hidden h-1.5 w-14 overflow-hidden rounded-full sm:block"
                          aria-hidden
                        >
                          <span
                            className="block h-full rounded-full bg-emerald-500"
                            style={{
                              width: `${Math.round(r.answerRate * 100)}%`,
                            }}
                          />
                        </span>
                        <span className="text-foreground tabular-nums">
                          {Math.round(r.answerRate * 100)}%
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
