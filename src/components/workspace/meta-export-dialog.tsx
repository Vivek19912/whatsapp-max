'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AssigneeMember } from '@/lib/flows/workspace-assignee';
import { assigneeDisplayName } from '@/lib/flows/workspace-assignee';
import {
  EXPORT_DATE_PRESETS,
  EXPORT_DATE_PRESET_LABELS,
  isExportDatePreset,
  resolveExportDateRange,
  type ExportDatePreset,
} from '@/lib/meta-leads-export/date-presets';
import {
  applyGroupMaster,
  deselectAllColumns,
  orderedSelectedKeys,
  selectAllColumns,
  toggleColumnKey,
  type ExportColumnGroup,
  type SelectableExportColumn,
} from '@/lib/meta-leads-export/column-selection';
import { ALL_META_LEADS_ID } from '@/lib/workspace/all-meta-leads';
import { MetaExportColumnsStep } from './meta-export-columns-step';

interface MetaExportForm {
  flowId: string;
  tableName: string;
}

interface MetaExportDialogProps {
  tableId: string | null;
  tableName: string;
  isAllView: boolean;
  forms: MetaExportForm[];
  teamMembers: AssigneeMember[];
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function MetaExportButton(props: MetaExportDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 gap-1.5"
        onClick={() => setOpen(true)}
        aria-label="Export Excel"
        title="Export Excel"
      >
        <Download className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Export Excel</span>
      </Button>
      {open ? (
        <MetaExportDialog {...props} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}

function MetaExportDialog(
  props: MetaExportDialogProps & {
    open: boolean;
    onOpenChange: (v: boolean) => void;
  }
) {
  const {
    tableId,
    tableName,
    isAllView,
    forms,
    teamMembers,
    open,
    onOpenChange,
  } = props;
  const [preset, setPreset] = useState<ExportDatePreset>('last30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [formFilter, setFormFilter] = useState<string>('__all');
  const [assignee, setAssignee] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [columns, setColumns] = useState<
    readonly SelectableExportColumn[] | null
  >(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [colSearch, setColSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<
    Record<ExportColumnGroup, boolean>
  >({ basic: true, management: true });
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loadingColumns, setLoadingColumns] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormFilter('__all');
    setAssignee('all');
    setSearch('');
    setPreset('last30');
    setCustomFrom('');
    setCustomTo('');
    setStep(1);
    setColumns(null);
    setSelected(new Set());
    setColSearch('');
    setExpandedGroups({ basic: true, management: true });
    setLoadedScope(null);
    setLoadingColumns(false);
  }, [open, tableId]);

  const canExport = useMemo(() => {
    if (!tableId) return false;
    if (preset === 'custom' && (!customFrom || !customTo)) return false;
    return !busy && !loadingColumns;
  }, [tableId, preset, customFrom, customTo, busy, loadingColumns]);

  const clearAll = useCallback(() => {
    setPreset('last30');
    setCustomFrom('');
    setCustomTo('');
    setFormFilter('__all');
    setAssignee('all');
    setSearch('');
  }, []);

  // Step-2 scope: the selected form (All view) or the single table.
  // Changing it invalidates the loaded column list.
  const columnScopeKey = useMemo(() => {
    if (!tableId) return null;
    if (isAllView && formFilter !== '__all') return `${tableId}|${formFilter}`;
    return `${tableId}|`;
  }, [tableId, isAllView, formFilter]);

  const resolveFilterRange = useCallback(() => {
    if (!isExportDatePreset(preset)) {
      toast.error('Choose a valid date range.');
      return null;
    }
    try {
      const range = resolveExportDateRange(preset, {
        from: customFrom || null,
        to: customTo || null,
      });
      return { from: range?.from ?? null, to: range?.to ?? null };
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid date range.');
      return null;
    }
  }, [preset, customFrom, customTo]);

  const buildFilterParams = useCallback(
    (dateFrom: string | null, dateTo: string | null) => {
      const qs = new URLSearchParams({ tableId: tableId ?? '' });
      if (isAllView && formFilter !== '__all') qs.set('formId', formFilter);
      if (dateFrom && dateTo) {
        qs.set('dateFrom', dateFrom);
        qs.set('dateTo', dateTo);
      }
      if (assignee && assignee !== 'all') qs.set('assignee', assignee);
      if (search.trim()) qs.set('search', search.trim().slice(0, 120));
      return qs;
    },
    [tableId, isAllView, formFilter, assignee, search]
  );

  const handleNext = useCallback(async () => {
    if (!tableId || !columnScopeKey) return;
    const range = resolveFilterRange();
    if (!range) return;
    // Returning from Step 2 reuses the loaded columns (filters and
    // selection preserved) unless the table/form scope changed.
    if (columns && loadedScope === columnScopeKey) {
      setStep(2);
      return;
    }
    setLoadingColumns(true);
    try {
      const qs = buildFilterParams(range.from, range.to);
      qs.set('columns', '1');
      const res = await fetch(`/api/workspace/meta-export?${qs.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          (data as { error?: string } | null)?.error ??
            `Could not load columns (${res.status}).`
        );
      }
      const data = (await res.json().catch(() => null)) as {
        columns?: Array<{ key?: unknown; header?: unknown; group?: unknown }>;
      } | null;
      const list: SelectableExportColumn[] = Array.isArray(data?.columns)
        ? data.columns.flatMap((c) => {
            if (typeof c?.key !== 'string' || c.key === '') return [];
            return [
              {
                key: c.key,
                header:
                  typeof c.header === 'string' && c.header !== ''
                    ? c.header
                    : c.key,
                group: c.group === 'management' ? 'management' : 'basic',
              } as const,
            ];
          })
        : [];
      setColumns(list);
      setSelected(selectAllColumns(list));
      setColSearch('');
      setLoadedScope(columnScopeKey);
      setStep(2);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not load columns.'
      );
    } finally {
      setLoadingColumns(false);
    }
  }, [
    tableId,
    columnScopeKey,
    columns,
    loadedScope,
    resolveFilterRange,
    buildFilterParams,
  ]);

  const handleBack = useCallback(() => {
    setStep(1);
  }, []);

  const handleToggleColumn = useCallback((key: string) => {
    setSelected((prev) => toggleColumnKey(prev, key));
  }, []);

  const handleToggleGroup = useCallback(
    (group: ExportColumnGroup) => {
      setSelected((prev) => {
        if (!columns) return prev;
        const keys = columns.filter((c) => c.group === group).map((c) => c.key);
        return applyGroupMaster(prev, keys);
      });
    },
    [columns]
  );

  const handleSelectAll = useCallback(() => {
    if (!columns) return;
    setSelected(selectAllColumns(columns));
  }, [columns]);

  const handleDeselectAll = useCallback(() => {
    setSelected(deselectAllColumns());
  }, []);

  const handleToggleExpanded = useCallback((group: ExportColumnGroup) => {
    setExpandedGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  }, []);

  const handleExport = useCallback(async () => {
    if (!tableId || !columns) return;
    const ordered = orderedSelectedKeys(columns, selected);
    if (ordered.length === 0) {
      toast.error('Select at least one column to include in the Excel file.');
      return;
    }
    const range = resolveFilterRange();
    if (!range) return;
    const { from: dateFrom, to: dateTo } = range;
    setBusy(true);
    try {
      const qs = buildFilterParams(dateFrom, dateTo);
      for (const key of ordered) qs.append('col', key);
      const res = await fetch(`/api/workspace/meta-export?${qs.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          (data as { error?: string } | null)?.error ??
            `Export failed (${res.status}).`
        );
      }
      const blob = await res.blob();
      const dispo = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(dispo);
      const filename = match?.[1] ?? 'Meta_Leads.xlsx';
      downloadBlob(blob, filename);
      toast.success(`Excel downloaded — ${filename}`);
      const unresolved = res.headers.get('X-Export-Unresolved-Assignees');
      if (unresolved) {
        toast.warning(
          `${unresolved} assigned lead(s) reference team members no longer on the roster — shown as Unknown.`
        );
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }, [
    tableId,
    columns,
    selected,
    resolveFilterRange,
    buildFilterParams,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          step === 2
            ? 'max-h-[90vh] overflow-y-auto sm:max-w-3xl'
            : 'max-h-[90vh] overflow-y-auto sm:max-w-lg'
        }
        aria-label="Export Excel"
      >
        <DialogHeader>
          <DialogTitle>Export Excel</DialogTitle>
          {step === 1 ? (
            <DialogDescription>
              {isAllView || tableId === ALL_META_LEADS_ID
                ? `All Meta Leads — one worksheet combining every form. Filters narrow Submission Time and lead attributes.`
                : `${tableName} — exports only this table's leads into one worksheet.`}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {step === 1 ? (
          <>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="meta-export-date">Submission Time</Label>
                <Select
                  value={preset}
                  onValueChange={(v: string | null) => {
                    if (isExportDatePreset(v)) setPreset(v);
                  }}
                >
                  <SelectTrigger id="meta-export-date" className="h-9">
                    <SelectValue placeholder="Date range" />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPORT_DATE_PRESETS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {EXPORT_DATE_PRESET_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {preset === 'custom' ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1">
                      <Label htmlFor="meta-export-from">From</Label>
                      <Input
                        id="meta-export-from"
                        type="date"
                        value={customFrom}
                        onChange={(e) => setCustomFrom(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor="meta-export-to">To</Label>
                      <Input
                        id="meta-export-to"
                        type="date"
                        value={customTo}
                        onChange={(e) => setCustomTo(e.target.value)}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              {isAllView ? (
                <div className="grid gap-2">
                  <Label htmlFor="meta-export-form">Form</Label>
                  <Select
                    value={formFilter}
                    onValueChange={(v: string | null) => {
                      if (typeof v === 'string') setFormFilter(v);
                    }}
                  >
                    <SelectTrigger id="meta-export-form" className="h-9">
                      <SelectValue placeholder="All forms" />
                    </SelectTrigger>
                    <SelectContent
                      className="max-w-[calc(100vw-2rem)]"
                      style={{
                        // Size to the longest form name instead of the
                        // trigger: never narrower than the trigger, never
                        // wider than the viewport. Inline style wins over
                        // the base `w-(--anchor-width)` class
                        // deterministically.
                        width: 'max-content',
                        minWidth: 'var(--anchor-width)',
                        maxWidth: 'calc(100vw - 2rem)',
                      }}
                    >
                      <SelectItem value="__all">
                        All Forms{forms.length > 0 ? ` (${forms.length})` : ''}
                      </SelectItem>
                      {forms.map((f) => (
                        <SelectItem
                          key={f.flowId}
                          value={f.flowId}
                          title={f.tableName}
                          className="[&>span]:min-w-0 [&>span]:shrink [&>span]:break-words [&>span]:whitespace-normal"
                        >
                          {f.tableName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div className="grid gap-2">
                <Label htmlFor="meta-export-assignee">Assignment</Label>
                <Select
                  value={assignee}
                  onValueChange={(v: string | null) => {
                    if (typeof v === 'string') setAssignee(v);
                  }}
                >
                  <SelectTrigger id="meta-export-assignee" className="h-9">
                    <SelectValue placeholder="All agents" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Agents</SelectItem>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {teamMembers.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {assigneeDisplayName(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="meta-export-search">Search</Label>
                <Input
                  id="meta-export-search"
                  placeholder="Name, phone, answer…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  maxLength={120}
                />
              </div>
            </div>

            <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearAll}
                disabled={busy || loadingColumns}
              >
                Clear All
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  disabled={busy || loadingColumns}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleNext}
                  disabled={!canExport || loadingColumns}
                >
                  {loadingColumns ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  )}
                  {loadingColumns ? 'Loading columns…' : 'Next: Select Columns'}
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : columns ? (
          <MetaExportColumnsStep
            columns={columns}
            selected={selected}
            search={colSearch}
            onSearchChange={setColSearch}
            expanded={expandedGroups}
            onToggleExpanded={handleToggleExpanded}
            onToggleColumn={handleToggleColumn}
            onToggleGroup={handleToggleGroup}
            onSelectAll={handleSelectAll}
            onDeselectAll={handleDeselectAll}
            onBack={handleBack}
            onCancel={() => onOpenChange(false)}
            onDownload={handleExport}
            busy={busy}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
