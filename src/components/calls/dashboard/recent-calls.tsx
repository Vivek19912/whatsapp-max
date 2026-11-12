'use client';

import Link from 'next/link';
import {
  HelpCircle,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
} from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WorkspaceLeadLink } from '@/components/workspace/workspace-lead-link';
import { RecordingPlayerPopover } from '@/components/recordings/recording-player-popover';
import type { RecentMissedRow, RecentRecordingRow } from '@/lib/calls/client';
import { formatTalkTime } from '@/lib/calls/formatters';

export interface RecentCallRow {
  key: string;
  timeMs: number;
  timeLabel: string;
  subLabel: string | null;
  leadName: string;
  /** Stable contacts.id — null means the row must not link anywhere. */
  contactId: string | null;
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
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-600 dark:text-emerald-400">
        <PhoneIncoming className="h-4 w-4" aria-hidden />
        Incoming
      </span>
    );
  }
  if (direction === 'out') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-blue-600 dark:text-blue-400">
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
  // Single floating player: at most one popover open at a time.
  // `autoplay` is set only by Play/cell clicks; both reset on
  // close so a reopened player never inherits stale intent.
  // Unmounting the previous keyed RecordingPlayer pauses its
  // audio — recordings never play simultaneously.
  const [openId, setOpenId] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(false);

  const closePlayer = () => {
    setOpenId(null);
    setAutoplay(false);
  };

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
        contactId: r.contactId,
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
        contactId: m.contactId,
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
          // Same shadcn primitives and Workspace-style header as the
          // Recordings table: tinted fill, tall bold headers with
          // dividers, bordered body cells, row hover.
          <Table>
            <TableHeader className="[&_tr]:border-b-0 [&_th]:bg-[#f1f5f9] dark:[&_th]:bg-muted">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-16 px-5 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Time</TableHead>
                <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Lead Name</TableHead>
                <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Workspace Table</TableHead>
                <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Call</TableHead>
                <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Type</TableHead>
                <TableHead className="h-16 px-4 align-middle text-[15px] font-bold text-right border-r border-border border-b last:border-r-0">Duration</TableHead>
                <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Salesperson</TableHead>
                <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Recording</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const playerOpen =
                  openId === r.recordingId && r.recordingId !== null;
                return (
                  <TableRow
                    key={r.key}
                    className="hover:bg-muted/50"
                  >
                    <TableCell className="border-r border-border px-5 last:border-r-0 whitespace-nowrap">
                      <p className="text-foreground font-medium">
                        {r.timeLabel}
                      </p>
                      {r.subLabel ? (
                        <p className="text-muted-foreground text-xs">
                          {r.subLabel}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0 max-w-[180px]">
                      {r.contactId ? (
                        // Shared Workspace lead deep link (same
                        // component as the Recordings table).
                        <WorkspaceLeadLink
                          contactId={r.contactId}
                          title={r.leadName}
                        >
                          {r.leadName}
                        </WorkspaceLeadLink>
                      ) : (
                        <span className="truncate text-muted-foreground">
                          {r.leadName}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0 max-w-[180px]">
                      {r.workspaceTable ? (
                        <span
                          title={r.workspaceTable}
                          className="block truncate text-[13px] text-foreground"
                        >
                          {r.workspaceTable}
                        </span>
                      ) : (
                        <span className="block text-[13px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0 whitespace-nowrap">
                      <DirectionCell
                        direction={r.direction}
                        missed={r.missed}
                      />
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0 text-muted-foreground">
                      {callTypeLabel(r.callType)}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0 text-right whitespace-nowrap tabular-nums text-foreground">
                      {r.durationSecs === null
                        ? '—'
                        : formatTalkTime(r.durationSecs)}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0 max-w-[160px]">
                      {r.salesperson ? (
                        <span
                          title={r.salesperson}
                          className="block truncate text-muted-foreground"
                        >
                          {r.salesperson}
                        </span>
                      ) : (
                        <span className="block text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 last:border-r-0">
                      {r.recordingId ? (
                        <RecordingPlayerPopover
                          recordingId={r.recordingId}
                          open={playerOpen}
                          autoplay={autoplay}
                          onOpenChange={(next) => {
                            if (next) {
                              setOpenId(r.recordingId);
                            } else if (openId === r.recordingId) {
                              closePlayer();
                            }
                          }}
                          onPlayIntent={() => setAutoplay(true)}
                          onClose={closePlayer}
                          playLabel={`Play recording of ${r.leadName}`}
                          durationText={
                            r.durationSecs === null
                              ? ''
                              : formatTalkTime(r.durationSecs)
                          }
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          No recording
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
