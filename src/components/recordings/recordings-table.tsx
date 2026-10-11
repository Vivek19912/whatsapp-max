'use client';

import {
  ArrowDown,
  ArrowUp,
  Minus,
  Play,
} from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  type WorkspacePageSize,
} from '@/lib/flows/workspace-pagination';
import { formatRecordedIndiaParts, type CallRecording } from '@/lib/recordings/recordings';

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

function TypeLabel({ callType }: { callType: string | null | undefined }) {
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

function DirectionLabel({ direction }: { direction: string | null | undefined }) {
  if (direction === 'in') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap text-blue-700 dark:text-blue-300">
        <ArrowDown className="h-3.5 w-3.5" /> Incoming
      </span>
    );
  }
  if (direction === 'out') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap text-emerald-700 dark:text-emerald-300">
        <ArrowUp className="h-3.5 w-3.5" /> Outgoing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap text-muted-foreground">
      <Minus className="h-3.5 w-3.5" /> Unknown
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
 * Recordings table: No. | Recorded | Lead | Type | Direction |
 * Duration | Uploaded By | Play. Display-only row numbers continue
 * across pages. No filename, no size, no storage internals.
 * Any row click selects the recording (drawer); the Play button
 * selects it and autoplays in the drawer.
 *
 * Visual language (header, dividers, hover, selection, footer)
 * follows the Workspace table: same shadcn primitives, same
 * header treatment, and the shared WorkspacePagination footer.
 */
export function RecordingsTable({
  recordings,
  loading,
  selectedId,
  onSelect,
  page,
  total,
  pageSize,
  onPage,
  onPageSize,
}: {
  recordings: CallRecording[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (r: CallRecording, autoplay: boolean) => void;
  page: number;
  total: number;
  pageSize: WorkspacePageSize;
  onPage: (p: number) => void;
  onPageSize: (size: WorkspacePageSize) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

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
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Type</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Direction</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Duration</TableHead>
              <TableHead className="h-16 px-4 align-middle text-[15px] font-bold border-r border-border border-b last:border-r-0">Uploaded By</TableHead>
              <TableHead className="h-16 px-4 align-middle text-right text-[15px] font-bold border-r border-border border-b last:border-r-0">Play</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: pageSize }).map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={8}>
                    <Skeleton className="h-10 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              recordings.map((r, i) => {
                const linked = !!r.contact_id;
                const active = r.id === selectedId;
                return (
                  <TableRow
                    key={r.id}
                    aria-selected={active}
                    data-state={active ? 'selected' : undefined}
                    onClick={() => onSelect(r, false)}
                    className="cursor-pointer"
                  >
                    <TableCell className="border-r border-border px-4 tabular-nums text-muted-foreground last:border-r-0">
                      {page * pageSize + i + 1}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0">
                      <RecordedCell recordedAt={r.recorded_at} createdAt={r.created_at} />
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0">
                      {linked ? (
                        <span className="truncate font-medium text-blue-600 dark:text-blue-400">
                          {r.contact_name ?? 'Unlinked'}
                        </span>
                      ) : (
                        <span className="truncate text-rose-600 dark:text-rose-400">Unlinked</span>
                      )}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0">
                      <TypeLabel callType={r.call_type} />
                    </TableCell>
                    <TableCell className="border-r border-border px-4 last:border-r-0">
                      <DirectionLabel direction={r.direction} />
                    </TableCell>
                    <TableCell className="border-r border-border px-4 tabular-nums last:border-r-0">{formatDuration(r.duration_seconds)}</TableCell>
                    <TableCell className="max-w-[140px] truncate border-r border-border px-4 text-[13px] last:border-r-0">
                      {r.uploader_name ?? 'Unknown'}
                    </TableCell>
                    <TableCell className="border-r border-border px-4 text-right last:border-r-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Play recording${r.contact_name ? ` of ${r.contact_name}` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(r, true);
                        }}
                        className="h-9 w-9 rounded-full bg-muted text-foreground hover:bg-muted"
                      >
                        <Play className="h-4 w-4" />
                      </Button>
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
