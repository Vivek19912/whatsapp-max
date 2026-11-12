'use client';

import Link from 'next/link';
import {
  HelpCircle,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
} from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import { Button } from '@/components/ui/button';
import type { RecentMissedRow, RecentRecordingRow } from '@/lib/calls/client';
import { formatTalkTime } from '@/lib/calls/formatters';
import { cn } from '@/lib/utils';

export interface RecentCallRow {
  key: string;
  timeMs: number;
  timeLabel: string;
  subLabel: string | null;
  leadName: string;
  workspaceTable: string | null;
  direction: 'in' | 'out' | null;
  callType: string | null;
  durationSecs: number | null;
  salesperson: string | null;
  recordingId: string | null;
  missed: boolean;
}

function asDirection(value: string | null): 'in' | 'out' | null {
  return value === 'in' || value === 'out' ? value : null;
}

function splitDateTime(iso: string | null): {
  time: string;
  date: string | null;
} {
  if (!iso) return { time: '—', date: null };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { time: '—', date: null };
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
  return { time, date };
}

function DirectionCell({
  direction,
  missed,
}: {
  direction: 'in' | 'out' | null;
  missed: boolean;
}) {
  if (missed) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-rose-600 dark:text-rose-400">
        <PhoneMissed className="h-4 w-4" aria-hidden />
        Missed
      </span>
    );
  }
  if (direction === 'in') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-emerald-600 dark:text-emerald-400">
        <PhoneIncoming className="h-4 w-4" aria-hidden />
        Incoming
      </span>
    );
  }
  if (direction === 'out') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-blue-600 dark:text-blue-400">
        <PhoneOutgoing className="h-4 w-4" aria-hidden />
        Outgoing
      </span>
    );
  }
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[13px]">
      <HelpCircle className="h-4 w-4" aria-hidden />
      Unknown
    </span>
  );
}

function callTypeLabel(callType: string | null): string {
  if (callType === 'phone') return 'Phone';
  if (callType === 'whatsapp' || callType === 'whatsapp_business')
    return 'WhatsApp';
  return '—';
}

/**
 * Recent Calls: latest recorded calls merged with recent missed
 * events (missed calls have no audio, so they never appear as
 * recordings). Missed rows show "No recording" instead of a
 * broken player; nothing is fabricated or duplicated — a missed
 * event cannot have a recording row by construction. Playback
 * reuses the signed-URL audio endpoint.
 */
export function RecentCallsTable({
  recent,
  missed,
  loading,
}: {
  recent: RecentRecordingRow[] | null;
  missed: RecentMissedRow[] | null;
  loading: boolean;
}) {
  const [playingId, setPlayingId] = useState<string | null>(null);

  const rows: RecentCallRow[] = (() => {
    if (!recent && !missed) return [];
    const rec = (recent ?? []).map((r) => {
      const when = splitDateTime(r.recordedAt ?? r.createdAt);
      return {
        key: `rec-${r.id}`,
        timeMs: Date.parse(r.recordedAt ?? r.createdAt),
        timeLabel: when.time,
        subLabel: when.date,
        leadName: r.contactName || r.phoneNumber || 'Unknown',
        workspaceTable: r.workspaceTable,
        direction: asDirection(r.direction),
        callType: r.callType,
        durationSecs: r.durationSecs,
        salesperson: r.uploaderName,
        recordingId: r.id,
        missed: false,
      };
    });
    const mis = (missed ?? []).map((m) => {
      const when = splitDateTime(m.occurredAt);
      return {
        key: `missed-${m.id}`,
        timeMs: Date.parse(m.occurredAt),
        timeLabel: when.time,
        subLabel: when.date,
        leadName: m.contactName || m.phoneNumber || 'Unknown',
        workspaceTable: m.workspaceTable,
        direction: 'in' as const,
        callType: 'phone' as const,
        durationSecs: null,
        salesperson: m.ownerName,
        recordingId: null,
        missed: true,
      };
    });
    return [...rec, ...mis]
      .filter((r) => Number.isFinite(r.timeMs))
      .sort((a, b) => b.timeMs - a.timeMs)
      .slice(0, 10);
  })();

  return (
    <section
      aria-label="Recent calls"
      className="border-border bg-card flex flex-col overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="border-border flex items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-foreground text-[15px] font-semibold tracking-tight">
            Recent Calls
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[13px]">
            Latest call activity with lead and recording details
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-blue-600"
          render={<Link href="/recordings" />}
        >
          View All
        </Button>
      </div>
      <div className="overflow-x-auto">
        {loading || recent === null || missed === null ? (
          <div className="flex flex-col gap-2 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No calls yet"
              hint="Calls will appear here once recordings are uploaded or missed calls are logged."
            />
          </div>
        ) : (
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left text-xs">
                <th className="px-5 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Lead Name</th>
                <th className="px-4 py-2.5 font-medium">Workspace Table</th>
                <th className="px-4 py-2.5 font-medium">Call</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 text-right font-medium">Duration</th>
                <th className="px-4 py-2.5 font-medium">Salesperson</th>
                <th className="px-4 py-2.5 font-medium">Recording</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const playing =
                  playingId === r.recordingId && r.recordingId !== null;
                return (
                  <tr
                    key={r.key}
                    className="border-border/50 border-b last:border-b-0"
                  >
                    <td className="px-5 py-2.5 whitespace-nowrap">
                      <p className="text-foreground font-medium">
                        {r.timeLabel}
                      </p>
                      {r.subLabel ? (
                        <p className="text-muted-foreground text-xs">
                          {r.subLabel}
                        </p>
                      ) : null}
                    </td>
                    <td className="text-foreground max-w-[180px] truncate px-4 py-2.5 font-medium">
                      {r.leadName}
                    </td>
                    <td className="text-muted-foreground max-w-[180px] truncate px-4 py-2.5">
                      {r.workspaceTable ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <DirectionCell
                        direction={r.direction}
                        missed={r.missed}
                      />
                    </td>
                    <td className="text-muted-foreground px-4 py-2.5">
                      {callTypeLabel(r.callType)}
                    </td>
                    <td className="text-foreground px-4 py-2.5 text-right whitespace-nowrap tabular-nums">
                      {r.durationSecs === null
                        ? '—'
                        : formatTalkTime(r.durationSecs)}
                    </td>
                    <td className="text-muted-foreground max-w-[160px] truncate px-4 py-2.5">
                      {r.salesperson ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.recordingId ? (
                        <span className="inline-flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={
                              playing ? 'Stop playback' : `Play recording`
                            }
                            onClick={() =>
                              setPlayingId(playing ? null : r.recordingId)
                            }
                            className={cn(
                              'h-8 w-8 rounded-full',
                              playing
                                ? 'bg-blue-600 text-white hover:bg-blue-600'
                                : 'bg-blue-600/10 text-blue-600 hover:bg-blue-600/20 dark:text-blue-400'
                            )}
                          >
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                          <span className="text-muted-foreground tabular-nums">
                            {r.durationSecs === null
                              ? ''
                              : formatTalkTime(r.durationSecs)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          No recording
                        </span>
                      )}
                      {playing && r.recordingId ? (
                        <audio
                          className="mt-1 h-8 w-44"
                          src={`/api/recordings/${r.recordingId}/audio`}
                          controls
                          autoPlay
                          preload="none"
                        />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
