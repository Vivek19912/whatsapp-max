"use client";

import { useMemo } from "react";
import { Table2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { WorkspaceSearchField } from "@/components/workspace/workspace-header";
import {
  ActiveFilterChips,
  WorkspaceFilters,
  type AppliedDateFilter,
  type ActiveColumnSectionKey,
} from "@/components/workspace/workspace-filters";
import { WorkspacePagination } from "@/components/workspace/workspace-pagination";
import { CustomCell } from "@/components/workspace/custom-cell";
import { RowActionsMenu } from "@/components/workspace/row-actions-menu";
import { DialAction } from "@/components/workspace/dial-action";
import { AllMetaAnswersCell } from "@/components/workspace/all-meta-answers-cell";
import {
  ALL_META_COLUMN_IDS,
  ALL_META_COLUMN_LABELS,
} from "@/lib/workspace/all-meta-leads";
import {
  emptyColumnFilters,
  hasActiveWorkspaceFilters,
  type WorkspaceAssigneeSelection,
  type WorkspaceColumnFilters,
} from "@/lib/flows/workspace-filters";
import { isAssigneeField, type AssigneeMember } from "@/lib/flows/workspace-assignee";
import { formatPhoneForDisplay } from "@/lib/whatsapp/phone-utils";
import type { WorkspaceField } from "@/lib/flows/workspace-fields";
import { workspaceRowNumber, type WorkspacePageSize } from "@/lib/flows/workspace-pagination";

interface AllRow {
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
  formAnswers: Array<{ key: string; question: string; answer: string; legacy: boolean }>;
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

interface AllTable {
  flowId: string;
  tableName: string;
  formName: string | null;
  enabled: boolean | null;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function assigneeName(members: AssigneeMember[], userId: string | null): string {
  if (!userId) return "Unassigned";
  const m = members.find((x) => x.user_id === userId);
  return m?.full_name?.trim() ? m.full_name.trim() : "Unassigned";
}

export function AllMetaLeadsView(props: {
  search: string;
  onSearchChange: (v: string) => void;
  appliedDate: AppliedDateFilter | null;
  appliedAssignee: WorkspaceAssigneeSelection;
  appliedColumns: WorkspaceColumnFilters;
  onApplyFilters: (
    date: AppliedDateFilter | null,
    assignee: WorkspaceAssigneeSelection,
    columns: WorkspaceColumnFilters,
  ) => void;
  teamMembers: AssigneeMember[];
  columnFilterOptions: {
    callStatus: string[];
    followUpStatus: string[];
    lastContactDate: boolean;
    nextFollowUp: boolean;
  };
  tables: AllTable[];
  tableFilter: string | null;
  onTableFilter: (flowId: string | null) => void;
  stageFilter: string[];
  onStageFilter: (stages: string[]) => void;
  typeFilter: string[];
  onTypeFilter: (types: string[]) => void;
  stageOptions: string[];
  typeOptions: string[];
  rows: AllRow[];
  total: number;
  page: number;
  pageSize: WorkspacePageSize;
  onPage: (p: number) => void;
  onPageSize: (size: WorkspacePageSize) => void;
  loading: boolean;
  error: string | null;
  hiddenIds: readonly string[];
  onRowSelect: (row: AllRow) => void;
  canSendMessages: boolean;
  isAgent: boolean;
  canManageAssignments: boolean;
  onCustomSaved: (flowId: string, fieldId: string, runId: string, value: string | null) => void;
  valueOverrides: Record<string, Record<string, string | null>>;
  customValues: Record<string, Record<string, string | null>>;
  onTogglePin: (flowId: string, runId: string) => void;
  onHideRow: (flowId: string, runId: string) => void;
  pinnedIds: ReadonlySet<string>;
  pendingIds: ReadonlySet<string>;
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
    onRowSelect,
    canSendMessages,
    isAgent,
    canManageAssignments,
    onCustomSaved,
    valueOverrides,
    customValues,
    onTogglePin,
    onHideRow,
    pinnedIds,
    pendingIds,
  } = props;

  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const isHidden = (id: string) => hidden.has(id);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Fake WorkspaceField entries for CustomCell (Assigned To, Type, Stage,
  // Call Status, Follow-up) — per-row fieldIds differ by originating flow,
  // so we construct the minimal field shape on the fly. Options come from
  // the live filter metadata where available; otherwise CustomCell falls
  // back to text rendering for unknown values (stored values stay readable).
  const fieldFor = (
    fieldId: string | null,
    name: string,
    options: string[] | null,
  ): WorkspaceField | null => {
    if (!fieldId) return null;
    return {
      id: fieldId,
      name,
      field_type: name === "Next Follow-up Date & Time" ? "datetime" : "single_select",
      position: 0,
      options,
      default_value: null,
      currency_code: null,
    } as unknown as WorkspaceField;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1 lg:max-w-sm">
            <WorkspaceSearchField
              value={search}
              onChange={onSearchChange}
              placeholder="Search by name, phone or answer..."
              ariaLabel="Search All Meta Leads"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={tableFilter ?? "all"}
              onValueChange={(v) => onTableFilter(v === "all" ? null : v)}
            >
              <SelectTrigger className="h-9 w-[220px]" aria-label="Filter by Meta Lead Ads Table">
                <SelectValue placeholder="Meta Lead Ads Table" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tables ({tables.length})</SelectItem>
                {tables.map((t) => (
                  <SelectItem key={t.flowId} value={t.flowId}>
                    {t.tableName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={stageFilter[0] ?? "all"}
              onValueChange={(v) => onStageFilter(typeof v === "string" && v !== "all" ? [v] : [])}
            >
              <SelectTrigger className="h-9 w-[180px]" aria-label="Filter by Stage">
                <SelectValue placeholder="Stage" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stages</SelectItem>
                {stageOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <WorkspaceFilters
              members={teamMembers}
              appliedDate={appliedDate}
              appliedAssignee={appliedAssignee}
              appliedColumns={appliedColumns}
              columnOptions={columnFilterOptions}
              onApply={onApplyFilters}
            />
          </div>
        </div>
        {/* Type filter (secondary, same row on wide screens) */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={typeFilter[0] ?? "all"}
            onValueChange={(v) => onTypeFilter(typeof v === "string" && v !== "all" ? [v] : [])}
          >
            <SelectTrigger className="h-9 w-[180px]" aria-label="Filter by Type">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {typeOptions.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {hasActiveWorkspaceFilters({
          dateRange: appliedDate?.range ?? null,
          assignee: appliedAssignee,
          columns: appliedColumns,
        }) ||
        tableFilter !== null ||
        stageFilter.length > 0 ||
        typeFilter.length > 0 ? (
          <ActiveFilterChips
            date={appliedDate}
            assignee={appliedAssignee}
            columns={appliedColumns}
            members={teamMembers}
            onClearDate={() => onApplyFilters(null, appliedAssignee, appliedColumns)}
            onClearAssignee={() => onApplyFilters(appliedDate, { type: "all" }, appliedColumns)}
            onClearColumn={(section: ActiveColumnSectionKey) =>
              onApplyFilters(appliedDate, appliedAssignee, {
                ...appliedColumns,
                callStatus: section === "callStatus" ? [] : appliedColumns.callStatus,
                callsTried: section === "callsTried" ? null : appliedColumns.callsTried,
                followUpStatus: section === "followUpStatus" ? [] : appliedColumns.followUpStatus,
                lastContact: section === "lastContact" ? null : appliedColumns.lastContact,
                nextFollowUp: section === "nextFollowUp" ? null : appliedColumns.nextFollowUp,
              })
            }
            onClearAll={() => {
              onApplyFilters(null, { type: "all" }, emptyColumnFilters());
              onTableFilter(null);
              onStageFilter([]);
              onTypeFilter([]);
            }}
          />
        ) : null}
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : loading && rows.length === 0 ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Table2}
          title="No matching leads"
          hint="Try widening the search or clearing the filters to see everything."
        />
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-xl border">
          <div className="max-h-[70vh] overflow-x-auto overflow-y-auto">
            <Table>
              <TableHeader className="[&_tr]:border-b-0">
                <TableRow>
                  {!isHidden(ALL_META_COLUMN_IDS.actions) && canSendMessages ? (
                    <TableHead className="sticky top-0 z-20 h-11 w-12 border-r border-b border-border px-2 align-middle">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.row) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold tabular-nums">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.row]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.name) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.name]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.phone) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.phone]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.submissionTime) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.submissionTime]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.table) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.table]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.source) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.source]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.answers) ? (
                    <TableHead className="sticky top-0 z-20 h-11 min-w-[280px] border-r border-b border-border px-3 align-middle text-[13px] font-semibold">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.answers]}
                      <span className="text-muted-foreground ml-1 font-normal" title="Every answer in full. Hover an answer for its original question.">
                        ⓘ
                      </span>
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.assignedTo) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.assignedTo]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.type) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.type]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.stage) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.stage]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.callStatus) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.callStatus]}
                    </TableHead>
                  ) : null}
                  {!isHidden(ALL_META_COLUMN_IDS.followUp) ? (
                    <TableHead className="sticky top-0 z-20 h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                      {ALL_META_COLUMN_LABELS[ALL_META_COLUMN_IDS.followUp]}
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, rowIndex) => {
                  const overrides = valueOverrides[row.runId] ?? {};
                  const stored = customValues[row.runId] ?? {};
                  const resolveStored = (fieldId: string | null, fallback: string | null) => {
                    if (!fieldId) return fallback;
                    if (fieldId in overrides) return overrides[fieldId] ?? null;
                    if (fieldId in stored) return stored[fieldId] ?? fallback;
                    return fallback;
                  };
                  return (
                    <TableRow
                      key={row.runId}
                      data-contact-id={row.contactId ?? undefined}
                      className="cursor-pointer align-top"
                      onClick={() => onRowSelect(row)}
                    >
                      {!isHidden(ALL_META_COLUMN_IDS.actions) && canSendMessages ? (
                        <TableCell className="w-12 border-r border-border px-2 align-top" onClick={(e) => e.stopPropagation()}>
                          <RowActionsMenu
                            rowLabel={row.name ?? row.phone ?? "row"}
                            isPinned={pinnedIds.has(row.runId)}
                            pending={pendingIds.has(row.runId)}
                            onTogglePin={() => onTogglePin(row.flowId, row.runId)}
                            onHide={() => onHideRow(row.flowId, row.runId)}
                          />
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.row) ? (
                        <TableCell className="border-r border-border px-4 text-sm tabular-nums text-muted-foreground align-top">
                          {workspaceRowNumber({ page, pageSize, index: rowIndex }).toLocaleString()}
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.name) ? (
                        <TableCell className="border-r border-border px-3 py-2.5 text-[13px] font-medium whitespace-nowrap align-top">
                          {row.name ?? "—"}
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.phone) ? (
                        <TableCell className="border-r border-border px-3 py-2.5 text-[13px] whitespace-nowrap align-top" onClick={(e) => e.stopPropagation()}>
                          <span className="inline-flex items-center gap-1.5">
                            <span aria-hidden className="inline-flex size-4 items-center justify-center rounded-full bg-[#25D366] text-[10px] text-white">✆</span>
                            <span>{row.phone ? formatPhoneForDisplay(row.phone) : "—"}</span>
                            {row.phone ? (
                              <DialAction phone={row.phone} contactId={row.contactId} flowId={row.flowId} runId={row.runId} />
                            ) : null}
                          </span>
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.submissionTime) ? (
                        <TableCell className="border-r border-border px-3 py-2.5 text-[13px] whitespace-nowrap tabular-nums align-top">
                          {formatDateTime(row.startedAt)}
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.table) ? (
                        <TableCell className="border-r border-border px-3 py-2.5 text-[13px] align-top">
                          <span className="inline-flex max-w-[220px] items-start gap-1.5">
                            <span aria-hidden className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400">∞</span>
                            <span className="min-w-0 break-words whitespace-normal">{row.tableName}</span>
                          </span>
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.source) ? (
                        <TableCell className="border-r border-border px-3 py-2.5 text-[13px] align-top">
                          {row.source ? (
                            <Badge variant="outline" className="font-normal whitespace-nowrap">
                              {row.source}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.answers) ? (
                        <TableCell className="min-w-[280px] border-r border-border px-3 py-2.5 align-top">
                          <AllMetaAnswersCell answers={row.formAnswers} tableName={row.tableName} />
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.assignedTo) ? (
                        <TableCell className="border-r border-border px-2.5 py-1.5 text-[13px] align-top" onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const f = fieldFor(row.fieldIds.assignedTo, "Assigned To", null);
                            if (!f) {
                              return (
                                <Badge variant="secondary" className="font-normal">
                                  {assigneeName(teamMembers, row.assignedTo)}
                                </Badge>
                              );
                            }
                            return (
                              <CustomCell
                                flowId={row.flowId}
                                runId={row.runId}
                                field={f}
                                stored={resolveStored(row.fieldIds.assignedTo, row.assignedTo)}
                                canEdit={canSendMessages && !(isAgent && !canManageAssignments)}
                                onSaved={(fieldId, runId, value) => onCustomSaved(row.flowId, fieldId, runId, value)}
                                members={teamMembers}
                              />
                            );
                          })()}
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.type) ? (
                        <TableCell className="border-r border-border px-2.5 py-1.5 text-[13px] align-top" onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const f = fieldFor(row.fieldIds.type, "Lead Type", ["Fresh", "Hot", "Warm", "Cold", "Prospect"]);
                            if (!f) {
                              return (
                                <Badge variant="secondary" className="bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-200 font-normal">
                                  {row.type ?? "Fresh"}
                                </Badge>
                              );
                            }
                            return (
                              <CustomCell
                                flowId={row.flowId}
                                runId={row.runId}
                                field={f}
                                stored={resolveStored(row.fieldIds.type, row.type ?? "Fresh")}
                                canEdit={canSendMessages}
                                onSaved={(fieldId, runId, value) => onCustomSaved(row.flowId, fieldId, runId, value)}
                                members={teamMembers}
                              />
                            );
                          })()}
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.stage) ? (
                        <TableCell className="border-r border-border px-2.5 py-1.5 text-[13px] align-top" onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const f = fieldFor(row.fieldIds.stage, "Stage", null);
                            if (!f) {
                              const isNew = (row.stage ?? "New Lead") === "New Lead";
                              return (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "font-normal whitespace-nowrap",
                                    isNew
                                      ? "border-blue-500/40 text-blue-600 dark:text-blue-400"
                                      : "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
                                  )}
                                >
                                  {row.stage ?? "New Lead"}
                                </Badge>
                              );
                            }
                            return (
                              <CustomCell
                                flowId={row.flowId}
                                runId={row.runId}
                                field={f}
                                stored={resolveStored(row.fieldIds.stage, row.stage ?? "New Lead")}
                                canEdit={canSendMessages}
                                onSaved={(fieldId, runId, value) => onCustomSaved(row.flowId, fieldId, runId, value)}
                                members={teamMembers}
                              />
                            );
                          })()}
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.callStatus) ? (
                        <TableCell className="border-r border-border px-2.5 py-1.5 text-[13px] align-top" onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const f = fieldFor(row.fieldIds.callStatus, "Call Status", null);
                            if (!f) return <span>{row.callStatus ?? "—"}</span>;
                            return (
                              <CustomCell
                                flowId={row.flowId}
                                runId={row.runId}
                                field={f}
                                stored={resolveStored(row.fieldIds.callStatus, row.callStatus)}
                                canEdit={canSendMessages}
                                onSaved={(fieldId, runId, value) => onCustomSaved(row.flowId, fieldId, runId, value)}
                                members={teamMembers}
                              />
                            );
                          })()}
                        </TableCell>
                      ) : null}
                      {!isHidden(ALL_META_COLUMN_IDS.followUp) ? (
                        <TableCell className="border-r border-border px-2.5 py-1.5 text-[13px] align-top" onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const f = fieldFor(row.fieldIds.nextFollowUp, "Next Follow-up Date & Time", null);
                            if (!f) return <span>{row.nextFollowUp ? formatDateTime(row.nextFollowUp) : "—"}</span>;
                            return (
                              <CustomCell
                                flowId={row.flowId}
                                runId={row.runId}
                                field={{ ...f, field_type: "datetime" } as WorkspaceField}
                                stored={resolveStored(row.fieldIds.nextFollowUp, row.nextFollowUp)}
                                canEdit={canSendMessages}
                                onSaved={(fieldId, runId, value) => onCustomSaved(row.flowId, fieldId, runId, value)}
                                members={teamMembers}
                              />
                            );
                          })()}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
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
      )}
    </div>
  );
}
