'use client';

import { Fragment, useMemo, useRef } from 'react';
import { Table2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import { WorkspaceSearchField } from '@/components/workspace/workspace-header';
import {
  ActiveFilterChips,
  WorkspaceFilters,
  type AppliedDateFilter,
  type ActiveColumnSectionKey,
} from '@/components/workspace/workspace-filters';
import { WorkspaceActionsMenu } from '@/components/workspace/workspace-actions-menu';
import { MetaExportButton } from '@/components/workspace/meta-export-dialog';
import { ColumnsMenu } from '@/components/workspace/columns-menu';
import { HiddenRowsMenu } from '@/components/workspace/hidden-rows-menu';
import type { HiddenRowInfo } from '@/lib/flows/workspace-row-prefs';
import { WorkspacePagination } from '@/components/workspace/workspace-pagination';
import { CustomCell } from '@/components/workspace/custom-cell';
import { LatestRecordingCell } from '@/components/workspace/latest-recording-cell';
import { RowActionsMenu } from '@/components/workspace/row-actions-menu';
import { DialAction } from '@/components/workspace/dial-action';
import { AllMetaAnswersCell } from '@/components/workspace/all-meta-answers-cell';
import {
  ALL_META_BUSINESS_SPECS,
  ALL_META_COLUMN_IDS,
  ALL_META_LEADS_ID,
  allMetaFlowColumns,
  buildAllMetaUnionColumns,
  findUnionFieldDef,
  type AllMetaUnionColumn,
} from '@/lib/workspace/all-meta-leads';
import {
  assignHeaderBackgrounds,
  headerTextColor,
} from '@/lib/flows/header-colors';
import { flowColumnVisId } from '@/lib/flows/workspace-visibility';
import { formatColumnLabel } from '@/lib/flows/column-label';
import {
  emptyColumnFilters,
  hasActiveWorkspaceFilters,
  type WorkspaceAssigneeSelection,
  type WorkspaceColumnFilters,
} from '@/lib/flows/workspace-filters';
import {
  isAssigneeField,
  type AssigneeMember,
} from '@/lib/flows/workspace-assignee';
import {
  isWorkspaceFollowupFieldName,
  type FollowupKpiBucket,
} from '@/lib/followups/workspace-link';
import { isWideTextColumnName } from '@/lib/flows/workspace-column-widths';
import {
  isWorkspaceFieldType,
  type WorkspaceField,
} from '@/lib/flows/workspace-fields';
import { formatPhoneForDisplay } from '@/lib/whatsapp/phone-utils';
import {
  workspaceRowNumber,
  type WorkspacePageSize,
} from '@/lib/flows/workspace-pagination';
import type {
  FlowTableColumn,
  LatestRecordingEntry,
} from '@/lib/flows/flow-tables';
import {
  TableHScrollbar,
  useShiftWheel,
  useTableFreezeMetrics,
} from '@/components/workspace/table-scrollbars';

export interface AllMetaViewRow {
  runId: string;
  flowId: string;
  flowName: string | null;
  tableName: string;
  metaLeadId: string | null;
  contactId: string | null;
  conversationId: string | null;
  name: string | null;
  phone: string | null;
  startedAt: string;
  source: string | null;
  formAnswers: Array<{
    key: string;
    question: string;
    answer: string;
    legacy: boolean;
  }>;
  assignedTo: string | null;
  type: string | null;
  stage: string | null;
  callStatus: string | null;
  followUpStatus: string | null;
  nextFollowUp: string | null;
  fieldIds: {
    assignedTo: string | null;
    type: string | null;
    stage: string | null;
    callStatus: string | null;
    followUpStatus: string | null;
    nextFollowUp: string | null;
  };
}

export interface AllMetaViewTable {
  flowId: string;
  tableName: string;
  formName: string | null;
  enabled: boolean | null;
}

export interface AllMetaFieldDef {
  id: string;
  name: string;
  field_type: string;
  options: string[] | null;
  default_value: string | null;
  position?: number | null;
}

type BusinessKind = 'assignedTo' | 'type' | 'stage' | 'callStatus' | 'followUp';

/** All-view business kind → AllMetaViewRow.fieldIds key. */
const BUSINESS_FIELD_ID_KEY: Record<
  BusinessKind,
  'assignedTo' | 'type' | 'stage' | 'callStatus' | 'nextFollowUp'
> = {
  assignedTo: 'assignedTo',
  type: 'type',
  stage: 'stage',
  callStatus: 'callStatus',
  followUp: 'nextFollowUp',
};

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

const SELECT_ALL_TABLES = 'all';
const SELECT_ALL_STAGES = 'all';
const SELECT_ALL_TYPES = 'all';

/**
 * Per-row Workspace field for one All-view business column.
 *
 * Each lead renders through its OWN originating flow's field
 * definition (resolved server-side per flow), so types, options,
 * and defaults match the individual table exactly. When a flow
 * lacks the field entirely, the canonical business spec stands in
 * read-only — stored values stay readable, nothing is written.
 */
function allRowField(
  row: AllMetaViewRow,
  kind: BusinessKind,
  fieldsByFlow: Record<string, AllMetaFieldDef[] | undefined>
): WorkspaceField | null {
  const realId = row.fieldIds[BUSINESS_FIELD_ID_KEY[kind]];
  if (!realId) return null;
  const def = (fieldsByFlow[row.flowId] ?? []).find((d) => d.id === realId);
  const spec = ALL_META_BUSINESS_SPECS.find((s) => s.key === kind);
  const fieldType =
    (def && isWorkspaceFieldType(def.field_type)
      ? def.field_type
      : undefined) ??
    spec?.field_type ??
    'single_select';
  return {
    id: realId,
    account_id: '',
    flow_id: row.flowId,
    name: def?.name ?? spec?.name ?? kind,
    field_type: fieldType,
    position: 0,
    options: def?.options ?? spec?.options ?? null,
    default_value: def?.default_value ?? spec?.default_value ?? null,
    currency_code: null,
    created_at: '',
    updated_at: '',
  };
}

function businessFallback(
  row: AllMetaViewRow,
  kind: BusinessKind
): string | null {
  switch (kind) {
    case 'assignedTo':
      return row.assignedTo;
    case 'type':
      return row.type;
    case 'stage':
      return row.stage;
    case 'callStatus':
      return row.callStatus;
    case 'followUp':
      return row.nextFollowUp;
  }
}

const BUSINESS_CELL_CLASS =
  'overflow-hidden border-r border-border last:border-r-0';

export function AllMetaLeadsView(props: {
  search: string;
  onSearchChange: (v: string) => void;
  appliedDate: AppliedDateFilter | null;
  appliedAssignee: WorkspaceAssigneeSelection;
  appliedColumns: WorkspaceColumnFilters;
  onApplyFilters: (
    date: AppliedDateFilter | null,
    assignee: WorkspaceAssigneeSelection,
    columns: WorkspaceColumnFilters
  ) => void;
  teamMembers: AssigneeMember[];
  columnFilterOptions: {
    callStatus: string[];
    followUpStatus: string[];
    lastContactDate: boolean;
    nextFollowUp: boolean;
  };
  tables: AllMetaViewTable[];
  tableFilter: string | null;
  onTableFilter: (flowId: string | null) => void;
  stageFilter: string[];
  onStageFilter: (stages: string[]) => void;
  typeFilter: string[];
  onTypeFilter: (types: string[]) => void;
  stageOptions: string[];
  typeOptions: string[];
  rows: AllMetaViewRow[];
  total: number;
  page: number;
  pageSize: WorkspacePageSize;
  onPage: (p: number) => void;
  onPageSize: (size: WorkspacePageSize) => void;
  loading: boolean;
  error: string | null;
  hiddenIds: readonly string[];
  onToggleVisibility: (id: string) => void;
  onShowAllColumns: () => void;
  onResetColumns: () => void;
  hiddenRows: readonly HiddenRowInfo[];
  onRestoreRow: (runId: string) => void;
  onRestoreAllHidden: () => void;
  onRowSelect: (row: AllMetaViewRow) => void;
  canSendMessages: boolean;
  isAgent: boolean;
  canManageAssignments: boolean;
  onCustomSaved: (
    flowId: string,
    fieldId: string,
    runId: string,
    value: string | null
  ) => void;
  manualAssign: (
    runId: string,
    raw: unknown,
    flowId: string
  ) => Promise<string | null>;
  onOpenFollowup: (
    row: AllMetaViewRow,
    fieldId: string,
    value: string | null
  ) => void;
  valueOverrides: Record<string, Record<string, string | null>>;
  customValues: Record<string, Record<string, string | null>>;
  fieldsByFlow: Record<string, AllMetaFieldDef[] | undefined>;
  latestRecordingByContact: Record<string, LatestRecordingEntry>;
  /**
   * CRM-eligible Workspace table ids (Settings → Meta → CRM
   * Integration → Select Workspace Tables). Null/omitted =
   * unrestricted: every row stays editable. An explicit list locks
   * the Lead Quality dropdown for rows whose ORIGINATING flow id
   * is absent — evaluated per row, never by the combined view.
   */
  crmAllowedFlowIds?: string[] | null;
  onTogglePin: (flowId: string, runId: string) => void;
  onHideRow: (flowId: string, runId: string) => void;
  pinnedIds: ReadonlySet<string>;
  pendingIds: ReadonlySet<string>;
  kpiBucket: FollowupKpiBucket | null;
  kpiEmptyTitle: string | null;
  onClearKpiBucket: () => void;
}) {
  const {
    search,
    onSearchChange,
    appliedDate,
    appliedAssignee,
    appliedColumns,
    onApplyFilters,
    teamMembers,
    columnFilterOptions,
    tables,
    tableFilter,
    onTableFilter,
    stageFilter,
    onStageFilter,
    typeFilter,
    onTypeFilter,
    stageOptions,
    typeOptions,
    rows,
    total,
    page,
    pageSize,
    onPage,
    onPageSize,
    loading,
    error,
    hiddenIds,
    onToggleVisibility,
    onShowAllColumns,
    onResetColumns,
    hiddenRows,
    onRestoreRow,
    onRestoreAllHidden,
    onRowSelect,
    canSendMessages,
    isAgent,
    canManageAssignments,
    onCustomSaved,
    manualAssign,
    onOpenFollowup,
    valueOverrides,
    customValues,
    fieldsByFlow,
    latestRecordingByContact,
    crmAllowedFlowIds,
    onTogglePin,
    onHideRow,
    pinnedIds,
    pendingIds,
    kpiBucket,
    kpiEmptyTitle,
    onClearKpiBucket,
  } = props;

  // Fixed All-view columns as shared Workspace flow-column entries
  // (spec order) plus the shared Latest Recording system column
  // and the dynamically discovered union of every other Workspace
  // field across all included flows. Rendered through the same
  // table primitives, frozen offsets, pastel header paint, and
  // cell styling as individual Meta tables.
  //
  // Union columns come from the already-batched fieldsByFlow
  // payload (no extra requests): each lead renders through its
  // OWN originating flow's field definition, so types, options,
  // and defaults match the individual table exactly. Flows
  // lacking the field render a blank cell.
  const unionColumns: AllMetaUnionColumn[] = useMemo(
    () => buildAllMetaUnionColumns(tables, fieldsByFlow),
    [tables, fieldsByFlow]
  );
  const allFlowColumns: FlowTableColumn[] = useMemo(
    () => [
      ...allMetaFlowColumns(),
      { key: 'latest_recording', label: 'Latest Recording', system: true },
      ...unionColumns.map((u): FlowTableColumn => ({
        key: u.key,
        label: u.label,
        system: false,
      })),
    ],
    [unionColumns]
  );
  const unionByKey = useMemo(
    () => new Map(unionColumns.map((u) => [u.key, u])),
    [unionColumns]
  );
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const visibleColumns = useMemo(
    () => allFlowColumns.filter((c) => !hidden.has(flowColumnVisId(c.key))),
    [allFlowColumns, hidden]
  );
  const rowVisible = !hidden.has(ALL_META_COLUMN_IDS.row);

  // Positional pastel header backgrounds over the visible order —
  // the same assignHeaderBackgrounds pass individual tables paint
  // from, so adjacent headers never share a tint.
  const headerBackgrounds = useMemo(() => {
    const entries: Array<{ visId: string; label: string }> = [];
    if (rowVisible)
      entries.push({ visId: ALL_META_COLUMN_IDS.row, label: 'Row' });
    for (const c of visibleColumns) {
      entries.push({ visId: flowColumnVisId(c.key), label: c.label });
    }
    return assignHeaderBackgrounds(entries, null);
  }, [rowVisible, visibleColumns]);
  const headStyleAt = (paintIndex: number) => {
    const background = headerBackgrounds[paintIndex];
    return {
      backgroundColor: background,
      color: headerTextColor(background),
    };
  };

  // Synced horizontal scrolling + frozen leading columns — the same
  // viewport contract as individual tables: one scroller owns the
  // truth, one bottom thumb strip, Shift+wheel support, measured
  // frozen offsets (never hardcoded).
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tableKey = `all|${page}|${pageSize}|${rows.length}|${visibleColumns.length}|${rowVisible ? 1 : 0}`;
  const getScroller = useMemo(
    () => () => viewportRef.current as HTMLElement | null,
    []
  );
  const getTable = useMemo(
    () => () => {
      const el = viewportRef.current?.querySelector('table');
      return el instanceof HTMLElement ? el : null;
    },
    []
  );
  const { noHeadRef, nameHeadRef, metrics } = useTableFreezeMetrics(
    viewportRef,
    tableKey
  );
  useShiftWheel(viewportRef, tableKey);
  const nameLeft = rowVisible ? metrics.noWidth : 0;
  const freezeReady = metrics.viewportWidth > 0;
  const frozenEdgeRight =
    'after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border after:content-[""]';
  const frozenEdgeLeft =
    'before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border before:content-[""]';
  const frozenTint = (row: { runId: string }) =>
    cn(
      'bg-card transition-colors hover:bg-muted/50',
      pinnedIds.has(row.runId) && 'bg-amber-50/70 dark:bg-amber-950/20'
    );

  const showFiltersActive =
    hasActiveWorkspaceFilters({
      dateRange: appliedDate?.range ?? null,
      assignee: appliedAssignee,
      columns: appliedColumns,
    }) ||
    tableFilter !== null ||
    stageFilter.length > 0 ||
    typeFilter.length > 0;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const rowActionPending = (flowId: string, runId: string) =>
    pendingIds.has(`${flowId}:${runId}`) || pendingIds.has(runId);

  // Header order mirrors individual pinned order (actions, row,
  // name first), then the fixed All columns in spec order.
  const headerOrder: string[] = [];
  if (canSendMessages) headerOrder.push('actions');
  if (rowVisible) headerOrder.push('row');
  for (const c of visibleColumns) headerOrder.push(c.key);

  // Paint positions index-aligned with headerBackgrounds: actions
  // consume none; row paints first when visible.
  const paintIndexById = new Map<string, number>();
  {
    let paint = 0;
    if (rowVisible) paintIndexById.set('row', paint++);
    for (const c of visibleColumns) paintIndexById.set(c.key, paint++);
  }

  const renderHeader = (id: string) => {
    const paintIndex = paintIndexById.get(id) ?? 0;
    if (id === 'actions') {
      if (!canSendMessages) return null;
      return (
        <TableHead
          key={id}
          className="border-border sticky top-0 z-20 h-16 w-12 border-r border-b px-2 align-middle"
          aria-label="Row actions"
        >
          <span className="sr-only">Actions</span>
        </TableHead>
      );
    }
    if (id === 'row') {
      if (!rowVisible) return null;
      return (
        <TableHead
          key={id}
          ref={noHeadRef}
          className={cn(
            'border-border sticky top-0 z-30 h-11 truncate border-r border-b px-3 align-middle text-[13px] font-semibold last:border-r-0',
            frozenEdgeLeft,
            frozenEdgeRight
          )}
          style={{
            ...headStyleAt(paintIndex),
            ...(freezeReady ? { left: 0 } : null),
          }}
        >
          No.
        </TableHead>
      );
    }
    const col = visibleColumns.find((c) => c.key === id);
    if (!col) return null;
    if (id === 'name') {
      return (
        <TableHead
          key={id}
          ref={nameHeadRef}
          className={cn(
            'border-border sticky top-0 z-30 h-11 truncate border-r border-b px-3 align-middle text-[13px] font-semibold whitespace-nowrap last:border-r-0',
            frozenEdgeRight
          )}
          style={
            freezeReady
              ? { ...headStyleAt(paintIndex), left: nameLeft }
              : headStyleAt(paintIndex)
          }
        >
          {formatColumnLabel(col.label)}
        </TableHead>
      );
    }
    if (id === 'phone') {
      return (
        <Fragment key={id}>
          <TableHead
            className="border-border sticky top-0 z-20 h-11 truncate border-r border-b px-3 align-middle text-[13px] font-semibold whitespace-nowrap last:border-r-0"
            style={headStyleAt(paintIndex)}
          >
            {formatColumnLabel(col.label)}
          </TableHead>
          <TableHead
            key="dial"
            scope="col"
            className="border-border [html[data-mode=dark]_&]:bg-muted sticky top-0 z-20 h-11 border-r border-b bg-[#F1F5F9] px-3 text-center align-middle text-[13px] font-semibold whitespace-nowrap last:border-r-0"
            style={{ minWidth: 112, width: 128 }}
          >
            <span className="block whitespace-nowrap">Dial</span>
          </TableHead>
        </Fragment>
      );
    }
    return (
      <TableHead
        key={id}
        className="border-border sticky top-0 z-20 h-11 truncate border-r border-b px-3 align-middle text-[13px] font-semibold whitespace-nowrap last:border-r-0"
        style={headStyleAt(paintIndex)}
      >
        {formatColumnLabel(col.label)}
      </TableHead>
    );
  };

  const renderBody = (
    columnKey: string,
    row: AllMetaViewRow,
    rowIndex: number
  ) => {
    const overrides = valueOverrides[row.runId] ?? {};
    const stored = customValues[row.runId] ?? {};
    const resolveStored = (fieldId: string | null, fallback: string | null) => {
      if (!fieldId) return fallback;
      if (fieldId in overrides) return overrides[fieldId] ?? null;
      if (fieldId in stored) return stored[fieldId] ?? fallback;
      return fallback;
    };

    if (columnKey === 'actions') {
      if (!canSendMessages) return null;
      return (
        <TableCell
          key={columnKey}
          className="border-border w-12 border-r px-2 last:border-r-0"
        >
          <RowActionsMenu
            rowLabel={row.name ?? row.phone ?? 'row'}
            isPinned={pinnedIds.has(row.runId)}
            pending={rowActionPending(row.flowId, row.runId)}
            onTogglePin={() => onTogglePin(row.flowId, row.runId)}
            onHide={() => onHideRow(row.flowId, row.runId)}
          />
        </TableCell>
      );
    }
    if (columnKey === 'row') {
      if (!rowVisible) return null;
      return (
        <TableCell
          key={columnKey}
          className={cn(
            'border-border text-muted-foreground border-r px-4 text-sm tabular-nums last:border-r-0',
            freezeReady && 'sticky left-0 z-[1]',
            frozenEdgeLeft,
            frozenEdgeRight,
            frozenTint(row)
          )}
          style={freezeReady ? { left: 0 } : undefined}
        >
          {workspaceRowNumber({
            page,
            pageSize,
            index: rowIndex,
          }).toLocaleString()}
        </TableCell>
      );
    }
    if (columnKey === 'name') {
      return (
        <TableCell
          key={columnKey}
          className={cn(
            'border-border max-w-56 truncate border-r px-2.5 py-1.5 text-[13px] last:border-r-0',
            freezeReady && 'sticky z-[1]',
            frozenEdgeRight,
            frozenTint(row)
          )}
          style={freezeReady ? { left: nameLeft } : undefined}
        >
          {row.name ?? ''}
        </TableCell>
      );
    }
    if (columnKey === 'phone') {
      return (
        <Fragment key={columnKey}>
          <TableCell className="border-border max-w-56 truncate border-r px-2.5 py-1.5 text-[13px] last:border-r-0">
            {formatPhoneForDisplay(row.phone)}
          </TableCell>
          <TableCell
            key="dial"
            className="border-border border-r px-2 py-1.5 text-center align-middle whitespace-nowrap last:border-r-0"
            style={{ minWidth: 112, width: 128 }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="inline-flex justify-center">
              <DialAction
                phone={row.phone}
                contactId={row.contactId}
                flowId={row.flowId}
                runId={row.runId}
              />
            </span>
          </TableCell>
        </Fragment>
      );
    }
    if (columnKey === 'submission_time') {
      return (
        <TableCell
          key={columnKey}
          className="border-border max-w-56 truncate border-r px-2.5 py-1.5 text-[13px] tabular-nums last:border-r-0"
        >
          {formatDateTime(row.startedAt)}
        </TableCell>
      );
    }
    if (columnKey === 'meta_table' || columnKey === 'meta_lead_source') {
      const value =
        columnKey === 'meta_table' ? (row.tableName ?? '') : (row.source ?? '');
      return (
        <TableCell
          key={columnKey}
          className="border-border max-w-56 truncate border-r px-2.5 py-1.5 text-[13px] last:border-r-0"
        >
          {value}
        </TableCell>
      );
    }
    if (columnKey === 'form_answers') {
      return (
        <TableCell
          key={columnKey}
          className="border-border border-r px-2.5 py-1.5 text-[13px] last:border-r-0"
        >
          <AllMetaAnswersCell
            answers={row.formAnswers}
            tableName={row.tableName}
          />
        </TableCell>
      );
    }
    if (columnKey === 'latest_recording') {
      return (
        <TableCell
          key={columnKey}
          className="border-border max-w-56 truncate border-r px-2.5 py-1.5 text-[13px] last:border-r-0"
        >
          <LatestRecordingCell
            entry={latestRecordingByContact[row.contactId ?? ''] ?? null}
          />
        </TableCell>
      );
    }
    const unionCol = unionByKey.get(columnKey);
    if (unionCol) {
      // Union column: this lead renders through its OWN
      // originating flow's field definition (types, options, and
      // defaults match the individual table exactly). Flows
      // without the field render a blank cell — never another
      // flow's value. Saves reuse the shared CustomCell path
      // keyed by the originating (flowId, fieldId).
      const def = findUnionFieldDef(fieldsByFlow[row.flowId], unionCol);
      const field: WorkspaceField | null =
        def && isWorkspaceFieldType(def.field_type)
          ? {
              id: def.id,
              account_id: '',
              flow_id: row.flowId,
              name: def.name,
              field_type: def.field_type,
              position: 0,
              options: def.options ?? null,
              default_value: def.default_value ?? null,
              currency_code: null,
              created_at: '',
              updated_at: '',
            }
          : null;
      const realFieldId = def?.id ?? null;
      const canEditCell =
        canSendMessages &&
        !(
          isAgent &&
          isAssigneeField({ name: field?.name ?? '' }) &&
          !canManageAssignments
        );
      const storedValue = resolveStored(realFieldId, null);
      if (!field || !canEditCell) {
        return (
          <TableCell
            key={columnKey}
            className={cn(
              BUSINESS_CELL_CLASS,
              'max-w-56 px-2.5 py-1.5 text-[13px]'
            )}
          >
            {field ? (
              <CustomCell
                flowId={row.flowId}
                runId={row.runId}
                field={field}
                stored={storedValue}
                canEdit={false}
                onSaved={(fieldId, runId, value) =>
                  onCustomSaved(row.flowId, fieldId, runId, value)
                }
                members={teamMembers}
                twoLineClamp={isWideTextColumnName(field.name)}
                crmAllowedFlowIds={crmAllowedFlowIds}
              />
            ) : (
              <span>{storedValue ?? ''}</span>
            )}
          </TableCell>
        );
      }
      return (
        <TableCell
          key={columnKey}
          className={cn(
            BUSINESS_CELL_CLASS,
            'max-w-56 px-2.5 py-1.5 text-[13px]'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <CustomCell
            flowId={row.flowId}
            runId={row.runId}
            field={field}
            stored={storedValue}
            canEdit={canEditCell}
            onSaved={(fieldId, runId, value) =>
              onCustomSaved(row.flowId, fieldId, runId, value)
            }
            members={teamMembers}
            twoLineClamp={isWideTextColumnName(field.name)}
            crmAllowedFlowIds={crmAllowedFlowIds}
            onEditIntercept={
              isWorkspaceFollowupFieldName(field.name)
                ? () => onOpenFollowup(row, field.id, storedValue)
                : undefined
            }
            saveAssignee={
              isAssigneeField(field)
                ? async (raw) => manualAssign(row.runId, raw, row.flowId)
                : undefined
            }
          />
        </TableCell>
      );
    }
    const businessKind =
      columnKey === 'all_assigned_to'
        ? ('assignedTo' as const)
        : columnKey === 'all_lead_type'
          ? ('type' as const)
          : columnKey === 'all_stage'
            ? ('stage' as const)
            : columnKey === 'all_call_status'
              ? ('callStatus' as const)
              : columnKey === 'all_follow_up'
                ? ('followUp' as const)
                : null;
    if (businessKind !== null) {
      const field = allRowField(row, businessKind, fieldsByFlow);
      const realFieldId = row.fieldIds[BUSINESS_FIELD_ID_KEY[businessKind]];
      const canEditCell =
        canSendMessages &&
        !(
          isAgent &&
          isAssigneeField({ name: field?.name ?? '' }) &&
          !canManageAssignments
        );
      // Flows missing the field render read-only (stored value or
      // blank) — never a write path that could 404.
      if (!field || !canEditCell) {
        const shown =
          resolveStored(realFieldId, businessFallback(row, businessKind)) ?? '';
        return (
          <TableCell
            key={columnKey}
            className={cn(
              BUSINESS_CELL_CLASS,
              'max-w-56 px-2.5 py-1.5 text-[13px]'
            )}
          >
            {field ? (
              <CustomCell
                flowId={row.flowId}
                runId={row.runId}
                field={field}
                stored={resolveStored(
                  realFieldId,
                  businessFallback(row, businessKind)
                )}
                canEdit={false}
                onSaved={(fieldId, runId, value) =>
                  onCustomSaved(row.flowId, fieldId, runId, value)
                }
                members={teamMembers}
                twoLineClamp={isWideTextColumnName(field.name)}
                crmAllowedFlowIds={crmAllowedFlowIds}
              />
            ) : (
              <span>{shown}</span>
            )}
          </TableCell>
        );
      }
      return (
        <TableCell
          key={columnKey}
          className={cn(
            BUSINESS_CELL_CLASS,
            'max-w-56 px-2.5 py-1.5 text-[13px]'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <CustomCell
            flowId={row.flowId}
            runId={row.runId}
            field={field}
            stored={resolveStored(
              realFieldId,
              businessFallback(row, businessKind)
            )}
            canEdit={canEditCell}
            onSaved={(fieldId, runId, value) =>
              onCustomSaved(row.flowId, fieldId, runId, value)
            }
            members={teamMembers}
            twoLineClamp={isWideTextColumnName(field.name)}
            crmAllowedFlowIds={crmAllowedFlowIds}
            onEditIntercept={
              isWorkspaceFollowupFieldName(field.name)
                ? () =>
                    onOpenFollowup(
                      row,
                      field.id,
                      resolveStored(
                        realFieldId,
                        businessFallback(row, businessKind)
                      )
                    )
                : undefined
            }
            saveAssignee={
              isAssigneeField(field)
                ? async (raw) => manualAssign(row.runId, raw, row.flowId)
                : undefined
            }
          />
        </TableCell>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-row items-center gap-2">
        <div className="min-w-0 flex-1 lg:max-w-sm">
          <WorkspaceSearchField
            value={search}
            onChange={onSearchChange}
            placeholder="Search by name, phone or answer..."
            ariaLabel="Search All Meta Leads"
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:ml-auto">
          <Select
            value={tableFilter ?? SELECT_ALL_TABLES}
            onValueChange={(v) =>
              onTableFilter(v === SELECT_ALL_TABLES ? null : v)
            }
          >
            <SelectTrigger
              className="h-9 w-[200px] text-sm"
              aria-label="Filter by Meta Lead Ads Table"
            >
              <SelectValue placeholder="All tables" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_ALL_TABLES}>
                All tables{tables.length > 0 ? ` (${tables.length})` : ''}
              </SelectItem>
              {tables.map((t) => (
                <SelectItem key={t.flowId} value={t.flowId}>
                  {t.tableName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={stageFilter[0] ?? SELECT_ALL_STAGES}
            onValueChange={(v) =>
              onStageFilter(
                typeof v === 'string' && v !== SELECT_ALL_STAGES ? [v] : []
              )
            }
          >
            <SelectTrigger
              className="h-9 w-[160px] text-sm"
              aria-label="Filter by Stage"
            >
              <SelectValue placeholder="All stages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_ALL_STAGES}>All stages</SelectItem>
              {stageOptions.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={typeFilter[0] ?? SELECT_ALL_TYPES}
            onValueChange={(v) =>
              onTypeFilter(
                typeof v === 'string' && v !== SELECT_ALL_TYPES ? [v] : []
              )
            }
          >
            <SelectTrigger
              className="h-9 w-[150px] text-sm"
              aria-label="Filter by Type"
            >
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_ALL_TYPES}>All types</SelectItem>
              {typeOptions.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <MetaExportButton
            tableId={ALL_META_LEADS_ID}
            tableName="All_Meta_Leads"
            isAllView
            forms={tables.map((t) => ({
              flowId: t.flowId,
              tableName: t.tableName,
            }))}
            teamMembers={teamMembers}
          />
          <WorkspaceActionsMenu
            filters={
              <WorkspaceFilters
                members={teamMembers}
                appliedDate={appliedDate}
                appliedAssignee={appliedAssignee}
                appliedColumns={appliedColumns}
                columnOptions={columnFilterOptions}
                onApply={onApplyFilters}
              />
            }
            columns={
              <ColumnsMenu
                flowId={ALL_META_LEADS_ID}
                flowColumns={allFlowColumns}
                customFields={[]}
                hiddenIds={hiddenIds}
                onToggleVisibility={onToggleVisibility}
                onShowAll={onShowAllColumns}
                onReset={onResetColumns}
                onEditField={() => {}}
                onChanged={() => {}}
                headerColors={{}}
                canCustomizeColors={false}
                headerColorMap={{}}
              />
            }
            hiddenRows={
              canSendMessages ? (
                <HiddenRowsMenu
                  hidden={hiddenRows}
                  pendingIds={pendingIds}
                  restoreAllPending={pendingIds.has('__all__')}
                  onRestore={onRestoreRow}
                  onRestoreAll={onRestoreAllHidden}
                />
              ) : undefined
            }
            canAddColumn={false}
            onAddColumn={() => {}}
            showAssignment={false}
            onOpenAssignment={() => {}}
            showTravelSettings={false}
            onOpenTravelSettings={() => {}}
          />
        </div>
      </div>
      {showFiltersActive ? (
        <ActiveFilterChips
          date={appliedDate}
          assignee={appliedAssignee}
          columns={appliedColumns}
          members={teamMembers}
          onClearDate={() =>
            onApplyFilters(null, appliedAssignee, appliedColumns)
          }
          onClearAssignee={() =>
            onApplyFilters(appliedDate, { type: 'all' }, appliedColumns)
          }
          onClearColumn={(section: ActiveColumnSectionKey) =>
            onApplyFilters(appliedDate, appliedAssignee, {
              ...appliedColumns,
              callStatus:
                section === 'callStatus' ? [] : appliedColumns.callStatus,
              callsTried:
                section === 'callsTried' ? null : appliedColumns.callsTried,
              followUpStatus:
                section === 'followUpStatus'
                  ? []
                  : appliedColumns.followUpStatus,
              lastContact:
                section === 'lastContact' ? null : appliedColumns.lastContact,
              nextFollowUp:
                section === 'nextFollowUp' ? null : appliedColumns.nextFollowUp,
            })
          }
          onClearAll={() => {
            onApplyFilters(null, { type: 'all' }, emptyColumnFilters());
            onTableFilter(null);
            onStageFilter([]);
            onTypeFilter([]);
          }}
        />
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : loading && rows.length === 0 ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        kpiBucket !== null && kpiEmptyTitle !== null ? (
          <div className="flex flex-col items-center gap-2">
            <EmptyState
              icon={Table2}
              title={kpiEmptyTitle}
              hint="Try a different follow-up bucket — or clear the filter to see everything."
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearKpiBucket}
              className="h-7 px-2 text-xs"
            >
              Clear filter
            </Button>
          </div>
        ) : showFiltersActive ? (
          <EmptyState
            icon={Table2}
            title="No matching runs"
            hint="Try widening the search or clearing the filters to see everything."
          />
        ) : (
          <EmptyState
            icon={Table2}
            title="No runs yet"
            hint="New flow runs appear here automatically."
          />
        )
      ) : (
        <>
          <div className="border-border bg-card overflow-hidden rounded-xl border">
            <div
              ref={viewportRef}
              className="workspace-table-viewport max-h-[70vh] overflow-x-hidden overflow-y-auto"
            >
              <Table>
                <TableHeader className="[&_tr]:border-b-0">
                  <TableRow>
                    {headerOrder.map((id) => renderHeader(id))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, rowIndex) => (
                    <TableRow
                      key={row.runId}
                      data-contact-id={row.contactId ?? undefined}
                      className={cn(
                        'cursor-pointer',
                        pinnedIds.has(row.runId) &&
                          'bg-amber-50/70 dark:bg-amber-950/20'
                      )}
                      onClick={() => onRowSelect(row)}
                    >
                      {headerOrder.map((id) => (
                        <Fragment key={`${row.runId}:${id}`}>
                          {renderBody(id, row, rowIndex)}
                        </Fragment>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="border-border bg-card border-t">
              <TableHScrollbar
                getScroller={getScroller}
                getTable={getTable}
                contentKey={tableKey}
                label="Bottom table scrollbar"
                className="px-2 py-1"
              />
            </div>
            <WorkspacePagination
              page={page}
              totalPages={totalPages}
              total={total}
              pageSize={pageSize}
              rowsOnPage={rows.length}
              disabled={loading}
              onPage={onPage}
              onPageSize={onPageSize}
            />
          </div>
        </>
      )}
    </div>
  );
}
