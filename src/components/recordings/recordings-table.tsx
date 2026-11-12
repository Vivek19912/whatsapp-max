'use client';

import {
  Link2,
  Minus,
  Pause,
  PhoneMissed,
  Play,
  X,
} from 'lucide-react';
import { useState } from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Skeleton } from '@/components/dashboard/skeleton';
import { PhoneHandsetIcon } from '@/components/icons/call-type-icons';
import { WhatsappIcon } from '@/components/icons/whatsapp-icon';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WorkspacePagination } from '@/components/workspace/workspace-pagination';
import { WorkspaceLeadLink } from '@/components/workspace/workspace-lead-link';
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  type WorkspacePageSize,
} from '@/lib/flows/workspace-pagination';
import { formatRecordedIndiaParts, isMissedCallRow, type CallRecording, type RecordingTableRow } from '@/lib/recordings/recordings';
import { RecordingPlayer } from './recording-player';

export const PAGE_SIZE: WorkspacePageSize = DEFAULT_WORKSPACE_PAGE_SIZE;

function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return '—';
  }
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

export function leadInitial(name: string | null | undefined): string {
  const first = (name ?? '').trim().slice(0, 1).toUpperCase();
  return first || 'U';
}

function CallTypeIcon({ callType }: { callType: string | null | undefined }) {
  if (callType === 'phone') {
    return (
      <TypeTip label="Phone" className="text-blue-700 dark:text-blue-300">
        <PhoneHandsetIcon className="h-3.5 w-3.5 shrink-0" />
      </TypeTip>
    );
  }
  // Merged reporting category: stored `whatsapp` and
  // `whatsapp_business` are ONE user-facing type ("WhatsApp").
  // The mark is the single shared WhatsappIcon (exact
  // user-provided geometry); the stored value stays distinct,
  // only the display is folded.
  if (callType === 'whatsapp' || callType === 'whatsapp_business') {
    return (
      <TypeTip label="WhatsApp" className="text-emerald-700 dark:text-emerald-300">
        <WhatsappIcon className="h-3.5 w-3.5 shrink-0" />
      </TypeTip>
    );
  }
  return (
    <TypeTip label="Unknown" className="text-muted-foreground">
      <Minus className="h-3.5 w-3.5 shrink-0" />
    </TypeTip>
  );
}

/**
 * Icon-only cell content: the icon inherits the semantic text color
 * passed via className; the name lives in the tooltip AND in the
 * trigger's aria-label, so keyboard/screen-reader users get it
 * without hover. No pill, no badge, no visible text.
 */
function TypeTip({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={label}
            className={`inline-flex items-center outline-none ${className ?? ''}`}
          >
            {children}
          </span>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Merged Call cell: the call-type icon (phone / WhatsApp / neutral
 * unknown mark) alongside the direction as plain text — blue for
 * Incoming, green for Outgoing, neutral for Unknown. No pill, no
 * badge, and deliberately NO directional arrows (no up/down
 * icons): the words carry the direction, the icon carries the
 * type. Direction data and classification are untouched — this is
 * display only.
 */
function CallLabel({
  callType,
  direction,
}: {
  callType: string | null | undefined;
  direction: string | null | undefined;
}) {
  const directionClass =
    direction === 'in'
      ? 'text-blue-700 dark:text-blue-300'
      : direction === 'out'
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-muted-foreground';
  const directionText =
    direction === 'in' ? 'Incoming' : direction === 'out' ? 'Outgoing' : 'Unknown';
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap ${directionClass}`}>
      <CallTypeIcon callType={callType} />
      {directionText}
    </span>
  );
}

/**
 * Missed-call cell: red missed icon + "Missed", matching the
 * Calls dashboard's missed-row treatment. Missed events never
 * carry a playable direction/type story — the outcome is the
 * whole message.
 */
function MissedCallLabel() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap text-rose-600 dark:text-rose-400">
      <PhoneMissed className="h-3.5 w-3.5 shrink-0" aria-hidden />
      Missed
    </span>
  );
}

function RecordedCell({ recordedAt, createdAt }: { recordedAt: string | null; createdAt: string }) {
  const parts = formatRecordedIndiaParts(recordedAt, createdAt);
  if (!parts) return <span className="text-[13px] text-muted-foreground">—</span>;
  return (
    <span className="block whitespace-nowrap">
      <span className="block text-[13px] font-medium tabular-nums text-foreground">{parts.time}</span>
      <span className="block text-xs tabular-nums text-muted-foreground">{parts.date}</span>
    </span>
  );
}

/**
 * Recordings table: No. | Time | Lead Name | Workspace Table |
 * Call | Salesperson | Recording. Display-only row numbers
 * continue across pages. No filename, no size, no storage
 * internals. (Duration lives only in the Recording cell's
 * compact readout and inside the audio player — never as its
 * own column.)
 *
 * Rows are the combined chronological view: audio recordings
 * plus missed-call events (`row_kind: 'missed'`). Missed rows
 * show the red Missed treatment and "No recording" — never a
 * player, never audio. Recording rows keep the compact Play
 * button + duration with the floating player popover.
 *
 * The Recording column stays compact: one small Play button plus
 * the duration. The full audio player lives in a floating
 * popover anchored to that button (never an expanded row, never
 * a sidebar), so row height and column width never change.
 * The popover opens ONLY from the Recording cell's Play button —
 * rows themselves are not clickable and no other cell opens it.
 *
 * Visual language (header, dividers, hover, selection, footer)
 * follows the Workspace table: same shadcn primitives, same
 * header treatment, and the shared WorkspacePagination footer.
 */
export function RecordingsTable({
  recordings,
  loading,
  page,
  total,
  pageSize,
  onPage,
  onPageSize,
  onFindLead,
}: {
  recordings: RecordingTableRow[];
  loading: boolean;
  page: number;
  total: number;
  pageSize: WorkspacePageSize;
  onPage: (p: number) => void;
  onPageSize: (size: WorkspacePageSize) => void;
  onFindLead?: (r: CallRecording) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Single floating player: at most one popover open at a time.
  // `autoplay` is set only by the Play-button click — the sole
  // opener; both reset on close so a reopened player never
  // inherits stale intent.
  const [openId, setOpenId] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(false);

  const closePlayer = () => {
    setOpenId(null);
    setAutoplay(false);
  };

  // Filtering, pagination, or refresh may remove the open
  // recording from the rendered rows — close its (now stale)
  // popover rather than floating an orphaned player. Adjusted
  // during render (not in an effect): React re-renders
  // immediately before paint, with no cascading effect cycle.
  const [prevRecordings, setPrevRecordings] = useState(recordings);
  if (prevRecordings !== recordings) {
    setPrevRecordings(recordings);
    if (openId !== null && !recordings.some((r) => r.id === openId)) {
      setOpenId(null);
      setAutoplay(false);
    }
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <Table>
          {/* Workspace-style header: flat tinted fill on every
              header cell (the Workspace "No." row-number tone,
              HEADER_REFERENCE_ROW #f1f5f9; theme muted in dark
              mode), same h-16/bold/bordered treatment as the
              Workspace table — never a plain white row. */}
          <TableHeader className="[&_tr]:border-b-0 [&_th]:bg-[#f1f5f9] dark:[&_th]:bg-muted">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-16 w-12 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">No.</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Time</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Lead Name</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Workspace Table</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Call</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Salesperson</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Recording</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: pageSize }).map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={7}>
                    <Skeleton className="h-10 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              recordings.map((r, i) => {
                const linked = !!r.contact_id;
                const missed = isMissedCallRow(r);
                const playerOpen = !missed && r.id === openId;
                return (
                  // Rows are not clickable: the player opens ONLY
                  // from the Recording cell's Play button below.
                  // No other cell carries an opener, so clicks
                  // elsewhere in the row do nothing.
                  <TableRow
                    key={r.id}
                    aria-selected={playerOpen}
                    data-state={playerOpen ? 'selected' : undefined}
                  >
                    <TableCell className="border-r border-border px-4 tabular-nums text-muted-foreground last:border-r-0">
                      {page * pageSize + i + 1}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0">
                      <RecordedCell recordedAt={r.recorded_at} createdAt={r.created_at} />
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0">
                      {linked && r.contact_id ? (
                        // Shared Workspace lead deep link (same
                        // component as Call Analytics Recent Calls):
                        // the lead's own Workspace table in a NEW
                        // tab, located by stable contacts.id.
                        <WorkspaceLeadLink
                          contactId={r.contact_id}
                          title={r.contact_name ?? undefined}
                        >
                          {r.contact_name ?? 'Unlinked'}
                        </WorkspaceLeadLink>
                      ) : (
                        <span className="truncate text-rose-600 dark:text-rose-400">Unlinked</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px] border-r border-border px-4 last:border-r-0">
                      {r.workspace_table_name ? (
                        <span
                          title={r.workspace_table_name}
                          className="block truncate text-[13px] text-foreground"
                        >
                          {r.workspace_table_name}
                        </span>
                      ) : (
                        <span className="block text-[13px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0">
                      {missed ? (
                        <MissedCallLabel />
                      ) : (
                        <CallLabel callType={r.call_type} direction={r.direction} />
                      )}
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate border-r border-border px-4 text-[13px] last:border-r-0">
                      {r.uploader_name ?? 'Unknown'}
                    </TableCell>
                    {/* Compact Recording cell: the whole cell is one
                        clickable area and the SOLE opener of the
                        floating player. The player renders in a
                        floating popover (portaled — never in the row),
                        so this column stays narrow and row height
                        never changes. */}
                    {/* Missed events have no audio: "No recording",
                        never a player. Recording rows keep the
                        compact Play button + floating popover. */}
                    <TableCell className="border-r border-border px-4 last:border-r-0">
                      {missed ? (
                        <span className="text-[13px] text-muted-foreground">
                          No recording
                        </span>
                      ) : (
                      <Popover
                        open={playerOpen}
                        onOpenChange={(next) => {
                          if (next) {
                            setOpenId(r.id);
                          } else if (openId === r.id) {
                            closePlayer();
                          }
                        }}
                      >
                        <div
                          onClick={(e) => {
                            // Clicks on the Play button itself are
                            // left to the trigger toggle below; every
                            // other click inside this cell opens the
                            // player. No other cell opens it.
                            if ((e.target as HTMLElement).closest('button')) return;
                            setOpenId(r.id);
                            setAutoplay(true);
                          }}
                          className="inline-flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/60"
                        >
                          <PopoverTrigger
                            render={
                              <button
                                type="button"
                                aria-label={`Play recording${r.contact_name ? ` of ${r.contact_name}` : ''}`}
                                onClick={() => {
                                  setAutoplay(true);
                                }}
                                className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700"
                              />
                            }
                          >
                            {playerOpen ? (
                              <Pause className="h-4 w-4" />
                            ) : (
                              <Play className="ml-0.5 h-4 w-4" />
                            )}
                          </PopoverTrigger>
                          <span className="text-[13px] tabular-nums text-muted-foreground">
                            {formatDuration(r.duration_seconds)}
                          </span>
                        </div>
                        <PopoverContent
                          side="top"
                          align="center"
                          sideOffset={8}
                          collisionPadding={12}
                          collisionAvoidance={{ side: 'flip', align: 'shift' }}
                          className="w-80 max-w-[calc(100vw-2rem)] p-4"
                          aria-label="Recording audio player"
                        >
                          {/* Audio controls only: no lead name, avatar,
                              phone, workspace table, or other lead
                              metadata — the table row already
                              identifies the recording. */}
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Close player"
                              onClick={closePlayer}
                              className="h-8 w-8 shrink-0"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                          {/* Keyed by recording: switching recordings
                              mounts a fresh player (fresh progress,
                              speed, volume) and unmounts the old one,
                              whose cleanup pauses its audio — no
                              background playback, no stale events. */}
                          <RecordingPlayer
                            key={r.id}
                            recordingId={r.id}
                            autoplay={autoplay}
                          />
                          {!isMissedCallRow(r) && !linked && onFindLead ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              onClick={() => {
                                closePlayer();
                                onFindLead(r);
                              }}
                            >
                              <Link2 className="h-4 w-4" /> Find / Link Lead
                            </Button>
                          ) : null}
                        </PopoverContent>
                      </Popover>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <WorkspacePagination
          page={page}
          totalPages={pageCount}
          total={total}
          pageSize={pageSize}
          rowsOnPage={recordings.length}
          disabled={loading}
          onPage={onPage}
          onPageSize={onPageSize}
        />
      </div>
    </div>
  );
}
