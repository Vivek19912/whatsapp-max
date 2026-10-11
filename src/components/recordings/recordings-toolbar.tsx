'use client';

import { CalendarDays, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MemberOption, RecordingsFilters } from '@/lib/recordings/library';
import { toDateInputValue, type CallsRangeKey } from '@/lib/calls/ranges';

/**
 * Library toolbar: debounced text search plus real server-side
 * filters (date, type, direction, uploader, status). Every control
 * maps to a GET /api/recordings param — nothing decorative.
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

      <Select
        value={filters.rangeKey}
        onValueChange={(v) => set({ rangeKey: v as CallsRangeKey })}
      >
        <SelectTrigger className="w-auto gap-2 rounded-full" aria-label="Date range">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <SelectValue placeholder="Date" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="today">Today</SelectItem>
          <SelectItem value="yesterday">Yesterday</SelectItem>
          <SelectItem value="last7">Last 7 Days</SelectItem>
          <SelectItem value="last30">Last 30 Days</SelectItem>
          <SelectItem value="last90">Last 90 Days</SelectItem>
          <SelectItem value="custom">Custom</SelectItem>
        </SelectContent>
      </Select>

      {filters.rangeKey === 'custom' ? (
        <span className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="Custom start date"
            value={filters.customFrom}
            max={filters.customTo || todayInput}
            onChange={(e) => set({ customFrom: e.target.value })}
            className="h-8 w-auto rounded-full text-[13px]"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="date"
            aria-label="Custom end date"
            value={filters.customTo}
            min={filters.customFrom}
            max={todayInput}
            onChange={(e) => set({ customTo: e.target.value })}
            className="h-8 w-auto rounded-full text-[13px]"
          />
        </span>
      ) : null}

      <Select
        value={filters.callType ?? 'all'}
        onValueChange={(v) => set({ callType: v === 'all' ? null : v })}
      >
        <SelectTrigger className="w-auto gap-2 rounded-full" aria-label="Call type">
          <SelectValue placeholder="Call Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Types</SelectItem>
          <SelectItem value="phone">Phone</SelectItem>
          {/* Merged reporting category: one WhatsApp option matches
              stored whatsapp + whatsapp_business (route folds both). */}
          <SelectItem value="whatsapp">WhatsApp</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={filters.direction ?? 'all'}
        onValueChange={(v) => set({ direction: v === 'all' ? null : v })}
      >
        <SelectTrigger className="w-auto gap-2 rounded-full" aria-label="Direction">
          <SelectValue placeholder="Direction" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Directions</SelectItem>
          <SelectItem value="in">Incoming</SelectItem>
          <SelectItem value="out">Outgoing</SelectItem>
          <SelectItem value="unknown">Unknown</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={filters.uploadedBy ?? 'all'}
        onValueChange={(v) => set({ uploadedBy: v === 'all' ? null : v })}
      >
        <SelectTrigger className="w-auto gap-2 rounded-full" aria-label="Uploaded by">
          <SelectValue placeholder="Uploaded By" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Users</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.user_id} value={m.user_id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.status ?? 'all'}
        onValueChange={(v) => set({ status: v === 'all' ? null : v })}
      >
        <SelectTrigger className="w-auto gap-2 rounded-full" aria-label="Link status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Statuses</SelectItem>
          <SelectItem value="linked">Linked</SelectItem>
          <SelectItem value="unlinked">Unlinked</SelectItem>
        </SelectContent>
      </Select>

      <button
        type="button"
        onClick={() =>
          onChange({
            q: '',
            rangeKey: 'last30',
            customFrom: '',
            customTo: '',
            callType: null,
            direction: null,
            uploadedBy: null,
            status: null,
          })
        }
        className="text-[13px] font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        Clear
      </button>
    </div>
  );
}
