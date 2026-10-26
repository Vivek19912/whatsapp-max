'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  assigneeDisplayName,
  type AssigneeMember,
} from '@/lib/flows/workspace-assignee';
import { SearchableSelect } from './searchable-select';
import { WS_CONTROL_BUTTON } from './workspace-tokens';
import {
  WORKSPACE_ASSIGNEE_ALL,
  WORKSPACE_ASSIGNEE_UNASSIGNED,
  WORKSPACE_DATE_PRESETS,
  WORKSPACE_DATE_PRESET_LABELS,
  CALLS_TRIED_OPS,
  CALLS_TRIED_OP_LABELS,
  COLUMN_DATE_MODES,
  COLUMN_DATE_MODE_LABELS,
  FOLLOW_UP_MODES,
  FOLLOW_UP_MODE_LABELS,
  countActiveColumnFilters,
  emptyColumnFilters,
  isoToLocalDateTime,
  isoToLocalDay,
  resolveCallsTriedFilter,
  resolveColumnDateFilter,
  resolveFollowUpFilter,
  resolveWorkspaceDateRange,
  serializeAssigneeSelection,
  shiftCalendarDay,
  type CallsTriedOp,
  type ColumnDateMode,
  type FollowUpMode,
  type WorkspaceAssigneeSelection,
  type WorkspaceColumnFilters,
  type WorkspaceDatePreset,
  type WorkspaceDateRange,
} from '@/lib/flows/workspace-filters';

export interface AppliedDateFilter {
  preset: WorkspaceDatePreset;
  customFrom: string;
  customTo: string;
  range: WorkspaceDateRange;
}

/**
 * Live business-column metadata for the column-filter sections.
 * Select options come from each flow's own field definitions —
 * never hardcoded. An empty select list (or false flag) hides
 * that section: without the column there is nothing to filter.
 */
export interface ColumnFilterFieldOptions {
  callStatus: string[];
  followUpStatus: string[];
  lastContactDate: boolean;
  nextFollowUp: boolean;
}

type DateDraft = WorkspaceDatePreset | 'all';

type ColumnSectionKey =
  | 'callStatus'
  | 'callsTried'
  | 'followUpStatus'
  | 'lastContact'
  | 'nextFollowUp';

const COLUMN_SECTION_LABELS: Record<ColumnSectionKey, string> = {
  callStatus: 'Call Status',
  callsTried: 'No. of Calls Tried',
  followUpStatus: 'Follow-Up Status',
  lastContact: 'Last Contact Date',
  nextFollowUp: 'Next Follow-up Date & Time',
};

/**
 * Workspace Filters button + panel (Date + Assigned To + five
 * business-column sections).
 *
 * One trigger beside Search / Columns / Add Column; the panel
 * holds independent sections that combine conjunctively (AND) on
 * Apply, with OR within each multi-select section. Draft state
 * lives in the panel and only hits the table on Apply — Clear all
 * resets and applies immediately. All filters are server-side (the
 * table request carries them), so pagination, views, search,
 * visibility, pin/hide, and ordering are preserved by
 * construction.
 */
export function WorkspaceFilters({
  members,
  appliedDate,
  appliedAssignee,
  appliedColumns,
  columnOptions,
  onApply,
}: {
  /** Live roster (Settings → Team Members source). Never hardcoded. */
  members: readonly AssigneeMember[];
  appliedDate: AppliedDateFilter | null;
  appliedAssignee: WorkspaceAssigneeSelection;
  /** Applied five-column filters (null-safe: treated as empty). */
  appliedColumns: WorkspaceColumnFilters | null;
  /** Live business-column metadata (options/presence per flow). */
  columnOptions: ColumnFilterFieldOptions;
  onApply: (
    date: AppliedDateFilter | null,
    assignee: WorkspaceAssigneeSelection,
    columns: WorkspaceColumnFilters
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dateDraft, setDateDraft] = useState<DateDraft>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [assigneeDraft, setAssigneeDraft] = useState<string>(WORKSPACE_ASSIGNEE_ALL);
  const [callStatusDraft, setCallStatusDraft] = useState<string[]>([]);
  const [callsTriedOp, setCallsTriedOp] = useState<'' | CallsTriedOp>('');
  const [callsTriedValue, setCallsTriedValue] = useState('');
  const [callsTriedMin, setCallsTriedMin] = useState('');
  const [callsTriedMax, setCallsTriedMax] = useState('');
  const [followUpStatusDraft, setFollowUpStatusDraft] = useState<string[]>([]);
  const [lastContactMode, setLastContactMode] = useState<'all' | ColumnDateMode>('all');
  const [lastContactFrom, setLastContactFrom] = useState('');
  const [lastContactTo, setLastContactTo] = useState('');
  const [nextFollowUpMode, setNextFollowUpMode] = useState<'all' | FollowUpMode>('all');
  const [nextFollowUpFrom, setNextFollowUpFrom] = useState('');
  const [nextFollowUpTo, setNextFollowUpTo] = useState('');
  const [openSections, setOpenSections] = useState<ReadonlySet<ColumnSectionKey>>(
    new Set()
  );

  const applied = appliedColumns ?? emptyColumnFilters();

  // Reset the draft from the applied filters every time the panel
  // opens (same reset-on-open behavior as AddColumnDialog, but
  // event-driven rather than in an effect). Active sections reopen
  // expanded so applied selections stay visible.
  function handleOpenChange(next: boolean) {
    if (next) {
      setDateDraft(appliedDate?.preset ?? 'all');
      setCustomFrom(appliedDate?.customFrom ?? '');
      setCustomTo(appliedDate?.customTo ?? '');
      setAssigneeDraft(serializeAssigneeSelection(appliedAssignee));
      setCallStatusDraft([...applied.callStatus]);
      setCallsTriedOp(applied.callsTried?.op ?? '');
      setCallsTriedValue(
        applied.callsTried && 'value' in applied.callsTried && applied.callsTried.value !== undefined
          ? String(applied.callsTried.value)
          : ''
      );
      setCallsTriedMin(
        applied.callsTried?.op === 'between' && applied.callsTried.min !== undefined
          ? String(applied.callsTried.min)
          : ''
      );
      setCallsTriedMax(
        applied.callsTried?.op === 'between' && applied.callsTried.max !== undefined
          ? String(applied.callsTried.max)
          : ''
      );
      setFollowUpStatusDraft([...applied.followUpStatus]);
      // Restore raw inputs from normalized half-open bounds: date
      // modes keep the day itself, ranges step the exclusive `to`
      // back one day to the shown To day.
      const lc = applied.lastContact;
      setLastContactMode(lc?.mode ?? 'all');
      setLastContactFrom(lc && (lc.mode === 'date' || lc.mode === 'range' || lc.mode === 'after') && lc.from ? lc.from : '');
      setLastContactTo(
        lc && lc.mode === 'before' && lc.to
          ? lc.to
          : lc && lc.mode === 'range' && lc.to
            ? shiftCalendarDay(lc.to, -1)
            : ''
      );
      // Datetime bounds are UTC ISO instants — convert back to the
      // viewer-local inputs they resolved from.
      const nf = applied.nextFollowUp;
      setNextFollowUpMode(nf?.mode ?? 'all');
      setNextFollowUpFrom(
        nf && (nf.mode === 'date' || nf.mode === 'range' || nf.mode === 'after') && nf.from
          ? nf.mode === 'after'
            ? isoToLocalDateTime(nf.from)
            : isoToLocalDay(nf.from)
          : ''
      );
      setNextFollowUpTo(
        nf && nf.mode === 'before' && nf.to
          ? isoToLocalDateTime(nf.to)
          : nf && nf.mode === 'range' && nf.to
            // Exclusive bound is one past the shown To day (local).
            ? shiftCalendarDay(isoToLocalDay(nf.to), -1)
            : ''
      );
      const active = new Set<ColumnSectionKey>();
      if (applied.callStatus.length > 0) active.add('callStatus');
      if (applied.callsTried) active.add('callsTried');
      if (applied.followUpStatus.length > 0) active.add('followUpStatus');
      if (applied.lastContact) active.add('lastContact');
      if (applied.nextFollowUp) active.add('nextFollowUp');
      setOpenSections(active);
    }
    setOpen(next);
  }

  function toggleSection(key: ColumnSectionKey) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleMultiValue(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  const sectionCount: Record<ColumnSectionKey, number> = {
    callStatus: callStatusDraft.length,
    callsTried: callsTriedOp === '' ? 0 : 1,
    followUpStatus: followUpStatusDraft.length,
    lastContact: lastContactMode === 'all' ? 0 : 1,
    nextFollowUp: nextFollowUpMode === 'all' ? 0 : 1,
  };

  const activeCount =
    (appliedDate !== null ? 1 : 0) +
    (appliedAssignee.type !== 'all' ? 1 : 0) +
    countActiveColumnFilters(applied);

  function resolveColumns(): WorkspaceColumnFilters {
    const columns = emptyColumnFilters();
    if (callStatusDraft.length > 0) columns.callStatus = [...callStatusDraft];
    if (callsTriedOp !== '') {
      columns.callsTried = resolveCallsTriedFilter(callsTriedOp, {
        value: callsTriedValue,
        min: callsTriedMin,
        max: callsTriedMax,
      });
    }
    if (followUpStatusDraft.length > 0) columns.followUpStatus = [...followUpStatusDraft];
    if (lastContactMode !== 'all') {
      columns.lastContact = resolveColumnDateFilter(lastContactMode, {
        from: lastContactFrom,
        to: lastContactTo,
      });
    }
    if (nextFollowUpMode !== 'all') {
      columns.nextFollowUp = resolveFollowUpFilter(nextFollowUpMode, {
        from: nextFollowUpFrom,
        to: nextFollowUpTo,
      });
    }
    return columns;
  }

  function handleApply() {
    let date: AppliedDateFilter | null = null;
    if (dateDraft !== 'all') {
      try {
        const range = resolveWorkspaceDateRange(
          dateDraft,
          { from: customFrom, to: customTo },
        );
        if (!range) {
          toast.error('Choose a date option.');
          return;
        }
        date = {
          preset: dateDraft,
          customFrom: dateDraft === 'custom' ? customFrom.trim() : '',
          customTo: dateDraft === 'custom' ? customTo.trim() : '',
          range,
        };
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Invalid date range.'
        );
        return;
      }
    }
    const trimmed = assigneeDraft.trim();
    const assignee: WorkspaceAssigneeSelection =
      trimmed === '' || trimmed.toLowerCase() === WORKSPACE_ASSIGNEE_ALL
        ? { type: 'all' }
        : trimmed.toLowerCase() === WORKSPACE_ASSIGNEE_UNASSIGNED
          ? { type: 'unassigned' }
          : { type: 'member', userId: trimmed };
    let columns: WorkspaceColumnFilters;
    try {
      columns = resolveColumns();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid column filter.');
      return;
    }
    onApply(date, assignee, columns);
    setOpen(false);
  }

  function clearSection(key: ColumnSectionKey) {
    switch (key) {
      case 'callStatus':
        setCallStatusDraft([]);
        break;
      case 'callsTried':
        setCallsTriedOp('');
        setCallsTriedValue('');
        setCallsTriedMin('');
        setCallsTriedMax('');
        break;
      case 'followUpStatus':
        setFollowUpStatusDraft([]);
        break;
      case 'lastContact':
        setLastContactMode('all');
        setLastContactFrom('');
        setLastContactTo('');
        break;
      case 'nextFollowUp':
        setNextFollowUpMode('all');
        setNextFollowUpFrom('');
        setNextFollowUpTo('');
        break;
    }
  }

  function handleClearAll() {
    onApply(null, { type: 'all' }, emptyColumnFilters());
    setOpen(false);
  }

  function renderSectionHeader(key: ColumnSectionKey) {
    const count = sectionCount[key];
    const isOpen = openSections.has(key);
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => toggleSection(key)}
          aria-expanded={isOpen}
          aria-label={`${COLUMN_SECTION_LABELS[key]} filter section`}
          className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="min-w-0 flex-1 truncate text-[11px] tracking-wide uppercase">
            {COLUMN_SECTION_LABELS[key]}
          </span>
          {count > 0 && (
            <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
              {count}
            </span>
          )}
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 transition-transform',
              isOpen && 'rotate-180'
            )}
          />
        </button>
        {count > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => clearSection(key)}
            aria-label={`Clear ${COLUMN_SECTION_LABELS[key]} filter`}
            className="h-6 shrink-0 px-1.5 text-[11px]"
          >
            Clear
          </Button>
        )}
      </div>
    );
  }

  function renderMultiSelect(
    options: string[],
    selected: string[],
    onToggle: (value: string) => void,
    groupLabel: string
  ) {
    return (
      <div className="mt-1.5 grid gap-1" role="group" aria-label={groupLabel}>
        {options.map((option) => {
          const checked = selected.includes(option);
          const id = `ws-filter-${groupLabel}-${option}`;
          return (
            <label
              key={option}
              htmlFor={id}
              className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors"
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(v) => {
                  if (v === true || v === false) onToggle(option);
                }}
                aria-label={option}
              />
              <span className="min-w-0 flex-1 truncate">{option}</span>
            </label>
          );
        })}
      </div>
    );
  }

  function renderModePills<T extends string>(
    modes: readonly T[],
    labels: Record<T, string>,
    current: T | 'all',
    onPick: (mode: T) => void,
    groupLabel: string
  ) {
    return (
      <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={groupLabel}>
        {modes.map((mode) => (
          <Button
            key={mode}
            type="button"
            variant={current === mode ? 'default' : 'outline'}
            size="sm"
            onClick={() => onPick(mode)}
            className={cn(
              'h-7 rounded-full px-3 text-xs font-medium',
              current !== mode &&
                'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {labels[mode]}
          </Button>
        ))}
      </div>
    );
  }

  const assigneeOptions = useMemo(
    () => [
      { value: WORKSPACE_ASSIGNEE_ALL, label: 'All' },
      { value: WORKSPACE_ASSIGNEE_UNASSIGNED, label: 'Unassigned' },
      ...members.map((m) => ({
        value: m.user_id,
        label: assigneeDisplayName(m),
      })),
    ],
    [members]
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        className={cn(WS_CONTROL_BUTTON, "shrink-0")}
        aria-label="Filter table"
      >
        <Filter className="h-4 w-4" aria-hidden />
        Filters
        {activeCount > 0 && (
          <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
            {activeCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="max-h-[min(80vh,560px)] w-[min(92vw,400px)] overflow-y-auto p-0"
      >
        <div className="sticky top-0 z-10 border-b border-border bg-popover px-4 pt-3 pb-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-foreground text-sm font-semibold">Filters</p>
            {activeCount > 0 && (
              <span className="bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold">
                {activeCount} active
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Sections combine — every active filter applies at once.
          </p>
        </div>

        <div className="flex flex-col gap-4 px-4 py-3">
        <section aria-label="Date filter">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Date
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Date range">
            {WORKSPACE_DATE_PRESETS.map((p) => (
              <Button
                key={p}
                type="button"
                variant={dateDraft === p ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDateDraft(p)}
                className={cn(
                  'h-7 rounded-full px-3 text-xs font-medium',
                  dateDraft !== p &&
                    'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {WORKSPACE_DATE_PRESET_LABELS[p]}
              </Button>
            ))}
          </div>
          {dateDraft === 'custom' && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label htmlFor="ws-filter-from" className="text-xs">
                  From
                </Label>
                <Input
                  id="ws-filter-from"
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-8 text-[13px]"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="ws-filter-to" className="text-xs">
                  To
                </Label>
                <Input
                  id="ws-filter-to"
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-8 text-[13px]"
                />
              </div>
            </div>
          )}
        </section>

        <section aria-label="Assignee filter">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Assigned To
          </p>
          <SearchableSelect
            value={assigneeDraft}
            options={assigneeOptions}
            onChange={(v) => setAssigneeDraft(v)}
            placeholder="All"
            searchPlaceholder="Search team members…"
            emptyText="No team members match."
            ariaLabel="Filter by assignee"
            triggerClassName="mt-1.5"
            contentClassName="w-[var(--radix-popover-trigger-width)]"
          />
        </section>

        {columnOptions.callStatus.length > 0 && (
          <section aria-label="Call status filter" className="rounded-lg border border-border bg-card/50 p-2.5">
            {renderSectionHeader('callStatus')}
            {openSections.has('callStatus') &&
              renderMultiSelect(
                columnOptions.callStatus,
                callStatusDraft,
                (v) => setCallStatusDraft(toggleMultiValue(callStatusDraft, v)),
                'Call Status'
              )}
          </section>
        )}

        <section aria-label="Calls tried filter" className="rounded-lg border border-border bg-card/50 p-2.5">
          {renderSectionHeader('callsTried')}
          {openSections.has('callsTried') && (
            <div className="mt-1.5 grid gap-2">
              <div className="grid gap-1">
                <Label htmlFor="ws-filter-calls-op" className="text-xs">
                  Condition
                </Label>
                <Select
                  value={callsTriedOp === '' ? '__none__' : callsTriedOp}
                  onValueChange={(v) =>
                    setCallsTriedOp(v === '__none__' ? '' : (v as CallsTriedOp))
                  }
                >
                  <SelectTrigger
                    id="ws-filter-calls-op"
                    className="border-border bg-card h-8 w-full text-[13px]"
                    aria-label="Call count condition"
                  >
                    <SelectValue placeholder="Choose a condition" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No filter</SelectItem>
                    {CALLS_TRIED_OPS.map((op) => (
                      <SelectItem key={op} value={op}>
                        {CALLS_TRIED_OP_LABELS[op]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {callsTriedOp !== '' && callsTriedOp !== 'between' && (
                <div className="grid gap-1">
                  <Label htmlFor="ws-filter-calls-value" className="text-xs">
                    Call count
                  </Label>
                  <Input
                    id="ws-filter-calls-value"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={999}
                    value={callsTriedValue}
                    onChange={(e) => setCallsTriedValue(e.target.value)}
                    placeholder="e.g. 3"
                    className="h-8 text-[13px]"
                  />
                </div>
              )}
              {callsTriedOp === 'between' && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor="ws-filter-calls-min" className="text-xs">
                      Min calls
                    </Label>
                    <Input
                      id="ws-filter-calls-min"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={999}
                      value={callsTriedMin}
                      onChange={(e) => setCallsTriedMin(e.target.value)}
                      placeholder="e.g. 2"
                      className="h-8 text-[13px]"
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="ws-filter-calls-max" className="text-xs">
                      Max calls
                    </Label>
                    <Input
                      id="ws-filter-calls-max"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={999}
                    value={callsTriedMax}
                    onChange={(e) => setCallsTriedMax(e.target.value)}
                    placeholder="e.g. 5"
                    className="h-8 text-[13px]"
                  />
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {columnOptions.followUpStatus.length > 0 && (
          <section aria-label="Follow-up status filter" className="rounded-lg border border-border bg-card/50 p-2.5">
            {renderSectionHeader('followUpStatus')}
            {openSections.has('followUpStatus') &&
              renderMultiSelect(
                columnOptions.followUpStatus,
                followUpStatusDraft,
                (v) => setFollowUpStatusDraft(toggleMultiValue(followUpStatusDraft, v)),
                'Follow-Up Status'
              )}
          </section>
        )}

        {columnOptions.lastContactDate && (
          <section aria-label="Last contact date filter" className="rounded-lg border border-border bg-card/50 p-2.5">
            {renderSectionHeader('lastContact')}
            {openSections.has('lastContact') && (
              <div>
                {renderModePills(
                  COLUMN_DATE_MODES,
                  COLUMN_DATE_MODE_LABELS,
                  lastContactMode,
                  (mode) => setLastContactMode(mode),
                  'Last Contact Date mode'
                )}
                {(lastContactMode === 'date' || lastContactMode === 'range') && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="grid gap-1">
                      <Label htmlFor="ws-filter-lc-from" className="text-xs">
                        {lastContactMode === 'date' ? 'Date' : 'From'}
                      </Label>
                      <Input
                        id="ws-filter-lc-from"
                        type="date"
                        value={lastContactFrom}
                        onChange={(e) => setLastContactFrom(e.target.value)}
                        className="h-8 text-[13px]"
                      />
                    </div>
                    {lastContactMode === 'range' && (
                      <div className="grid gap-1">
                        <Label htmlFor="ws-filter-lc-to" className="text-xs">
                          To
                        </Label>
                      <Input
                        id="ws-filter-lc-to"
                        type="date"
                        value={lastContactTo}
                        onChange={(e) => setLastContactTo(e.target.value)}
                        className="h-8 text-[13px]"
                      />
                      </div>
                    )}
                  </div>
                )}
                {lastContactMode === 'before' && (
                  <div className="mt-2 grid gap-1">
                    <Label htmlFor="ws-filter-lc-before" className="text-xs">
                      Before date (exclusive)
                    </Label>
                    <Input
                      id="ws-filter-lc-before"
                      type="date"
                      value={lastContactTo}
                      onChange={(e) => setLastContactTo(e.target.value)}
                      className="h-8 text-[13px]"
                    />
                  </div>
                )}
                {lastContactMode === 'after' && (
                  <div className="mt-2 grid gap-1">
                    <Label htmlFor="ws-filter-lc-after" className="text-xs">
                      After date (inclusive)
                    </Label>
                    <Input
                      id="ws-filter-lc-after"
                      type="date"
                      value={lastContactFrom}
                      onChange={(e) => setLastContactFrom(e.target.value)}
                      className="h-8 text-[13px]"
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {columnOptions.nextFollowUp && (
          <section aria-label="Next follow-up filter" className="rounded-lg border border-border bg-card/50 p-2.5">
            {renderSectionHeader('nextFollowUp')}
            {openSections.has('nextFollowUp') && (
              <div>
                {renderModePills(
                  FOLLOW_UP_MODES,
                  FOLLOW_UP_MODE_LABELS,
                  nextFollowUpMode,
                  (mode) => setNextFollowUpMode(mode),
                  'Next Follow-up mode'
                )}
                {(nextFollowUpMode === 'date' || nextFollowUpMode === 'range') && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="grid gap-1">
                      <Label htmlFor="ws-filter-nf-from" className="text-xs">
                        {nextFollowUpMode === 'date' ? 'Date' : 'From'}
                      </Label>
                      <Input
                        id="ws-filter-nf-from"
                        type="date"
                        value={nextFollowUpFrom}
                        onChange={(e) => setNextFollowUpFrom(e.target.value)}
                        className="h-8 text-[13px]"
                      />
                    </div>
                    {nextFollowUpMode === 'range' && (
                      <div className="grid gap-1">
                        <Label htmlFor="ws-filter-nf-to" className="text-xs">
                          To
                        </Label>
                        <Input
                          id="ws-filter-nf-to"
                          type="date"
                          value={nextFollowUpTo}
                          onChange={(e) => setNextFollowUpTo(e.target.value)}
                          className="h-8 text-[13px]"
                        />
                      </div>
                    )}
                  </div>
                )}
                {nextFollowUpMode === 'before' && (
                  <div className="mt-2 grid gap-1">
                    <Label htmlFor="ws-filter-nf-before" className="text-xs">
                      Before date/time (exclusive)
                    </Label>
                    <Input
                      id="ws-filter-nf-before"
                      type="datetime-local"
                      value={nextFollowUpTo}
                      onChange={(e) => setNextFollowUpTo(e.target.value)}
                      className="h-8 text-[13px]"
                    />
                  </div>
                )}
                {nextFollowUpMode === 'after' && (
                  <div className="mt-2 grid gap-1">
                    <Label htmlFor="ws-filter-nf-after" className="text-xs">
                      After date/time (inclusive)
                    </Label>
                    <Input
                      id="ws-filter-nf-after"
                      type="datetime-local"
                      value={nextFollowUpFrom}
                      onChange={(e) => setNextFollowUpFrom(e.target.value)}
                      className="h-8 text-[13px]"
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        )}
        </div>

        <div className="sticky bottom-0 border-t border-border bg-popover px-4 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={handleClearAll}>
              Clear all
            </Button>
            <Button type="button" size="sm" onClick={handleApply} className="min-w-20">
              Apply{activeCount > 0 ? ` (${activeCount})` : ''}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type ActiveColumnSectionKey =
  | 'callStatus'
  | 'callsTried'
  | 'followUpStatus'
  | 'lastContact'
  | 'nextFollowUp';

/**
 * Removable chips summarizing the applied filters. Rendered above
 * the grid; each chip clears exactly its own slice through the
 * same onApply funnel as the panel, so semantics stay identical
 * (Apply-all vs clear-one paths converge).
 */
export function ActiveFilterChips({
  date,
  assignee,
  columns,
  members,
  onClearDate,
  onClearAssignee,
  onClearColumn,
  onClearAll,
}: {
  date: AppliedDateFilter | null;
  assignee: WorkspaceAssigneeSelection;
  columns: WorkspaceColumnFilters;
  members: readonly AssigneeMember[];
  onClearDate: () => void;
  onClearAssignee: () => void;
  onClearColumn: (section: ActiveColumnSectionKey) => void;
  onClearAll: () => void;
}) {
  const chips: Array<{ key: string; label: string; onClear: () => void }> = [];
  if (date) {
    const label =
      date.preset === 'custom'
        ? `Date: ${date.customFrom || '…'} → ${date.customTo || '…'}`
        : WORKSPACE_DATE_PRESET_LABELS[date.preset] ?? date.preset;
    chips.push({ key: 'date', label, onClear: onClearDate });
  }
  if (assignee.type === 'unassigned') {
    chips.push({ key: 'assignee', label: 'Assigned: Unassigned', onClear: onClearAssignee });
  } else if (assignee.type === 'member') {
    const member = members.find((m) => m.user_id === assignee.userId);
    chips.push({
      key: 'assignee',
      label: `Assigned: ${member ? assigneeDisplayName(member) : 'Member'}`,
      onClear: onClearAssignee,
    });
  }
  if (columns.callStatus.length > 0) {
    chips.push({
      key: 'callStatus',
      label: `Call status · ${columns.callStatus.length}`,
      onClear: () => onClearColumn('callStatus'),
    });
  }
  if (columns.callsTried) {
    const op = columns.callsTried;
    const detail =
      'value' in op && op.value !== undefined
        ? `${CALLS_TRIED_OP_LABELS[op.op]} ${op.value}`
        : `between ${op.min ?? ''}–${op.max ?? ''}`;
    chips.push({ key: 'callsTried', label: `Calls tried ${detail}`, onClear: () => onClearColumn('callsTried') });
  }
  if (columns.followUpStatus.length > 0) {
    chips.push({
      key: 'followUpStatus',
      label: `Follow-up · ${columns.followUpStatus.length}`,
      onClear: () => onClearColumn('followUpStatus'),
    });
  }
  if (columns.lastContact) {
    chips.push({
      key: 'lastContact',
      label: `Last contact: ${COLUMN_DATE_MODE_LABELS[columns.lastContact.mode] ?? columns.lastContact.mode}`,
      onClear: () => onClearColumn('lastContact'),
    });
  }
  if (columns.nextFollowUp) {
    chips.push({
      key: 'nextFollowUp',
      label: `Next follow-up: ${FOLLOW_UP_MODE_LABELS[columns.nextFollowUp.mode] ?? columns.nextFollowUp.mode}`,
      onClear: () => onClearColumn('nextFollowUp'),
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="bg-muted text-foreground inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-border pr-1 pl-2.5 text-xs font-medium"
        >
          <span className="min-w-0 truncate">{chip.label}</span>
          <button
            type="button"
            onClick={chip.onClear}
            aria-label={`Remove ${chip.label} filter`}
            className="hover:bg-background flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClearAll}
        className="h-7 rounded-full px-2 text-xs"
      >
        Clear all
      </Button>
    </div>
  );
}
