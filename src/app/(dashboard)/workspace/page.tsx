'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import localFont from 'next/font/local';
import Link from 'next/link';
import { toast } from 'sonner';
import { ExternalLink, Inbox, MessageCircle, Plus, Search, Table2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { handleExpiredSessionResponse } from '@/lib/auth/expired-session';
import { useAuth } from '@/hooks/use-auth';
import { useWorkspaceRealtime } from '@/hooks/use-workspace-realtime';
import type { WorkspaceField } from '@/lib/flows/workspace-fields';
import {
  isAssigneeField,
  type AssigneeMember,
} from '@/lib/flows/workspace-assignee';
import {
  ALL_ASSIGNEES,
  buildWorkspaceTableQuery,
  columnFiltersRequestKey,
  emptyColumnFilters,
  hasActiveWorkspaceFilters,
  serializeAssigneeSelection,
  type WorkspaceAssigneeSelection,
  type WorkspaceColumnFilters,
} from '@/lib/flows/workspace-filters';
import { AddColumnDialog } from '@/components/workspace/add-column-dialog';
import { ColumnsMenu } from '@/components/workspace/columns-menu';
import { FlowAnswerCell } from '@/components/workspace/flow-answer-cell';
import { TravelCrmSettings } from '@/components/workspace/travel-crm-settings';
import { CustomCell } from '@/components/workspace/custom-cell';
import {
  WorkspaceFilters,
  type AppliedDateFilter,
} from '@/components/workspace/workspace-filters';
import { ColumnResizeHandle } from '@/components/workspace/column-resize-handle';
import { HiddenRowsMenu } from '@/components/workspace/hidden-rows-menu';
import { RowActionsMenu } from '@/components/workspace/row-actions-menu';
import { TravelCrmAction } from '@/components/workspace/travel-crm-action';
import { DialAction } from '@/components/workspace/dial-action';
import { WorkspacePagination } from '@/components/workspace/workspace-pagination';
import {
  columnWidthStyle,
  defaultColumnWidthsForFields,
  isWideTextColumnName,
} from '@/lib/flows/workspace-column-widths';
import {
  excludeHiddenRows,
  orderPinnedFirst,
  type HiddenRowInfo,
} from '@/lib/flows/workspace-row-prefs';
import { formatColumnLabel } from '@/lib/flows/column-label';
import {
  isRenamableMetaColumn,
  metaDefaultHiddenColumnIds,
  metaHeaderLabelKey,
  resolveMetaHeaderDisplayLabel,
} from '@/lib/meta-lead-ads/header-labels';
import { MetaColumnHeaderMenu } from '@/components/workspace/meta-header-menu';
import { MetaTableSheetsDialog } from '@/components/workspace/meta-table-sheets-dialog';
import { MetaTableWhatsappDialog } from '@/components/workspace/meta-table-whatsapp-dialog';
import { resolveSpreadsheetOpenUrl } from '@/lib/meta-lead-sheets/sheets-client';
import { ScheduleFollowupDialog } from '@/components/workspace/schedule-followup-dialog';
import { isWorkspaceFollowupFieldName } from '@/lib/followups/workspace-link';

/**
 * Workspace-only typeface (DM Sans). Applied to the page root so
 * the rest of the application keeps its own font — nothing global
 * changes.
 */
const dmSans = localFont({
  src: '../../fonts/dm-sans-latin-wght-normal.woff2',
  weight: '400 700',
});
import {
  headerTextColor,
  assignHeaderBackgrounds,
} from '@/lib/flows/header-colors';
import {
  customFieldVisId,
  flowColumnVisId,
  ROW_VIS_ID,
} from '@/lib/flows/workspace-visibility';
import {
  isLeadReceivedField,
  orderBusinessColumns,
  receivedDefaultLabel,
} from '@/lib/flows/workspace-defaults';
import { adSourcePlatform } from '@/lib/flows/workspace-ad-source';
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  applyWorkspacePageSizeChange,
  isWorkspacePageSize,
  workspaceRowNumber,
  type WorkspacePageSize,
} from '@/lib/flows/workspace-pagination';
import type {
  FlowTableColumn,
  FlowTablePayload,
  FlowTableRow,
  FlowTableView,
  LatestRecordingEntry,
} from '@/lib/flows/flow-tables';
import {
  flowColumnRenderKey,
  flowDisplayName,
  findWorkspaceRowForContact,
  resolveFlowAnswers,
  resolveAttachmentUrl,
  type LocateContactResponse,
} from '@/lib/flows/flow-tables';
import { formatPhoneForDisplay } from '@/lib/whatsapp/phone-utils';
import {
  formatRecordingDuration,
  type CallRecording,
} from '@/lib/recordings/recordings';
import {
  applyVisibility,
  useWorkspaceVisibility,
} from '@/lib/flows/workspace-visibility';
import {
  loadSelectedFlowId,
  resolveInitialFlowId,
  saveSelectedFlowId,
} from '@/lib/flows/workspace-selected-flow';
import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';

interface FlowOption {
  id: string;
  name?: string | null;
}

const VIEWS: Array<{ id: Exclude<FlowTableView, 'all'>; label: string }> = [
  { id: 'completed', label: 'Completed' },
  { id: 'incomplete', label: 'Incomplete' },
];

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Compact latest-recording cell: `▶ 00:35 · Akash`, playable
 * in place. The player lazy-loads (`preload="none"` — no request
 * until Play), and player clicks never bubble to the row (the
 * row opens the lead drawer). No recording → "No recording".
 */
function LatestRecordingCell({ entry }: { entry: LatestRecordingEntry | null }) {
  if (!entry) {
    return <span className="text-muted-foreground text-sm">No recording</span>;
  }
  return (
    <span
      className="flex items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      <audio
        src={`/api/recordings/${entry.id}/audio`}
        controls
        preload="none"
        className="h-8 w-full max-w-[180px]"
      />
      <span className="text-sm whitespace-nowrap tabular-nums">
        {formatRecordingDuration(entry.duration_seconds)}
      </span>
      <span className="text-muted-foreground max-w-[120px] truncate text-sm">
        {entry.uploader_name ?? 'Unknown'}
      </span>
    </span>
  );
}

/**
 * Lead recordings section for the row drawer: every recording
 * for `contactId`, newest first, each playable through the same
 * authenticated audio proxy as the table cell. Fetches the
 * contact-scoped list (`GET /api/recordings?contact_id=`) only
 * when the drawer opens on a linked contact.
 */
function LeadRecordings({ contactId }: { contactId: string }) {
  const [recordings, setRecordings] = useState<CallRecording[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/recordings?contact_id=${encodeURIComponent(contactId)}&limit=50`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled) {
          setRecordings((body?.recordings ?? []) as CallRecording[]);
        }
      })
      .catch(() => {
        if (!cancelled) setRecordings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-foreground text-sm font-semibold">
          Call Recordings
        </h3>
        <Link
          href={`/recordings/contact/${encodeURIComponent(contactId)}`}
          className="text-xs text-primary hover:text-primary/80"
        >
          View All Recordings
        </Link>
      </div>
      {recordings === null ? (
        <p className="text-muted-foreground mt-1 text-sm">Loading…</p>
      ) : recordings.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-sm">
          No recordings for this lead yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-3">
          {recordings.map((r) => (
            <li key={r.id} className="space-y-1">
              <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                <span className="tabular-nums">
                  {formatDateTime(r.recorded_at ?? r.created_at)}
                </span>
                <span className="truncate">
                  {formatRecordingDuration(r.duration_seconds)} ·{' '}
                  {r.uploader_name ?? 'Unknown'}
                </span>
              </div>
              <audio
                src={`/api/recordings/${r.id}/audio`}
                controls
                preload="none"
                className="h-8 w-full"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: FlowTableRow['status'] }) {
  const completed = status === 'completed';
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1.5 text-xs font-normal',
        completed
          ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
          : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          completed ? 'bg-emerald-500' : 'bg-amber-500'
        )}
      />
      {completed ? 'Completed' : 'Incomplete'}
    </Badge>
  );
}

/**
 * Plain-text content for one flow (non-custom) table cell. Empty
 * values render BLANK (never a dash placeholder) — display-only;
 * the underlying row data is untouched.
 *
 * Dispatch is by column identity (system vs flow-derived), never
 * by key text alone: a flow question may legally share its key
 * with a system column (e.g. var_key "name" beside the system
 * WhatsApp Name column). The system slot always shows the
 * canonical WhatsApp contact value; the flow slot always shows
 * that question's submitted answer — the two never leak into
 * each other.
 */
export function cellText(row: FlowTableRow, column: FlowTableColumn): string {
  if (column.system) {
    switch (column.key) {
      case 'name':
        return row.name ?? '';
      case 'phone':
        // Display-only: clearly Indian +91 numbers render as their
        // 10-digit mobile number; everything else (and storage,
        // search, messaging) keeps the canonical value.
        return formatPhoneForDisplay(row.phone);
      case 'submission_time':
        return formatDateTime(row.startedAt);
      case 'status':
        return row.status === 'completed' ? 'Completed' : 'Incomplete';
      case 'latest_recording':
        // Rendered by LatestRecordingCell (audio player), never as
        // text — empty here so text fallbacks stay blank, not stale.
        return '';
    }
  }
  return row.answers[column.key] ?? '';
}

export default function WorkspacePage() {
  const { accountId, accountRole, canEditSettings, canSendMessages, isOwner } = useAuth();
  // Agents see Workspace with ONLY their own assigned Meta leads
  // (the table APIs enforce the same ownership server-side).
  const isAgent = accountRole === 'agent';
  const [flows, setFlows] = useState<FlowOption[] | null>(null);
  const [flowsError, setFlowsError] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [view, setView] = useState<FlowTableView>('completed');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<WorkspacePageSize>(
    DEFAULT_WORKSPACE_PAGE_SIZE
  );
  const [payload, setPayload] = useState<FlowTablePayload | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FlowTableRow | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  // Per-table Google Sheets configuration dialog (Meta Lead Ads
  // tables only; Flow Tables never see it).
  const [sheetDialogOpen, setSheetDialogOpen] = useState(false);
  // Per-table WhatsApp auto-send dialog (Meta Lead Ads tables
  // only; Flow Tables never see it).
  const [whatsappDialogOpen, setWhatsappDialogOpen] = useState(false);
  // This Meta table's saved spreadsheet URL for the Workspace
  // open-sheet action. Null until the table-scoped config loads
  // (or when no spreadsheet is saved) — the button only renders
  // with a valid URL, so the configuration dialog is the path
  // otherwise.
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<WorkspaceField | null>(null);
  // Workspace filters (Date over Submission Time + Assigned To over
  // the live roster). Applied state only — the panel owns its
  // draft. Both are server-side: they ride the table request, so
  // pagination, views, search, visibility, and ordering are
  // preserved on the FILTERED set.
  const [appliedDate, setAppliedDate] = useState<AppliedDateFilter | null>(null);
  const [appliedAssignee, setAppliedAssignee] =
    useState<WorkspaceAssigneeSelection>(ALL_ASSIGNEES);
  // Applied five-column filters (null-safe empty default). Rides
  // the table request like date/assignee — server-side, so
  // pagination, counts, views, search, pin/hide, and ordering all
  // compose by construction.
  const [appliedColumns, setAppliedColumns] = useState<WorkspaceColumnFilters>(
    () => emptyColumnFilters()
  );
  // Header background overrides by stable visibility id
  // (`core:row`, `flow:<key>`, `custom:<uuid>`, `lead_source`).
  // Server-persisted per (account, flow); defaults resolve in
  // code, so visibility changes never disturb colors.
  const [headerColors, setHeaderColors] = useState<Record<string, string>>({});
  // Meta Lead Ads custom header names, keyed by the same stable
  // visibility id (`flow:<key>`). Applies ONLY to virtual Meta
  // tables (see the fetch + render guards below) — Flow Tables
  // never read or write this map.
  const [headerLabels, setHeaderLabels] = useState<Record<string, string>>({});
  // Column widths by stable visibility id. Absent = natural width
  // (current visuals are the initial state). Server-persisted per
  // (account, flow), independent of visibility and filters — never
  // part of the table request key, so resizing never refetches.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  // Active resize drag (viewport-level select-none while set).
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  // Row pin/hide prefs (per user per flow, migration 117). Pinned
  // run ids float to the top; hidden rows (with lead name/phone
  // for the restore panel) leave the rendered table. The server
  // applies the same rules post-migration, so these double as the
  // optimistic layer (instant feedback, rolled back on failure).
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(new Set());
  const [hiddenRows, setHiddenRows] = useState<HiddenRowInfo[]>([]);
  // In-flight row-pref requests by run id ('__all__' = bulk
  // restore): guards against duplicate taps while pending.
  const [rowActionPending, setRowActionPending] = useState<ReadonlySet<string>>(
    new Set()
  );
  // Live account roster for the "Assigned To" column — the SAME
  // source as Settings → Team Members (GET /api/account/members,
  // RLS-scoped to this account). Fetched once per page mount so a
  // newly added teammate appears with no code change; a removed
  // teammate simply stops being listed. Stored cells keep stable
  // user_ids — names resolve at render from this list.
  const [teamMembers, setTeamMembers] = useState<AssigneeMember[]>([]);
  // Optimistic custom-cell overrides, keyed by request so a stale
  // edit can never leak into a newer fetch (no effect needed —
  // mismatched keys are simply ignored on read).
  const [valueOverrides, setValueOverrides] = useState<{
    key: string | null;
    map: Record<string, Record<string, string | null>>;
  }>({ key: null, map: {} });

  // Account-scoped flow list (same source as the rest of the app).
  // The initial selection is the remembered flow for this account
  // when it is still listed, else the first flow — resolved in the
  // same flush as the list itself, so the table request derives
  // from the remembered id and its data is the first (and only)
  // fetch: no wrong-flow flash. Re-runs only when the account
  // changes, so a previous account's selection never carries over;
  // in-session changes persist immediately via selectFlow below.
  useEffect(() => {
    if (accountId === null) return;
    const ctrl = new AbortController();
    // Agents list only Meta tables containing their own assigned
    // leads (server-scoped); everyone else lists every flow.
    const flowsUrl = isAgent ? '/api/workspace/my-tables' : '/api/flows';
    fetch(flowsUrl, { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        // Expired/invalid session: clear client auth state and go to
        // the existing sign-in page instead of showing a raw 401 on
        // the Workspace. Any other status keeps its current handling
        // (403, validation, and 5xx never redirect).
        if (handleExpiredSessionResponse(res)) return;
        if (!res.ok) throw new Error(`Couldn't load flows (${res.status})`);
        const json = (await res.json()) as {
          flows?: Array<{ id: string; name?: string | null }>;
          tables?: Array<{ flow_id: string; name: string | null }>;
        };
        const list = (
          isAgent
            ? (json.tables ?? []).map((t) => ({ id: t.flow_id, name: t.name ?? null }))
            : (json.flows ?? []).map((f) => ({ id: f.id, name: f.name ?? null }))
        );
        if (ctrl.signal.aborted) return;
        setFlows(list);
        setFlowId(
          resolveInitialFlowId(
            list.map((f) => f.id),
            loadSelectedFlowId(accountId),
          ),
        );
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setFlowsError(
          err instanceof Error ? err.message : "Couldn't load flows."
        );
        setFlows([]);
      });
    return () => ctrl.abort();
  }, [accountId, isAgent]);

  // Assigned-To roster — same endpoint as Settings → Team Members.
  // Best-effort: a failed fetch leaves [] so Clear + Unassigned
  // still work and preserved legacy values keep rendering as-is.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/account/members', { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          members?: Array<{ user_id: string; full_name?: string | null }>;
        } | null;
        if (ctrl.signal.aborted || !json || !Array.isArray(json.members)) return;
        setTeamMembers(
          json.members
            .filter((m) => typeof m?.user_id === 'string' && m.user_id)
            .map((m) => ({
              user_id: m.user_id,
              full_name: m.full_name ?? null,
            }))
        );
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // Header-color overrides — same account/flow scope as the
  // table itself. Best-effort: a failed fetch leaves {} so every
  // column simply paints its default pastel.
  useEffect(() => {
    if (!flowId) return;
    const ctrl = new AbortController();
    fetch(`/api/flows/${flowId}/header-colors`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          colors?: Record<string, string>;
        } | null;
        if (ctrl.signal.aborted || !json || typeof json.colors !== 'object')
          return;
        setHeaderColors(json.colors ?? {});
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [flowId]);

  // Column widths — same account/flow scope as the table
  // itself. Best-effort: a failed fetch leaves {} so every
  // column simply keeps its natural width.
  useEffect(() => {
    if (!flowId) return;
    const ctrl = new AbortController();
    fetch(`/api/flows/${flowId}/column-widths`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          widths?: Record<string, number>;
        } | null;
        if (ctrl.signal.aborted || !json || typeof json.widths !== 'object')
          return;
        const clean: Record<string, number> = {};
        for (const [key, value] of Object.entries(json.widths ?? {})) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            clean[key] = value;
          }
        }
        setColumnWidths(clean);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [flowId]);

  // Meta Lead Ads custom header names — fetched only for
  // virtual Meta tables (the route 404s everything else), so
  // Flow Tables never pay for or see this map. Best-effort: a
  // failed fetch leaves {} so every column renders its original
  // Instant Form question.
  useEffect(() => {
    setHeaderLabels({});
    if (!flowId || payload?.meta.kind !== 'meta_lead_ads') return;
    const ctrl = new AbortController();
    fetch(`/api/integrations/meta-lead-ads/flows/${flowId}/header-labels`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          labels?: Record<string, string>;
        } | null;
        if (ctrl.signal.aborted || !json || typeof json.labels !== 'object')
          return;
        const clean: Record<string, string> = {};
        for (const [key, value] of Object.entries(json.labels ?? {})) {
          if (typeof value === 'string' && value.trim() !== '') {
            clean[key] = value;
          }
        }
        setHeaderLabels(clean);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [flowId, payload?.meta.kind]);

  // Row pin/hide prefs — same account/flow scope as the table,
  // refetched per flow (Completed/Incomplete deliberately share
  // one configuration). Best-effort like the reads above: a
  // failure (e.g. migration 117 not yet applied) leaves empty
  // prefs, and each pin/hide/restore action surfaces its own
  // error toast — the table itself keeps working.
  const reloadRowPrefs = useCallback(async () => {
    if (!flowId) return;
    try {
      const res = await fetch(`/api/flows/${flowId}/row-prefs`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as {
        pinned?: unknown;
        hidden?: unknown;
      } | null;
      if (!json || !Array.isArray(json.pinned) || !Array.isArray(json.hidden))
        return;
      setPinnedIds(
        new Set(
          json.pinned.filter((v): v is string => typeof v === 'string' && v !== '')
        )
      );
      const clean: HiddenRowInfo[] = [];
      for (const h of json.hidden) {
        if (!h || typeof h !== 'object') continue;
        const row = h as Record<string, unknown>;
        if (typeof row.flow_run_id !== 'string' || row.flow_run_id === '')
          continue;
        clean.push({
          flow_run_id: row.flow_run_id,
          name: typeof row.name === 'string' ? row.name : null,
          phone: typeof row.phone === 'string' ? row.phone : null,
        });
      }
      setHiddenRows(clean);
    } catch {
      // Best-effort: prefs stay as they were.
    }
  }, [flowId]);

  useEffect(() => {
    // A previous flow's pins/hides must never flash into the new
    // flow's table while its prefs load.
    setPinnedIds(new Set());
    setHiddenRows([]);
    if (!flowId) return;
    void reloadRowPrefs();
  }, [flowId, reloadRowPrefs]);

  // Debounced search; resets to the first page.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(0);
    }, 400);
    return () => window.clearTimeout(t);
  }, [search]);

  const selectFlow = useCallback((id: string | null) => {
    if (!id) return;
    setFlowId(id);
    setView('completed');
    setPage(0);
    setSelected(null);
    saveSelectedFlowId(accountId, id);
  }, [accountId]);

  const selectView = useCallback((v: Exclude<FlowTableView, 'all'>) => {
    setView(v);
    setPage(0);
  }, []);

  const applyFilters = useCallback(
    (
      date: AppliedDateFilter | null,
      assignee: WorkspaceAssigneeSelection,
      columns: WorkspaceColumnFilters
    ) => {
      setAppliedDate(date);
      setAppliedAssignee(assignee);
      setAppliedColumns(columns);
      setPage(0);
      setSelected(null);
    },
    []
  );

  // Persist one column's header tint (null resets to the default).
  // Optimistic: paint immediately, revert + toast when the server
  // rejects (same pattern as the Members tab role editor).
  const handleSaveHeaderColor = useCallback(
    async (columnKey: string, color: string | null) => {
      if (!flowId) return;
      const previous = headerColors;
      setHeaderColors((prev) => {
        const next = { ...prev };
        if (color === null) delete next[columnKey];
        else next[columnKey] = color;
        return next;
      });
      try {
        const res = await fetch(`/api/flows/${flowId}/header-colors`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ column_key: columnKey, color }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            (payload as { error?: string }).error ?? 'Could not save the color.'
          );
        }
      } catch (err) {
        setHeaderColors(previous);
        toast.error(
          err instanceof Error ? err.message : 'Could not save the color.'
        );
      }
    },
    [flowId, headerColors]
  );

  // Persist one Meta Lead Ads column's custom header (null restores
  // the original question). Optimistic: paint immediately, revert +
  // toast when the server rejects (same pattern as header colors).
  // Meta-only callers: the menu renders solely on Meta tables, and
  // the API itself rejects non-Meta flows.
  const handleSaveHeaderLabel = useCallback(
    async (columnKey: string, label: string | null) => {
      if (!flowId) return;
      const visKey = metaHeaderLabelKey(columnKey);
      const previous = headerLabels;
      setHeaderLabels((prev) => {
        const next = { ...prev };
        if (label === null) delete next[visKey];
        else next[visKey] = label;
        return next;
      });
      try {
        const res = await fetch(
          `/api/integrations/meta-lead-ads/flows/${flowId}/header-labels`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ column_key: columnKey, label }),
          }
        );
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            (payload as { error?: string }).error ?? 'Could not save the header name.'
          );
        }
      } catch (err) {
        setHeaderLabels(previous);
        toast.error(
          err instanceof Error ? err.message : 'Could not save the header name.'
        );
        throw err;
      }
    },
    [flowId, headerLabels]
  );

  // Header paint helpers live below the visibility memo (they
  // need the visible column set for the uniqueness map).

  const selectPageSize = useCallback((value: string | null) => {
    if (value === null) return;
    const size = Number(value);
    if (!isWorkspacePageSize(size)) return;
    const next = applyWorkspacePageSizeChange(size);
    setPageSize(next.pageSize);
    setPage(next.page);
  }, []);

  // Table rows: server-filtered + paginated per (flow, view, search,
  // filters, page). Loading is DERIVED (requested vs loaded key) so
  // the fetch effect never sets state synchronously — responses
  // reconcile by key, and a stale response for an older key is
  // ignored.
  // Meta Lead Ads tables show every lead in one unified table: the
  // Completed/Incomplete tabs are hidden below and the request
  // always uses view=all (the API default). Flow Tables keep their
  // selected view untouched.
  const effectiveView: FlowTableView =
    payload?.meta?.kind === 'meta_lead_ads' ? 'all' : view;
  const appliedDateRange = appliedDate?.range ?? null;
  const requestKey = flowId
    ? `${flowId}|${effectiveView}|${debouncedSearch}|${appliedDateRange?.from ?? ''}|${appliedDateRange?.to ?? ''}|${serializeAssigneeSelection(appliedAssignee)}|${columnFiltersRequestKey(appliedColumns)}|${page}|${pageSize}`
    : null;
  const loading = requestKey !== null && requestKey !== loadedKey;
  useEffect(() => {
    if (!flowId || !requestKey) return;
    const ctrl = new AbortController();
    const qs = buildWorkspaceTableQuery({
      view: effectiveView,
      search: debouncedSearch,
      page,
      pageSize,
      dateRange: appliedDateRange,
      assignee: appliedAssignee,
      columns: appliedColumns,
    });
    fetch(`/api/flows/${flowId}/table?${qs}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        // Same expired-session rule as the flows list above: a 401
        // redirects to sign-in via the shared handler and never
        // surfaces as a raw table error. Other statuses fall through
        // to the existing error handling below.
        if (handleExpiredSessionResponse(res)) return;
        const json = (await res.json().catch(() => null)) as
          (FlowTablePayload & { error?: unknown }) | null;
        if (!res.ok || !json || !('rows' in json)) {
          throw new Error(
            json && typeof json.error === 'string'
              ? json.error
              : `Couldn't load table (${res.status})`
          );
        }
        if (ctrl.signal.aborted) return;
        setPayload(json as FlowTablePayload);
        setTableError(null);
        setLoadedKey(requestKey);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (ctrl.signal.aborted) return;
        setTableError(
          err instanceof Error ? err.message : "Couldn't load table."
        );
        setLoadedKey(requestKey);
      });
    return () => ctrl.abort();
  }, [flowId, requestKey, effectiveView, debouncedSearch, appliedDateRange, appliedAssignee, appliedColumns, page, pageSize, refreshSeq]);

  const totalPages = useMemo(() => {
    const total = payload?.meta.total ?? 0;
    return Math.max(1, Math.ceil(total / pageSize));
  }, [payload, pageSize]);
  // Deep link (e.g. from Call Recordings): ?contact=<contacts.id>
  // selects the first row for that lead — the exact same `selected`
  // state a row click sets, so the same drawer opens. Runs once per
  // param value: closing the drawer never reopens it, and an
  // unknown id (or a lead with no flow rows) leaves the plain table.
  // The rows are already account-scoped, so a foreign id can only
  // ever match nothing.
  //
  // When the lead is not on the loaded page, a one-shot targeted
  // lookup resolves its (flow, view, page) and navigates there
  // through the normal table path — the row below then selects it,
  // so the drawer keeps its full payload context. A manual
  // selection always wins: we never yank the user away from a lead
  // they opened themselves.
  const deepLinkContactId = useSearchParams().get('contact');
  const appliedContactRef = useRef<string | null | undefined>(undefined);
  const locatedContactRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Fail-closed ordering: never mark the param as applied before
    // the payload exists. On fresh navigation (e.g. from Call
    // Recordings) payload is null on the first run — stamping the
    // ref there suppressed the retry once the rows arrived, so the
    // lead was never selected.
    if (!deepLinkContactId || !payload) return;
    if (appliedContactRef.current === deepLinkContactId) return;
    const row = findWorkspaceRowForContact(payload.rows, deepLinkContactId);
    if (row) {
      setSelected(row);
      appliedContactRef.current = deepLinkContactId;
      return;
    }
    if (selected || locatedContactRef.current === deepLinkContactId) return;
    locatedContactRef.current = deepLinkContactId;
    const ctrl = new AbortController();
    fetch(
      `/api/workspace/locate-contact?contact_id=${encodeURIComponent(deepLinkContactId)}&page_size=${pageSize}`,
      { signal: ctrl.signal, cache: 'no-store' },
    )
      .then(async (res) => {
        const body = (await res.json().catch(
          () => null,
        )) as LocateContactResponse | null;
        if (!body || body.found !== true) return;
        if (typeof body.flow_id !== 'string' || !body.flow_id) return;
        if (body.view !== 'completed' && body.view !== 'incomplete') return;
        if (!Number.isInteger(body.page) || body.page < 0) return;
        // Route through normal flow/view/page state so the table
        // refetches and the match above fires on the fresh payload.
        setFlowId(body.flow_id);
        setView(body.view);
        setPage(body.page);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [deepLinkContactId, payload, pageSize, selected]);  const activeFlowName = flows?.find((f) => f.id === flowId)?.name ?? null;

  const customFields = useMemo(() => payload?.customFields ?? [], [payload]);
  // Meta Lead Ads only: drop the "Lead Received" business column
  // (displayed as "Lead Source") from the visible table AND the
  // Columns menu — Meta leads carry the real Source answer column
  // instead, so the derived duplicate is redundant. Stored values,
  // field definitions, filter metadata, and Flow Tables are
  // untouched; the field stays manageable from any Flow Table.
  const isMetaTable = payload?.meta?.kind === 'meta_lead_ads';
  const customFieldsScoped = useMemo(
    () =>
      isMetaTable
        ? customFields.filter((f) => !isLeadReceivedField({ name: f.name }))
        : customFields,
    [isMetaTable, customFields]
  );
  // Live business-column metadata for the Filters panel: each
  // column's own options (never hardcoded) + presence flags for
  // the date sections. Resolved by case-insensitive stored name —
  // the same rule the table RPC filters by.
  const columnFilterOptions = useMemo(() => {
    const byName = new Map(
      customFields.map((f) => [f.name.trim().toLowerCase(), f] as const)
    );
    const selectOptions = (name: string): string[] => {
      const field = byName.get(name);
      return field && Array.isArray(field.options) ? [...field.options] : [];
    };
    return {
      callStatus: selectOptions('call status'),
      followUpStatus: selectOptions('follow-up status'),
      lastContactDate: byName.has('last contact date'),
      nextFollowUp: byName.has('next follow-up date & time'),
    };
  }, [customFields]);
  const overridesForRequest =
    valueOverrides.key === requestKey ? valueOverrides.map : {};

  // This Meta table's saved spreadsheet URL for the Workspace
  // open-sheet action — read from the SAME table-scoped config
  // endpoint the dialog saves (never another table's). Refetched
  // per selected table AND whenever the configuration dialog
  // closes, with the previous URL cleared first: saving a new
  // spreadsheet (e.g. right after Create Spreadsheet) otherwise
  // leaves this button pointing at the previously connected
  // sheet until a full page refresh. The dialog's unsaved draft
  // never touches this state, so the active sheet only changes
  // after a successful save. Best-effort like the roster above:
  // failures leave null (no button) and the configuration dialog
  // remains the path. Owner-gated like the buttons themselves.
  useEffect(() => {
    setSheetUrl(null);
    if (!isMetaTable || !isOwner || !flowId) return;
    const ctrl = new AbortController();
    fetch(
      `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/config`,
      { signal: ctrl.signal, cache: 'no-store' }
    )
      .then(async (res) => {
        if (!res.ok || ctrl.signal.aborted) return;
        const json = (await res.json().catch(() => null)) as {
          status?: {
            spreadsheetUrl?: unknown;
            spreadsheetId?: unknown;
          };
        } | null;
        if (ctrl.signal.aborted || !json || typeof json !== 'object') return;
        const status = json.status;
        setSheetUrl(
          resolveSpreadsheetOpenUrl({
            spreadsheetUrl: status?.spreadsheetUrl ?? null,
            spreadsheetId: status?.spreadsheetId ?? null,
          })
        );
      })
      .catch(() => {});
    return () => ctrl.abort();
    // sheetDialogOpen: refetch on close so a just-saved spreadsheet
    // takes effect immediately (the refetch on open is harmless —
    // the dialog covers the header while open).
  }, [isMetaTable, isOwner, flowId, sheetDialogOpen]);

  const reloadTable = useCallback(() => {
    setRefreshSeq((n) => n + 1);
  }, []);

  // Live sync: subscribe to flow_runs Realtime for the selected flow
  // so new runs, edits, and deletions surface WITHOUT a manual refresh.
  // The subscription only SCHEDULES the existing debounced reloadTable()
  // (never splices rows client-side) — the `/api/flows/[id]/table` RPC
  // remains the single source of truth for rows, filters, pagination,
  // and authorization. flow_runs RLS already isolates accounts, and the
  // channel is scoped to this account + flow. Cleanup (flow change /
  // unmount) removes the channel and cancels any pending debounce.
  useWorkspaceRealtime({
    accountId,
    flowId,
    onChange: reloadTable,
  });

  // Two-way Travel CRM sync: after a successful lead create whose
  // dialog edits landed in Workspace, refresh the table and patch
  // the open row instantly — custom-field cells (Type/Stage/Received)
  // through the same optimistic override map as manual edits, flow
  // answers + contact name/phone on the drawer row. The table refetch
  // then confirms every patched value from the server.
  const handleTravelCrmSynced = useCallback(
    (
      patch: {
        answers: Record<string, string | null>;
        name: string | null;
        phone: string | null;
        customValues: Record<string, string | null>;
      },
      runId: string,
    ) => {
      if (requestKey && Object.keys(patch.customValues).length > 0) {
        setValueOverrides((prev) => ({
          key: requestKey,
          map: {
            ...(prev.key === requestKey ? prev.map : {}),
            [runId]: {
              ...((prev.key === requestKey ? prev.map : {})[runId] ?? {}),
              ...patch.customValues,
            },
          },
        }));
      }
      setSelected((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              ...(patch.name !== null ? { name: patch.name } : {}),
              ...(patch.phone !== null ? { phone: patch.phone } : {}),
              answers: { ...prev.answers, ...patch.answers },
            },
      );
      reloadTable();
    },
    [reloadTable, requestKey],
  );

  // Meta Lead Ads only: the canonical "Next Follow-up Date & Time"
  // column. Saving it offers a linked Reminders reminder (the
  // dialog); clearing it cancels the linked scheduled reminder.
  // Flow Tables have no reminder hook — their saves behave exactly
  // as before.
  const followupFieldId = useMemo(
    () =>
      customFields.find(
        (f) =>
          f.field_type === 'datetime' && isWorkspaceFollowupFieldName(f.name)
      )?.id ?? null,
    [customFields]
  );
  // Single Schedule Follow-up modal state. Clicking the Meta
  // follow-up cell opens it directly with the row's lead details
  // and current value; saving inside the modal writes the cell and
  // creates/updates the linked reminder with one identical
  // timestamp. Flow Tables never set this state.
  const [scheduleModal, setScheduleModal] = useState<{
    runId: string;
    fieldId: string;
    name: string | null;
    phone: string | null;
    initialValue: string | null;
  } | null>(null);

  // Meta Lead Ads Tables only: manual assignment through the
  // audited endpoint (write + history in one step). The save runs
  // for the Assigned To column via CustomCell's saveAssignee
  // override; Flow Tables never pass that override.
  const manualAssignMetaLead = useCallback(
    async (runId: string, raw: unknown): Promise<string | null> => {
      if (!flowId) throw new Error('Could not save the value.');
      const res = await fetch(`/api/flows/${flowId}/leads/${runId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: raw ?? null }),
      });
      const json = (await res.json().catch(() => null)) as {
        assignment?: { current: string | null };
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? 'Could not save the value.');
      toast.success('Owner updated.');
      return json?.assignment?.current ?? null;
    },
    [flowId]
  );

  const handleCustomSaved = useCallback(
    (fieldId: string, runId: string, value: string | null) => {
      if (!requestKey) return;
      setValueOverrides((prev) => ({
        key: requestKey,
        map: {
          ...(prev.key === requestKey ? prev.map : {}),
          [runId]: {
            ...((prev.key === requestKey ? prev.map : {})[runId] ?? {}),
            [fieldId]: value,
          },
        },
      }));
      // An assignee edit can move the row in or out of the active
      // assignee filter — re-sync with the server so the filtered
      // set stays truthful. (Submission Time never changes, so date
      // filtering needs no such resync.)
      if (appliedAssignee.type !== 'all') {
        const field = customFields.find((f) => f.id === fieldId);
        if (field && isAssigneeField(field)) reloadTable();
      }
    },
    [requestKey, appliedAssignee, customFields, reloadTable]
  );
  // Closed-trigger label: Base UI falls back to the raw value when
  // the selected item's text isn't resolved, which leaked the flow
  // UUID — always render the matched name explicitly instead. An
  // unmatched id (stale selection) shows the safe fallback, never
  // the UUID; with no selection yet the placeholder shows.
  const activeFlowLabel =
    flowId == null ? undefined : flowDisplayName(activeFlowName);

  // UI-only: the Status column is hidden — the Completed/Incomplete
  // tabs already communicate classification. The column stays in the
  // payload (drawer badges, types, API untouched).
  //
  // Column visibility is presentation-only state (account + flow
  // scoped, localStorage-backed): hiding filters these render
  // arrays, never the payload — data, definitions, values, and
  // order are preserved, so a restored column returns to its
  // original position.
  // Meta Lead Ads only: hide redundant dynamic identity columns
  // (e.g. a "Full name" question column duplicating the system Name
  // column) by default. The columns stay in the payload and in the
  // Columns menu, so they can be restored at any time; unhiding
  // persists because stored preferences always win over these
  // defaults. Flow Tables pass nothing and behave exactly as before.
  const metaDefaultHiddenIds = useMemo(
    () =>
      metaDefaultHiddenColumnIds(
        payload?.columns ?? [],
        payload?.meta?.kind === 'meta_lead_ads',
      ),
    [payload?.meta?.kind, payload?.columns],
  );
  const visibility = useWorkspaceVisibility(accountId, flowId, metaDefaultHiddenIds);
  const {
    flowColumns: flowColumnsVisible,
    customFields: customFieldsVisible,
  } = useMemo(
    () =>
      applyVisibility(
        payload?.columns ?? [],
        customFieldsScoped,
        visibility.hiddenIds
      ),
    [payload, customFieldsScoped, visibility.hiddenIds]
  );

  // "Lead Received" auto-detection: when the cell has no stored
  // value, display the ad-platform default (Facebook/Instagram)
  // derived read-only from the row's contact source URL — the
  // same derivation the old Lead Source icon used. A manual pick
  // is stored and always wins; detection is never written back.
  const leadReceivedField = useMemo(
    () => customFieldsVisible.find((f) => isLeadReceivedField({ name: f.name })) ?? null,
    [customFieldsVisible]
  );
  // Group 3 display order for the business/workspace columns:
  // Assigned To, Received, Type, Stage first (stored-name
  // identity), then everything else in stored relative order.
  // Render-only: visibility, widths, header colors, values, and
  // the Columns menu all keep using the stored-order lists above.
  const customFieldsOrdered = useMemo(
    () => orderBusinessColumns(customFieldsVisible),
    [customFieldsVisible]
  );
  // Doubled-width defaults for "Customer Response" / "Next Action"
  // (2 × 224px natural cap = 448px, inside the 80–500 band).
  // Stored user widths spread LAST and always win, so no saved
  // preference is ever reset — columns the user never resized
  // simply render at the doubled default, while explicitly
  // resized columns (these or any others) keep their exact saved
  // pixels. Keyed by stable `custom:<uuid>` identity, so renames
  // never orphan the default; hidden fields stay included so
  // unhiding restores the wide default.
  const effectiveColumnWidths = useMemo(
    () => ({
      ...defaultColumnWidthsForFields(customFields),
      ...columnWidths,
    }),
    [customFields, columnWidths]
  );
  const receivedDefaults = useMemo(() => {
    if (!leadReceivedField || !payload) return {} as Record<string, string>;
    const map: Record<string, string> = {};
    for (const row of payload.rows) {
      const label = receivedDefaultLabel(adSourcePlatform(row.sourceUrl ?? null));
      if (label) map[row.runId] = label;
    }
    return map;
  }, [leadReceivedField, payload]);

  // Visible table rows for the current pin/hide prefs: hidden rows
  // removed, pinned rows first (both stable — relative order within
  // each group is the server's). Post-migration-117 the server
  // applies the same rules, so these are no-ops on migrated data
  // and the fallback otherwise; either way the client and server
  // can never disagree on membership or pin-partitioning.
  const hiddenIdSet = useMemo(
    () => new Set(hiddenRows.map((h) => h.flow_run_id)),
    [hiddenRows]
  );
  const visibleRows = useMemo(
    () =>
      orderPinnedFirst(
        excludeHiddenRows(payload?.rows ?? [], hiddenIdSet),
        pinnedIds
      ),
    [payload, hiddenIdSet, pinnedIds]
  );

  // No pinned/frozen columns: every column scrolls horizontally
  // as one unified grid. Only the header row sticks vertically
  // (top-0) so column titles stay visible while rows scroll.
  // The row-number column hides exactly like any other column.
  const rowVisible = !visibility.hiddenIds.includes(ROW_VIS_ID);

  // Exact rendered header order (one entry PER RENDERED header,
  // hidden columns excluded, business display order applied):
  // row when visible, then flow columns in render order, then
  // business columns in pinned display order. Flow headers are
  // keyed by RENDER key (`sys:<key>` / `flow:<key>`) — never the
  // bare `flow:<key>` visibility id — so a system column and a
  // flow answer sharing one logical key (e.g. var_key "name"
  // beside system Name) keep separate color slots. Widths stay
  // keyed by the stable legacy visibility id (saved widths are
  // preserved); `fallbackIds` lets overrides persisted under the
  // legacy id still apply after the key namespacing.
  const visibleHeaderOrder = useMemo(
    (): Array<{
      visId: string;
      label: string;
      widthId: string;
      fallbackIds?: readonly string[];
    }> => [
      ...(rowVisible ? [{ visId: ROW_VIS_ID, label: 'Row', widthId: ROW_VIS_ID }] : []),
      ...flowColumnsVisible.map((c) => ({
        visId: flowColumnRenderKey(c),
        label: c.label,
        widthId: flowColumnVisId(c.key),
        fallbackIds: [flowColumnVisId(c.key)],
      })),
      ...customFieldsOrdered.map((f) => ({
        visId: customFieldVisId(f.id),
        label: f.name,
        widthId: customFieldVisId(f.id),
      })),
    ],
    [rowVisible, flowColumnsVisible, customFieldsOrdered]
  );

  // Positional backgrounds index-aligned with visibleHeaderOrder:
  // backgrounds[i] paints headers[i], sequentially assigned so
  // every adjacent pair differs (palette cycles to another
  // existing color instead of naively repeating when exhausted —
  // first/last and the scrollable tail included). Rebuilt on
  // every hide/show/reorder/add via the order above. Hidden
  // columns keep their stored overrides in headerColors, so
  // unhiding restores their tint; visibility resets never touch
  // this sequence.
  const headerBackgrounds = useMemo(
    () =>
      assignHeaderBackgrounds(
        visibleHeaderOrder.map(({ visId, label, fallbackIds }) => ({
          visId,
          label,
          ...(fallbackIds ? { fallbackIds } : {}),
        })),
        headerColors
      ),
    [visibleHeaderOrder, headerColors]
  );

  // Legacy-id map for the Columns manager (dots, taken-color
  // blocking, picker): derived from the SAME positional sequence
  // the headers paint, keyed by render id plus legacy flow ids so
  // lookups by either identity resolve to the painted color. The
  // TABLE headers never read this map — they paint positionally
  // from headerBackgrounds, so no key miss can fall back to the
  // per-column green default.
  const headerMap = useMemo(() => {
    const map: Record<string, string> = {};
    visibleHeaderOrder.forEach((entry, i) => {
      map[entry.visId] = headerBackgrounds[i];
      for (const legacy of entry.fallbackIds ?? []) {
        if (!(legacy in map)) map[legacy] = headerBackgrounds[i];
      }
    });
    return map;
  }, [visibleHeaderOrder, headerBackgrounds]);

  // Header paint by RENDERED POSITION (never by key lookup): the
  // caller passes the header's index in visibleHeaderOrder, so a
  // system/flow key collision can never share one slot and no
  // fallback can repaint neighbours with the default green.
  // Widths still resolve by stable legacy id.
  const headStyleAt = useCallback(
    (index: number) => {
      const entry = visibleHeaderOrder[index];
      const background = headerBackgrounds[index];
      return {
        ...columnWidthStyle(entry?.widthId ?? '', effectiveColumnWidths),
        backgroundColor: background,
        color: headerTextColor(background),
      };
    },
    [visibleHeaderOrder, headerBackgrounds, effectiveColumnWidths]
  );

  // Live width during a drag (no fetch); persist on release.
  // Unchanged releases skip the PUT; failures revert + toast.
  const handleResizeWidth = useCallback((columnKey: string, widthPx: number) => {
    setColumnWidths((prev) =>
      prev[columnKey] === widthPx ? prev : { ...prev, [columnKey]: widthPx }
    );
  }, []);

  const handleCommitWidth = useCallback(
    async (columnKey: string, widthPx: number) => {
      if (!flowId) return;
      const previous = columnWidths[columnKey];
      if (previous === widthPx) return;
      try {
        const res = await fetch(`/api/flows/${flowId}/column-widths`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ column_key: columnKey, width_px: widthPx }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            (payload as { error?: string }).error ?? 'Could not save the width.'
          );
        }
      } catch (err) {
        setColumnWidths((prev) => {
          const next = { ...prev };
          if (previous === undefined) delete next[columnKey];
          else next[columnKey] = previous;
          return next;
        });
        toast.error(
          err instanceof Error ? err.message : 'Could not save the width.'
        );
      }
    },
    [flowId, columnWidths]
  );

  // Row pin/hide mutations (agent+ only — the menus render for
  // writers). Optimistic like header colors: paint immediately,
  // roll back the snapshot + toast when the server rejects, then
  // refetch prefs + table on success (counts and cross-page pin
  // order come from the server). In-flight runs skip duplicate
  // taps; hiding never deletes, archives, completes, or modifies
  // any lead or flow-run record — it only flips a personal flag.
  const markRowPending = useCallback((key: string, on: boolean) => {
    setRowActionPending((prev) => {
      if (prev.has(key) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const mutateRowPref = useCallback(
    async (
      runId: string,
      patch: { pinned?: boolean; hidden?: boolean },
      messages: { success: string; failure: string }
    ) => {
      if (!flowId || rowActionPending.has(runId)) return;
      const prevPinned = pinnedIds;
      const prevHidden = hiddenRows;
      if (patch.pinned !== undefined) {
        const pinned = patch.pinned;
        setPinnedIds((prev) => {
          const next = new Set(prev);
          if (pinned) next.add(runId);
          else next.delete(runId);
          return next;
        });
      }
      if (patch.hidden !== undefined) {
        if (patch.hidden) {
          const row = payload?.rows.find((r) => r.runId === runId);
          const info: HiddenRowInfo = {
            flow_run_id: runId,
            name: row?.name ?? null,
            phone: row?.phone ?? null,
          };
          setHiddenRows((prev) =>
            prev.some((h) => h.flow_run_id === runId) ? prev : [...prev, info]
          );
        } else {
          setHiddenRows((prev) => prev.filter((h) => h.flow_run_id !== runId));
        }
      }
      markRowPending(runId, true);
      try {
        const res = await fetch(`/api/flows/${flowId}/row-prefs`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flow_run_id: runId, ...patch }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? messages.failure
          );
        }
        toast.success(messages.success);
        await reloadRowPrefs();
        reloadTable();
      } catch (err) {
        setPinnedIds(prevPinned);
        setHiddenRows(prevHidden);
        toast.error(
          err instanceof Error ? err.message : messages.failure
        );
      } finally {
        markRowPending(runId, false);
      }
    },
    [flowId, rowActionPending, pinnedIds, hiddenRows, payload, markRowPending, reloadRowPrefs, reloadTable]
  );

  const handleTogglePin = useCallback(
    (runId: string) => {
      const pinned = pinnedIds.has(runId);
      void mutateRowPref(
        runId,
        { pinned: !pinned },
        pinned
          ? { success: 'Row unpinned', failure: 'Could not unpin the row.' }
          : { success: 'Row pinned to the top', failure: 'Could not pin the row.' }
      );
    },
    [pinnedIds, mutateRowPref]
  );

  const handleHideRow = useCallback(
    (runId: string) => {
      void mutateRowPref(
        runId,
        { hidden: true },
        { success: 'Row hidden', failure: 'Could not hide the row.' }
      );
    },
    [mutateRowPref]
  );

  const handleRestoreRow = useCallback(
    (runId: string) => {
      void mutateRowPref(
        runId,
        { hidden: false },
        { success: 'Row restored', failure: 'Could not restore the row.' }
      );
    },
    [mutateRowPref]
  );

  const handleRestoreAllHidden = useCallback(async () => {
    // '__all__' is the bulk-restore pending key: run ids are UUIDs,
    // so it can never collide with a real row's pending entry.
    if (!flowId || rowActionPending.has('__all__') || hiddenRows.length === 0)
      return;
    const prevHidden = hiddenRows;
    setHiddenRows([]);
    markRowPending('__all__', true);
    try {
      const res = await fetch(`/api/flows/${flowId}/row-prefs`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all_hidden: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? 'Could not restore hidden rows.'
        );
      }
      const { restored } = (await res.json().catch(() => ({}))) as {
        restored?: unknown;
      };
      toast.success(
        typeof restored === 'number' && restored > 0
          ? `Restored ${restored} hidden row${restored === 1 ? '' : 's'}`
          : 'Hidden rows restored'
      );
      await reloadRowPrefs();
      reloadTable();
    } catch (err) {
      setHiddenRows(prevHidden);
      toast.error(
        err instanceof Error ? err.message : 'Could not restore hidden rows.'
      );
    } finally {
      markRowPending('__all__', false);
    }
  }, [flowId, rowActionPending, hiddenRows, markRowPending, reloadRowPrefs, reloadTable]);

  return (
    <div className={cn('space-y-5', dmSans.className)}>
      <div>
        <h1 className="text-foreground text-[30px] font-bold tracking-tight">
          Workspace
        </h1>
        {/* Meta Lead Ads tables hide this subtitle; Flow Tables
            keep it exactly as before. */}
        {payload?.meta.kind === 'meta_lead_ads' ? null : (
          <p className="text-muted-foreground mt-1 text-sm">
            One live table per flow — every run, completed or not.
          </p>
        )}
      </div>

      {flows === null ? (
        <Skeleton className="h-10 w-72" />
      ) : flowsError ? (
        <p className="text-destructive text-sm" role="alert">
          {flowsError}
        </p>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={Table2}
          title={isAgent ? "No leads assigned to you yet" : "No flows yet"}
          hint={
            isAgent
              ? "Leads assigned to you will appear here."
              : "Create a flow first — each flow gets its own table here."
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Select value={flowId ?? ''} onValueChange={selectFlow}>
              <SelectTrigger
                className={
                  isMetaTable
                    ? // Meta-only: long Instant Form names need room.
                      // 24rem (~384px) on desktop, capped at the
                      // container so nothing overflows; full width
                      // on small screens.
                      "border-border bg-card w-full sm:w-[min(24rem,100%)]"
                    : "border-border bg-card w-full sm:w-72"
                }
                aria-label="Select flow"
              >
                <SelectValue placeholder="Select Flow">
                  {isMetaTable && activeFlowLabel ? (
                    // Ellipsis + native tooltip when the viewport
                    // still forces truncation. min-w-0 lets the
                    // label actually shrink inside the flex value.
                    <span className="block min-w-0 truncate" title={activeFlowLabel}>
                      {activeFlowLabel}
                    </span>
                  ) : (
                    activeFlowLabel
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                className={
                  isMetaTable
                    ? "max-w-[calc(100vw-2rem)]"
                    : undefined
                }
              >
                {flows.map((f) => (
                  <SelectItem
                    key={f.id}
                    value={f.id}
                    title={isMetaTable ? flowDisplayName(f.name) : undefined}
                    className={
                      isMetaTable
                        // Let long option names ellipsize inside the
                        // (trigger-width) menu instead of clipping.
                        // shrink-0 on the item text must be overridden
                        // or flex refuses to shrink and no ellipsis
                        // appears; the arbitrary variant outranks it.
                        ? "[&>span]:min-w-0 [&>span]:shrink [&>span]:truncate"
                        : undefined
                    }
                  >
                    {flowDisplayName(f.name)}
                  </SelectItem>
                ))}
                </SelectContent>
              </Select>
              {/* Meta Lead Ads tables get a per-table Google Sheets
                  action here. Flow Tables keep exactly what they had
                  (no sheet action is rendered for them). */}
              {/* Owner-only sheet actions, grouped compactly: one
                  right-aligned group with a single 8px gap, so the
                  buttons always sit together. Admins, agents, and
                  viewers never see either button (the APIs enforce
                  the same owner rule server-side). */}
              {isMetaTable && isOwner && flowId ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSheetDialogOpen(true)}
                  >
                    <Table2 className="mr-1.5 size-4" />
                    Configure Sheet
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setWhatsappDialogOpen(true)}
                  >
                    <MessageCircle className="mr-1.5 size-4" />
                    Auto-send WhatsApp
                  </Button>
                  {/* This table's own saved spreadsheet only — the
                      URL is refetched per selected table above, and
                      the button renders solely with a valid URL.
                      Without one, the configuration dialog is the path. */}
                  {sheetUrl ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Open this table's spreadsheet in a new tab"
                      onClick={() =>
                        window.open(sheetUrl, '_blank', 'noopener,noreferrer')
                      }
                    >
                      <ExternalLink className="mr-1.5 size-4" />
                      Open Sheet
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {/* Meta Lead Ads tables show one unified table (view=all),
              so the Completed/Incomplete tabs are hidden here.
              Flow Tables keep the tabs exactly as before. */}
            {isMetaTable ? null : (
              <div
                className="flex items-center gap-1.5"
                role="tablist"
                aria-label="Completion filter"
              >
                {VIEWS.map((v) => (
                  <Button
                    key={v.id}
                    role="tab"
                    aria-selected={view === v.id}
                    variant={view === v.id ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => selectView(v.id)}
                    className={cn(
                      'h-8 rounded-full px-3.5 text-sm font-medium',
                      view !== v.id &&
                        'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {v.label}
                  </Button>
                ))}
              </div>
            )}
          </div>

          {payload?.meta.kind === 'meta_lead_ads' ? null : payload?.meta.completionNodeId ? (
            <p className="text-muted-foreground text-xs">
              Completion point:{' '}
              <code className="bg-muted rounded px-1 font-mono">
                {payload.meta.completionNodeId}
              </code>{' '}
              — runs that reach it show as Completed.{' '}
              <Link
                href={`/flows/${payload.meta.flowId}`}
                className="underline underline-offset-2"
              >
                Edit in flow builder
              </Link>
            </p>
          ) : (
            payload && (
              <p className="text-muted-foreground text-xs">
                No custom completion point — runs show as Completed when they
                reach END.{' '}
                <Link
                  href={`/flows/${payload.meta.flowId}`}
                  className="underline underline-offset-2"
                >
                  Set one in the flow builder
                </Link>
              </p>
            )
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative w-full sm:max-w-sm">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or phone…"
                className="pl-9"
                aria-label="Search table"
              />
            </div>
            <div className="flex items-center gap-2 sm:ml-auto">
              <WorkspaceFilters
                members={teamMembers}
                appliedDate={appliedDate}
                appliedAssignee={appliedAssignee}
                appliedColumns={appliedColumns}
                columnOptions={columnFilterOptions}
                onApply={applyFilters}
              />
              <ColumnsMenu
                flowId={flowId}
                flowColumns={payload?.columns ?? []}
                customFields={customFieldsScoped}
                hiddenIds={visibility.hiddenIds}
                onToggleVisibility={visibility.toggle}
                onShowAll={visibility.showAll}
                onReset={visibility.reset}
                onEditField={(f) => {
                  setEditingField(f);
                  setAddColumnOpen(true);
                }}
                onChanged={reloadTable}
                headerColors={headerColors}
                onSaveHeaderColor={handleSaveHeaderColor}
                canCustomizeColors={canSendMessages}
                headerColorMap={headerMap}
              />
              {canSendMessages && (
                <HiddenRowsMenu
                  hidden={hiddenRows}
                  pendingIds={rowActionPending}
                  restoreAllPending={rowActionPending.has('__all__')}
                  onRestore={handleRestoreRow}
                  onRestoreAll={handleRestoreAllHidden}
                />
              )}
              {canEditSettings && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setEditingField(null);
                    setAddColumnOpen(true);
                  }}
                  className="h-8 text-sm"
                >
                  <Plus className="h-4 w-4" />
                  Add Column
                </Button>
              )}
              <TravelCrmSettings
                key={flowId ?? 'no-flow'}
                flowId={flowId}
                flowName={flowDisplayName(activeFlowName)}
              />
            </div>
          </div>

          {tableError ? (
            <p className="text-destructive text-sm" role="alert">
              {tableError}
            </p>
          ) : loading && !payload ? (
            <Skeleton className="h-64 w-full" />
          ) : !payload || payload.rows.length === 0 ? (
            hasActiveWorkspaceFilters({
              dateRange: appliedDateRange,
              assignee: appliedAssignee,
              columns: appliedColumns,
            }) ? (
              <EmptyState
                icon={Table2}
                title="No matching runs"
                hint="Try widening the date range or choosing a different assignee — or clear the filters to see everything."
              />
            ) : (
              <EmptyState
                icon={Table2}
                title={
                  effectiveView === 'all'
                    ? 'No runs yet'
                    : effectiveView === 'completed'
                      ? 'No completed runs'
                      : 'No incomplete runs'
                }
                hint="New flow runs appear here automatically."
              />
            )
          ) : (
            <>
              <div className="border-border bg-card overflow-hidden rounded-xl border">
              <div
                className={cn(
                  'workspace-table-viewport max-h-[70vh] overflow-auto',
                  resizingKey !== null && 'select-none'
                )}
              >
                <Table>
                  {/* Enterprise grid: every header cell sticks to the
                      top (opaque, so rows slide underneath) while the
                      whole table scrolls horizontally as ONE unified
                      grid — no pinned or frozen columns. The
                      tr-level divider is neutralized (merged to
                      border-b-0 by tailwind-merge) in favour of the
                      th-level divider, which travels with the stuck
                      header. Each header carries a drag handle on its
                      right boundary (writers only). */}
                  <TableHeader className="[&_tr]:border-b-0">
                    <TableRow>
                      {/* Row actions: narrow fixed column first (writers
                          only). One three-dot menu per row — pin /
                          unpin / hide — with a filled-pin indicator
                          for pinned rows. Never resized, hidden, or
                          recolored: it sits outside the visibility,
                          width, and header-color systems. */}
                      {canSendMessages && (
                        <TableHead
                          className="sticky top-0 z-20 h-16 w-12 border-r border-b border-border px-2 align-middle"
                          aria-label="Row actions"
                        >
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      )}
                      {rowVisible && (
                      <TableHead
                        className="sticky top-0 z-20 h-16 truncate border-r border-b border-border px-4 align-middle text-[15px] font-bold last:border-r-0"
                        style={headStyleAt(0)}
                      >
                        No.
                        {canSendMessages && (
                          <ColumnResizeHandle
                            columnKey={ROW_VIS_ID}
                            onResize={handleResizeWidth}
                            onCommit={handleCommitWidth}
                            onActiveChange={(active) =>
                              setResizingKey(active ? ROW_VIS_ID : null)
                            }
                          />
                        )}
                      </TableHead>
                      )}
                      {flowColumnsVisible.map((c, flowIdx) => {
                        const visId = flowColumnVisId(c.key);
                        const headerIdx = (rowVisible ? 1 : 0) + flowIdx;
                        // Meta Lead Ads tables only: Instant Form
                        // question columns get a header menu (Rename /
                        // Restore). System columns, the Source column,
                        // and every Flow Table header render exactly
                        // as before.
                        const renamable =
                          payload?.meta.kind === 'meta_lead_ads' &&
                          isRenamableMetaColumn({ key: c.key, system: c.system });
                        const customLabel = renamable
                          ? (headerLabels[visId] ?? null)
                          : null;
                        // Dial is an application action column for EVERY
                        // Workspace table (Meta Lead Ads, Flow, and any
                        // other table with a Phone Number column): it
                        // renders immediately after the Phone Number
                        // system column, is not part of
                        // flowColumnsVisible, carries no resize handle
                        // / visibility id / header color, and is never
                        // sent to Google Sheets.
                        const showDialAfter =
                          c.system && c.key === 'phone';
                        return (
                          <Fragment key={flowColumnRenderKey(c)}>
                            <TableHead
                              key={flowColumnRenderKey(c)}
                              className="sticky top-0 z-20 h-16 truncate border-r border-b border-border px-4 align-middle text-[15px] font-bold whitespace-nowrap last:border-r-0"
                              style={headStyleAt(headerIdx)}
                            >
                              {renamable ? (
                                <MetaColumnHeaderMenu
                                  columnKey={c.key}
                                  originalLabel={c.label}
                                  displayLabel={
                                    customLabel ?? formatColumnLabel(c.label)
                                  }
                                  customLabel={customLabel}
                                  onRename={(label) =>
                                    handleSaveHeaderLabel(c.key, label)
                                  }
                                  onRestore={() => handleSaveHeaderLabel(c.key, null)}
                                />
                              ) : (
                                formatColumnLabel(c.label)
                              )}
                              {canSendMessages && (
                                <ColumnResizeHandle
                                  columnKey={visId}
                                  onResize={handleResizeWidth}
                                  onCommit={handleCommitWidth}
                                  onActiveChange={(active) =>
                                    setResizingKey(active ? visId : null)
                                  }
                                />
                              )}
                            </TableHead>
                            {showDialAfter && (
                              <TableHead
                                aria-label="Dial"
                                className="sticky top-0 z-20 h-16 truncate border-r border-b border-border px-4 align-middle text-[15px] font-bold whitespace-nowrap last:border-r-0"
                              >
                                Dial
                              </TableHead>
                            )}
                          </Fragment>
                        );
                      })}
                      {customFieldsOrdered.map((f, customIdx) => (
                        <TableHead
                          key={f.id}
                          className={cn(
                            'sticky top-0 z-20 h-16 truncate border-r border-b border-border px-4 align-middle text-[15px] font-bold whitespace-nowrap last:border-r-0',
                            // Customer Response / Next Action headers
                            // center their labels within the full
                            // 448px cell (the resize handle is
                            // absolutely positioned, so it never
                            // offsets centering). Header-only: body
                            // text stays left-aligned.
                            isWideTextColumnName(f.name) && 'text-center'
                          )}
                            style={headStyleAt(
                              (rowVisible ? 1 : 0) +
                                flowColumnsVisible.length +
                                customIdx
                            )}
                          >
                            {formatColumnLabel(f.name)}
                          {canSendMessages && (
                            <ColumnResizeHandle
                              columnKey={customFieldVisId(f.id)}
                              onResize={handleResizeWidth}
                              onCommit={handleCommitWidth}
                              onActiveChange={(active) =>
                                setResizingKey(
                                  active ? customFieldVisId(f.id) : null
                                )
                              }
                            />
                          )}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((row, rowIndex) => (
                      <TableRow
                        key={row.runId}
                        className={cn(
                          'cursor-pointer',
                          // Pinned rows read subtly highlighted (light
                          // amber wash) while keeping the row hover.
                          pinnedIds.has(row.runId) &&
                            'bg-amber-50/70 dark:bg-amber-950/20'
                        )}
                        onClick={() => setSelected(row)}
                      >
                        {canSendMessages && (
                          <TableCell className="w-12 border-r border-border px-2 last:border-r-0">
                            <RowActionsMenu
                              rowLabel={row.name ?? row.phone ?? 'row'}
                              isPinned={pinnedIds.has(row.runId)}
                              pending={rowActionPending.has(row.runId)}
                              onTogglePin={() => handleTogglePin(row.runId)}
                              onHide={() => handleHideRow(row.runId)}
                            />
                          </TableCell>
                        )}
                        {rowVisible && (
                        <TableCell
                          className="text-muted-foreground border-r border-border text-sm tabular-nums last:border-r-0"
                          style={columnWidthStyle(ROW_VIS_ID, effectiveColumnWidths)}
                        >
                          {workspaceRowNumber({
                            page,
                            pageSize,
                            index: rowIndex,
                          }).toLocaleString()}
                        </TableCell>
                        )}
                        {flowColumnsVisible.map((c) => {
                          // Flow-derived cells edit through Workspace
                          // overrides (originals stay in row.answers);
                          // system columns keep their plain rendering.
                          // Display = override ?? original, resolved
                          // per row from the table payload.
                          const rowOverrides =
                            payload.flowOverrides?.[row.runId];
                          const overrideFor =
                            rowOverrides !== undefined &&
                            Object.prototype.hasOwnProperty.call(rowOverrides, c.key)
                              ? (rowOverrides[c.key] ?? null)
                              : undefined;
                          // Attachment cells: resolve the existing file
                          // URL (media message match, else a URL value)
                          // so FlowAnswerCell can render the filename as
                          // a link opening the file in a new tab. Null →
                          // ordinary text cell, unchanged.
                          const rawCellValue =
                            overrideFor !== undefined
                              ? overrideFor
                              : (row.answers[c.key] ?? '');
                          const cellFileUrl = resolveAttachmentUrl(
                            payload.mediaByConversation ?? {},
                            row.conversationId,
                            rawCellValue,
                          );
                          // Every Workspace table: Dial action cell
                          // right after Phone Number. Application-only
                          // (never a sheet field, never editable, never
                          // stored).
                          const showDialAfter =
                            c.system && c.key === 'phone';
                          return (
                          <Fragment key={flowColumnRenderKey(c)}>
                            <TableCell
                              key={flowColumnRenderKey(c)}
                              className="max-w-56 truncate border-r border-border last:border-r-0"
                              style={columnWidthStyle(
                                flowColumnVisId(c.key),
                                effectiveColumnWidths
                              )}
                            >
                              {!c.system && flowId !== null ? (
                                <FlowAnswerCell
                                  flowId={flowId}
                                  runId={row.runId}
                                  columnKey={c.key}
                                  label={formatColumnLabel(c.label)}
                                  options={c.options ?? null}
                                  original={row.answers[c.key] ?? null}
                    rawOriginal={
                      payload?.meta?.kind === 'meta_lead_ads'
                        ? (row.rawAnswers?.[c.key] ?? null)
                        : undefined
                    }
                                  override={overrideFor}
                                  fileUrl={cellFileUrl}
                                  canEdit={canSendMessages}
                                  onChanged={reloadTable}
                                />
                              ) : c.system && c.key === 'latest_recording' ? (
                                <LatestRecordingCell
                                  entry={
                                    (payload.latestRecordingByContact?.[
                                      row.contactId ?? ''
                                    ] ?? null)
                                  }
                                />
                              ) : (
                                cellText(row, c)
                              )}
                            </TableCell>
                            {showDialAfter && (
                              <TableCell
                                aria-label="Dial"
                                className="max-w-36 truncate border-r border-border whitespace-nowrap last:border-r-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <DialAction
                                  phone={row.phone}
                                  contactId={row.contactId}
                                  flowId={flowId}
                                  runId={row.runId}
                                />
                              </TableCell>
                            )}
                          </Fragment>
                          );
                        })}
                        {flowId &&
                          customFieldsOrdered.map((f) => (
                            <TableCell
                              key={f.id}
                              className={cn(
                                'overflow-hidden border-r border-border last:border-r-0',
                                // Doubled natural cap for the two
                                // long-text columns (2 × max-w-56 =
                                // max-w-112 = 448px): twice the room
                                // with no clipping or overlap, and
                                // the grid keeps scrolling as one.
                                // Customer Response / Next Action
                                // cells additionally wrap up to 2
                                // lines (see twoLineClamp below):
                                // whitespace-normal overrides the
                                // table primitive's nowrap so text
                                // wraps within the 448px; px-3/py-2
                                // sets 12px horizontal + 8px
                                // vertical padding (vertical centering
                                // comes from the primitive's
                                // align-middle). Every other column
                                // keeps max-w-56 + natural width.
                                isWideTextColumnName(f.name)
                                  ? 'max-w-112 whitespace-normal px-3 py-2'
                                  : 'max-w-56'
                              )}
                              style={columnWidthStyle(
                                customFieldVisId(f.id),
                                effectiveColumnWidths
                              )}
                            >
                              <CustomCell
                                flowId={flowId}
                                runId={row.runId}
                                field={f}
                                stored={
                                  overridesForRequest[row.runId]?.[f.id] ??
                                  payload.customValues?.[row.runId]?.[f.id] ??
                                  (leadReceivedField?.id === f.id
                                    ? (receivedDefaults[row.runId] ?? null)
                                    : null)
                                }
                                canEdit={
                                  // Agents work their own Meta leads but
                                  // can never reassign them (the Assigned
                                  // To cell stays read-only; reassignment
                                  // is admin-only). Everything else keeps
                                  // the existing edit permissions.
                                  canSendMessages &&
                                  !(isAgent && isMetaTable && isAssigneeField(f))
                                }
                                onSaved={handleCustomSaved}
                                members={teamMembers}
                                twoLineClamp={isWideTextColumnName(f.name)}
                                // Meta Lead Ads Tables only: clicking the
                                // follow-up cell opens the single Schedule
                                // Follow-up modal directly (no inline
                                // picker, no second dialog). Every other
                                // column — and every Flow Table — keeps
                                // the existing inline editing.
                                onEditIntercept={
                                  isMetaTable && followupFieldId !== null && f.id === followupFieldId
                                    ? () =>
                                        setScheduleModal({
                                          runId: row.runId,
                                          fieldId: f.id,
                                          name: row.name ?? null,
                                          phone: row.phone ?? null,
                                          initialValue:
                                            overridesForRequest[row.runId]?.[f.id] ??
                                            payload.customValues?.[row.runId]?.[f.id] ??
                                            null,
                                        })
                                    : undefined
                                }
                                // Meta Lead Ads Tables only: manual
                                // assignment goes through the audited
                                // endpoint (write + history). Every
                                // other column — and every Flow Table
                                // — keeps the generic save path.
                                saveAssignee={
                                  isMetaTable && isAssigneeField(f)
                                    ? async (raw) =>
                                        manualAssignMetaLead(row.runId, raw)
                                    : undefined
                                }
                              />
                            </TableCell>
                          ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <WorkspacePagination
                page={page}
                totalPages={totalPages}
                total={payload?.meta.total ?? 0}
                pageSize={pageSize}
                rowsOnPage={payload?.rows.length ?? 0}
                disabled={loading}
                onPage={setPage}
                onPageSize={(size) => selectPageSize(String(size))}
              />
              </div>
            </>
          )}
        </>
      )}

      <AddColumnDialog
        flowId={flowId}
        editing={editingField}
        open={addColumnOpen}
        onOpenChange={(v) => {
          setAddColumnOpen(v);
          if (!v) setEditingField(null);
        }}
        onSaved={() => {
          setEditingField(null);
          reloadTable();
        }}
      />

      {/* Per-table Google Sheets configuration (Meta Lead Ads tables
          only — never rendered for Flow Tables). Keyed by flow so
          switching tables loads that table's own settings. */}
      {isMetaTable && flowId ? (
        <MetaTableSheetsDialog
          key={flowId}
          flowId={flowId}
          open={sheetDialogOpen}
          onOpenChange={setSheetDialogOpen}
        />
      ) : null}

      {/* Per-table WhatsApp auto-send configuration (Meta Lead Ads
          tables only — never rendered for Flow Tables). Keyed by
          flow so switching tables loads that table's own settings. */}
      {isMetaTable && flowId ? (
        <MetaTableWhatsappDialog
          key={`wa-${flowId}`}
          flowId={flowId}
          open={whatsappDialogOpen}
          onOpenChange={setWhatsappDialogOpen}
        />
      ) : null}

      <Sheet
        open={selected !== null}
        onOpenChange={(v) => !v && setSelected(null)}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.name ?? 'Run'}</SheetTitle>
                <SheetDescription>
                  {activeFlowName ?? 'Flow run'} · started{' '}
                  {formatDateTime(selected.startedAt)}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-4 overflow-y-auto px-5 pb-6">
                {/* Meta Lead Ads sidebars skip this metadata section
                    (status badge, Phone, Submission time, Completed
                    at, Flow run ID) — the lead name, form name,
                    Answers, and everything below stay exactly as
                    before. Flow Tables keep the section untouched. */}
                {isMetaTable ? null : (
                  <>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={selected.status} />
                    </div>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Phone</dt>
                        <dd className="text-foreground font-medium">
                          {selected.phone ?? '—'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Submission time</dt>
                        <dd className="text-foreground tabular-nums">
                          {formatDateTime(selected.startedAt)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Completed at</dt>
                        <dd className="text-foreground tabular-nums">
                          {formatDateTime(selected.completedAt)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Flow run ID</dt>
                        <dd className="text-foreground max-w-48 truncate font-mono text-xs">
                          {selected.runId}
                        </dd>
                      </div>
                    </dl>
                  </>
                )}
                <div>
                  <h3 className="text-foreground text-sm font-semibold">
                    Answers
                  </h3>
                  {payload && payload.columns.some((c) => !c.system) ? (
                    <dl className="mt-2 space-y-2 text-sm">
                      {(() => {
                        // Workspace display values (agent overrides win
                        // where present; originals otherwise).
                        const display = resolveFlowAnswers(
                          selected.answers,
                          payload.flowOverrides?.[selected.runId],
                        );
                        return payload.columns
                          .filter((c) => !c.system)
                          .map((c) => (
                            <div
                              key={flowColumnRenderKey(c)}
                              className="flex justify-between gap-4"
                            >
                              <dt className="text-muted-foreground shrink-0">
                                {resolveMetaHeaderDisplayLabel({
                                  // Meta Lead Ads tables only: show the
                                  // current custom header (same override
                                  // map as the table header, so sidebar
                                  // and header can never disagree).
                                  // Every Flow Table takes the
                                  // formatting path — labels render
                                  // exactly as before.
                                  flowKind: payload.meta.kind,
                                  column: c,
                                  labels: headerLabels,
                                  formatOriginal: formatColumnLabel,
                                })}
                              </dt>
                              <dd className="text-foreground text-right break-words">
                                {display[c.key] ?? '—'}
                              </dd>
                            </div>
                          ));
                      })()}
                    </dl>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-sm">
                      No answers collected yet.
                    </p>
                  )}
                </div>
                {selected.conversationId ? (
                  <Button
                    className="w-full"
                    render={
                      <Link href={`/inbox?c=${selected.conversationId}`} />
                    }
                  >
                    <Inbox className="mr-2 h-4 w-4" />
                    Open Conversation
                  </Button>
                ) : (
                  <Button disabled className="w-full">
                    <Inbox className="mr-2 h-4 w-4" />
                    No conversation linked
                  </Button>
                )}
                {selected.contactId ? (
                  // Keyed by contact: a fresh mount (fresh loading
                  // state) per lead, no setState-in-effect needed.
                  <LeadRecordings
                    key={selected.contactId}
                    contactId={selected.contactId}
                  />
                ) : (
                  <div>
                    <h3 className="text-foreground text-sm font-semibold">
                      Call Recordings
                    </h3>
                    <p className="text-muted-foreground mt-1 text-sm">
                      No contact linked to this run.
                    </p>
                  </div>
                )}
                {flowId !== null && (
                  <TravelCrmAction
                    key={selected.runId}
                    flowId={flowId}
                    runId={selected.runId}
                    onWorkspaceSynced={handleTravelCrmSynced}
                  />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Meta-only single Schedule Follow-up modal: opened
          directly by clicking the follow-up cell (no inline
          picker, no second dialog). Flow Tables never set this
          state. */}
      {scheduleModal !== null && flowId !== null && (
        <ScheduleFollowupDialog
          open={scheduleModal !== null}
          onOpenChange={(v) => {
            if (!v) setScheduleModal(null);
          }}
          flowId={flowId}
          runId={scheduleModal.runId}
          fieldId={scheduleModal.fieldId}
          leadName={scheduleModal.name}
          leadPhone={scheduleModal.phone}
          initialValue={scheduleModal.initialValue}
          onSaved={reloadTable}
        />
      )}
    </div>
  );
}
