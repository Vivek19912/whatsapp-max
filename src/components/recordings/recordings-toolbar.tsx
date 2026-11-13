'use client';

import { useState } from 'react';
import {
  ArrowLeftRight,
  CalendarDays,
  ChevronDown,
  Link2,
  Phone,
  Search,
  Table2,
  User,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import type {
  MemberOption,
  RecordingsFilters,
  WorkspaceTableOption,
} from '@/lib/recordings/library';
import {
  formatCustomRangeLabel,
  resetRecordingsFilters,
} from '@/lib/recordings/library';
import { toDateInputValue, type CallsRangeKey } from '@/lib/calls/ranges';

/** Shared labelled-card trigger styling for every filter control. */
const CARD_CLASS =
  'h-auto min-w-[148px] gap-2.5 rounded-xl border-border bg-card px-3.5 py-2 text-left hover:bg-muted/50';

/**
 * Labelled filter dropdown card: a small icon, a permanently
 * visible muted label above the dark selected value, and the
 * trigger's own chevron on the right. The label never changes —
 * only the value line follows the selection, so the purpose of
 * every dropdown stays understandable.
 *
 * Pure presentation over the existing Select contract: values,
 * option items, and onValueChange semantics are untouched, so
 * every control still maps to the same GET /api/recordings
 * param exactly as before.
 */
function FilterSelect({
  label,
  icon,
  value,
  onValueChange,
  ariaLabel,
  formatValue,
  valueClassName,
  wideContent,
  disabled,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onValueChange: (v: string | null) => void;
  ariaLabel: string;
  formatValue: (v: string | null) => React.ReactNode;
  valueClassName?: string;
  /**
   * Wide menu for long option text (Workspace Table): the popup
   * sizes to its longest option (trigger width as the floor,
   * viewport as the cap) instead of the trigger's width, and
   * options wrap instead of ellipsis-clipping. Off by default —
   * every other filter keeps its compact anchored menu.
   */
  wideContent?: boolean;
  /**
   * Locked filter (agent-scoped salesperson): the trigger is
   * inert and dimmed. Server-side scoping is the real
   * enforcement — this only communicates it.
   */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={CARD_CLASS}
        disabled={disabled}
        title={disabled ? 'Showing only your calls' : undefined}
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
          <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
          <SelectValue
            className={`max-w-full text-[13px] font-semibold text-foreground ${valueClassName ?? ''}`}
          >
            {formatValue}
          </SelectValue>
        </span>
      </SelectTrigger>
      <SelectContent
        className={
          wideContent
            ? 'w-max min-w-(--anchor-width) max-w-[calc(100vw-2rem)]'
            : undefined
        }
      >
        {children}
      </SelectContent>
    </Select>
  );
}

const DATE_PRESETS: Array<{ key: CallsRangeKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 90 days' },
];

const CALL_TYPE_LABELS: Record<string, string> = {
  all: 'All types',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
};

const DIRECTION_LABELS: Record<string, string> = {
  all: 'All directions',
  in: 'Incoming',
  out: 'Outgoing',
  unknown: 'Unknown',
};

const STATUS_LABELS: Record<string, string> = {
  all: 'All statuses',
  linked: 'Linked',
  unlinked: 'Unlinked',
};

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD < YYYY-MM-DD check (same rule the API enforces). */
function isValidRange(fromInput: string, toInput: string): boolean {
  if (!DAY_RE.test(fromInput) || !DAY_RE.test(toInput)) return false;
  return fromInput < toInput;
}

/**
 * Date filter card: preset menu plus a unified Custom Date Range
 * picker inside ONE popover. Presets apply instantly (as before);
 * Custom reveals the grouped start/end section whose Apply
 * commits and Cancel discards — nothing applies until Apply.
 * Drafts snapshot the applied range on every open, so reopening
 * retains the current selection and Cancel never disturbs it.
 */
function DateFilterCard({
  filters,
  set,
  todayInput,
}: {
  filters: RecordingsFilters;
  set: (patch: Partial<RecordingsFilters>) => void;
  todayInput: string;
}) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');

  const appliedCustom = filters.rangeKey === 'custom';
  const display =
    appliedCustom
      ? formatCustomRangeLabel(filters.customFrom, filters.customTo)
      : (DATE_PRESETS.find((p) => p.key === filters.rangeKey)?.label ?? 'Last 30 days');

  const handleOpenChange = (next: boolean) => {
    if (next) {
      // Snapshot the applied range: reopening starts from what
      // is actually filtering, and the range section shows
      // immediately when Custom is the applied preset.
      setDraftFrom(filters.customFrom);
      setDraftTo(filters.customTo);
      setCustomOpen(appliedCustom);
    }
    setOpen(next);
  };

  const applyCustom = () => {
    if (!isValidRange(draftFrom, draftTo)) return;
    set({ rangeKey: 'custom', customFrom: draftFrom, customTo: draftTo });
    setOpen(false);
  };

  const valid = isValidRange(draftFrom, draftTo);
  const showHint = draftFrom !== '' && draftTo !== '' && !valid;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Date range"
            aria-haspopup="dialog"
            className={`flex w-fit cursor-pointer items-center justify-between border text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ${CARD_CLASS} min-w-[168px]`}
          />
        }
      >
        <span className="shrink-0 text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
          <span className="text-[11px] font-medium text-muted-foreground">Date</span>
          <span
            title={display}
            className="block max-w-full truncate text-left text-[13px] font-semibold text-foreground"
          >
            {display}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-72 p-1.5">
        <div role="menu" aria-label="Date range options" className="flex flex-col">
          {DATE_PRESETS.map((p) => {
            const active = !customOpen && filters.rangeKey === p.key;
            return (
              <button
                key={p.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  set({ rangeKey: p.key });
                  setOpen(false);
                }}
                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted ${active ? 'font-semibold text-foreground' : 'text-foreground'}`}
              >
                {p.label}
                {active ? <span aria-hidden className="text-xs text-muted-foreground">✓</span> : null}
              </button>
            );
          })}
          <button
            key="custom"
            type="button"
            role="menuitemradio"
            aria-checked={customOpen || appliedCustom}
            onClick={() => setCustomOpen(true)}
            className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted"
          >
            Custom
            {customOpen || appliedCustom ? (
              <span aria-hidden className="text-xs text-muted-foreground">✓</span>
            ) : null}
          </button>
        </div>
        {customOpen ? (
          <div className="mt-1 border-t border-border px-2 pt-2 pb-1">
            <p className="mb-2 text-xs font-semibold text-foreground">Custom date range</p>
            <div className="flex items-end gap-1.5">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
                Start date
                <Input
                  type="date"
                  aria-label="Custom start date"
                  value={draftFrom}
                  max={draftTo || todayInput}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  className="h-8 w-full min-w-0 text-[13px]"
                />
              </label>
              <span aria-hidden className="pb-2 text-xs text-muted-foreground">→</span>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
                End date
                <Input
                  type="date"
                  aria-label="Custom end date"
                  value={draftTo}
                  min={draftFrom}
                  max={todayInput}
                  onChange={(e) => setDraftTo(e.target.value)}
                  className="h-8 w-full min-w-0 text-[13px]"
                />
              </label>
            </div>
            {showHint ? (
              <p role="alert" className="mt-1.5 text-xs text-destructive">
                End date must be after the start date.
              </p>
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraftFrom('');
                  setDraftTo('');
                }}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Reset
              </button>
              <span className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                  className="h-7 px-2.5 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!valid}
                  onClick={applyCustom}
                  className="h-7 bg-blue-600 px-3 text-xs hover:bg-blue-600"
                >
                  Apply
                </Button>
              </span>
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Library toolbar: debounced text search plus real server-side
 * filters (date, type, direction, salesperson, workspace table,
 * status). Every control maps to a GET /api/recordings param —
 * nothing decorative.
 */
export function RecordingsToolbar({
  filters,
  onChange,
  nowMs,
  timeZone,
  members,
  tables,
  salespersonLocked = false,
}: {
  filters: RecordingsFilters;
  onChange: (f: RecordingsFilters) => void;
  nowMs: number;
  timeZone: string;
  members: MemberOption[];
  tables: WorkspaceTableOption[];
  /**
   * Agent view: the salesperson filter is pinned to the session
   * user and inert. Server-side scoping is the enforcement; this
   * only keeps the UI honest.
   */
  salespersonLocked?: boolean;
}) {
  const todayInput = toDateInputValue(nowMs, timeZone);

  const set = (patch: Partial<RecordingsFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search lead name, phone number..."
          aria-label="Search lead name or phone number"
          className="border-border bg-card pl-9"
        />
      </div>

      <DateFilterCard filters={filters} set={set} todayInput={todayInput} />

      <FilterSelect
        label="Call type"
        icon={<Phone className="h-4 w-4" />}
        value={filters.callType ?? 'all'}
        onValueChange={(v) => set({ callType: v === 'all' ? null : v })}
        ariaLabel="Call type"
        formatValue={(v) => CALL_TYPE_LABELS[v ?? ''] ?? v}
      >
        <SelectItem value="all">All types</SelectItem>
        <SelectItem value="phone">Phone</SelectItem>
        {/* Merged reporting category: one WhatsApp option matches
            stored whatsapp + whatsapp_business (route folds both). */}
        <SelectItem value="whatsapp">WhatsApp</SelectItem>
      </FilterSelect>

      <FilterSelect
        label="Direction"
        icon={<ArrowLeftRight className="h-4 w-4" />}
        value={filters.direction ?? 'all'}
        onValueChange={(v) => set({ direction: v === 'all' ? null : v })}
        ariaLabel="Direction"
        formatValue={(v) => DIRECTION_LABELS[v ?? ''] ?? v}
      >
        <SelectItem value="all">All directions</SelectItem>
        <SelectItem value="in">Incoming</SelectItem>
        <SelectItem value="out">Outgoing</SelectItem>
        <SelectItem value="unknown">Unknown</SelectItem>
      </FilterSelect>

      <FilterSelect
        label="Salesperson"
        icon={<User className="h-4 w-4" />}
        value={filters.uploadedBy ?? 'all'}
        onValueChange={(v) => set({ uploadedBy: v === 'all' ? null : v })}
        ariaLabel="Salesperson"
        disabled={salespersonLocked}
        formatValue={(v) =>
          v === 'all' || v == null
            ? 'All users'
            : (members.find((m) => m.user_id === v)?.label ?? 'All users')
        }
        valueClassName="max-w-[180px]"
      >
        <SelectItem value="all">All users</SelectItem>
        {members.map((m) => (
          <SelectItem key={m.user_id} value={m.user_id}>
            {m.label}
          </SelectItem>
        ))}
      </FilterSelect>

      <FilterSelect
        label="Workspace Table"
        icon={<Table2 className="h-4 w-4" />}
        value={filters.workspaceTable ?? 'all'}
        onValueChange={(v) => set({ workspaceTable: v === 'all' ? null : v })}
        ariaLabel="Workspace Table"
        formatValue={(v) =>
          v === 'all' || v == null
            ? 'All tables'
            : (tables.find((t) => t.flow_id === v)?.name ?? 'All tables')
        }
        valueClassName="max-w-[180px]"
        wideContent
      >
        <SelectItem value="all">All tables</SelectItem>
        {tables.map((t) => (
          <SelectItem
            key={t.flow_id}
            value={t.flow_id}
            title={t.name}
            // Names render in full: wrap (never ellipsis) when the
            // viewport cap binds. The item's right padding still
            // reserves the checkmark column, so wrapped text never
            // overlaps the indicator.
            className="[&>span]:min-w-0 [&>span]:shrink [&>span]:whitespace-normal [&>span]:break-words"
          >
            {t.name}
          </SelectItem>
        ))}
      </FilterSelect>

      <FilterSelect
        label="Lead status"
        icon={<Link2 className="h-4 w-4" />}
        value={filters.status ?? 'all'}
        onValueChange={(v) => set({ status: v === 'all' ? null : v })}
        ariaLabel="Lead status"
        formatValue={(v) => STATUS_LABELS[v ?? ''] ?? v}
      >
        <SelectItem value="all">All statuses</SelectItem>
        <SelectItem value="linked">Linked</SelectItem>
        <SelectItem value="unlinked">Unlinked</SelectItem>
      </FilterSelect>

      <button
        type="button"
        onClick={() => onChange(resetRecordingsFilters())}
        className="text-[13px] font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        Clear filters
      </button>
    </div>
  );
}
