'use client';

import {
  ArrowLeftRight,
  CalendarDays,
  Link2,
  Phone,
  Search,
  User,
} from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MemberOption, RecordingsFilters } from '@/lib/recordings/library';
import { resetRecordingsFilters } from '@/lib/recordings/library';
import { toDateInputValue, type CallsRangeKey } from '@/lib/calls/ranges';

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
  children,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onValueChange: (v: string | null) => void;
  ariaLabel: string;
  formatValue: (v: string | null) => React.ReactNode;
  valueClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        className="h-auto min-w-[136px] gap-2.5 rounded-xl border-border bg-card px-3 py-1.5 text-left hover:bg-muted/50"
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
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

const DATE_LABELS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  last90: 'Last 90 days',
  custom: 'Custom',
};

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

/**
 * Library toolbar: debounced text search plus real server-side
 * filters (date, type, direction, salesperson, status). Every
 * control maps to a GET /api/recordings param — nothing
 * decorative. Only the presentation changed (labelled cards);
 * filter state, values, options, and reset behavior are exactly
 * as before.
 */
export function RecordingsToolbar({
  filters,
  onChange,
  nowMs,
  timeZone,
  members,
}: {
  filters: RecordingsFilters;
  onChange: (f: RecordingsFilters) => void;
  nowMs: number;
  timeZone: string;
  members: MemberOption[];
}) {
  const todayInput = toDateInputValue(nowMs, timeZone);

  const set = (patch: Partial<RecordingsFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-2">
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

      <FilterSelect
        label="Date"
        icon={<CalendarDays className="h-4 w-4" />}
        value={filters.rangeKey}
        onValueChange={(v) => {
          if (v) set({ rangeKey: v as CallsRangeKey });
        }}
        ariaLabel="Date range"
        formatValue={(v) => DATE_LABELS[v ?? ''] ?? v}
      >
        <SelectItem value="today">Today</SelectItem>
        <SelectItem value="yesterday">Yesterday</SelectItem>
        <SelectItem value="last7">Last 7 days</SelectItem>
        <SelectItem value="last30">Last 30 days</SelectItem>
        <SelectItem value="last90">Last 90 days</SelectItem>
        <SelectItem value="custom">Custom</SelectItem>
      </FilterSelect>

      {filters.rangeKey === 'custom' ? (
        <span className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="Custom start date"
            value={filters.customFrom}
            max={filters.customTo || todayInput}
            onChange={(e) => set({ customFrom: e.target.value })}
            className="h-8 w-auto rounded-xl text-[13px]"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="date"
            aria-label="Custom end date"
            value={filters.customTo}
            min={filters.customFrom}
            max={todayInput}
            onChange={(e) => set({ customTo: e.target.value })}
            className="h-8 w-auto rounded-xl text-[13px]"
          />
        </span>
      ) : null}

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
        formatValue={(v) =>
          v === 'all' || v == null
            ? 'All users'
            : (members.find((m) => m.user_id === v)?.label ?? 'All users')
        }
        valueClassName="max-w-[160px]"
      >
        <SelectItem value="all">All users</SelectItem>
        {members.map((m) => (
          <SelectItem key={m.user_id} value={m.user_id}>
            {m.label}
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
