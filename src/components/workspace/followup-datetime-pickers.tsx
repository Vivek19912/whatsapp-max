"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarDays, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Simple date + time pickers for the Schedule Follow-up modal.
 *
 * Date: a compact month calendar in a portaled popover (select →
 * field updates immediately → closes). Time: three compact
 * horizontal dropdowns (Hour 01–12, Minute 00–59, AM/PM) in a
 * portaled popover — no scrolling columns, no internal scrollbars,
 * no segmented native popup. Each dropdown commits immediately,
 * so the field always shows the current pick.
 *
 * The string contracts are byte-identical to the previous inputs —
 * date stays `YYYY-MM-DD`, time stays 24-hour `HH:MM` — so
 * `combineFollowupDateTime`, `validateFollowupDateTime`, timezone
 * handling, and the scheduling API are completely untouched.
 */

// ---------------------------------------------------------------------------
// Shared value helpers (viewer-local; noon-anchored so DST edges can
// never shift the calendar day).
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");

function parseISODate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
  );
  return date.getFullYear() === Number(match[1]) &&
    date.getMonth() === Number(match[2]) - 1 &&
    date.getDate() === Number(match[3])
    ? date
    : undefined;
}

function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

const FIELD_TRIGGER_CLASS =
  "flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 text-sm whitespace-nowrap transition-colors outline-none select-none hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

// The app theme primary is purple; the spec calls for a BLUE
// selected-date indicator. The doubled attribute wins specificity
// over the Calendar primitive's own selected style deterministically
// (no source-order or stylesheet-order dependence).
const BLUE_SELECTED_DAY_CLASS =
  "[&_button[data-selected-single=true][data-selected-single=true]]:bg-blue-600 [&_button[data-selected-single=true][data-selected-single=true]]:text-white";

// ---------------------------------------------------------------------------
// Date field: button-styled trigger + compact month calendar.
// ---------------------------------------------------------------------------

export interface FollowupDateFieldProps {
  /** `YYYY-MM-DD` or "" when unset. */
  value: string;
  onChange: (value: string) => void;
  /** Controlled open state — the dialog coordinates date/time so only one opens. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FollowupDateField({
  value,
  onChange,
  open,
  onOpenChange,
}: FollowupDateFieldProps) {
  const selected = parseISODate(value);
  // Calendar month follows the selection: reopening preserves the
  // picked date instead of jumping back to today.
  const [month, setMonth] = useState<Date>(() => selected ?? startOfToday());
  useEffect(() => {
    if (open) setMonth(selected ?? startOfToday());
    // Re-sync only on open transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            id="fu-date"
            aria-label="Follow-up date"
            aria-haspopup="dialog"
            className={FIELD_TRIGGER_CLASS}
          />
        }
      >
        <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            selected ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {selected ? format(selected, "d MMM yyyy") : "Pick a date"}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-auto p-2"
        aria-label="Choose follow-up date"
      >
        <div className={BLUE_SELECTED_DAY_CLASS}>
          <Calendar
            mode="single"
            selected={selected}
            onSelect={(day) => {
              if (!day) return;
              onChange(toISODate(day));
              onOpenChange(false);
            }}
            month={month}
            onMonthChange={setMonth}
            // Past dates can never validate (the combined instant
            // must be future), so they are unpickable up front.
            disabled={{ before: startOfToday() }}
            // Compact cells: comfort without the oversized grid.
            className="[--cell-size:--spacing(6)] p-1"
          />
        </div>
        <div className="flex items-center justify-between border-t border-border px-1 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => {
              const today = startOfToday();
              setMonth(today);
              onChange(toISODate(today));
              onOpenChange(false);
            }}
          >
            Today
          </Button>
          {selected && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                onChange("");
                onOpenChange(false);
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Time field: button-styled trigger + three horizontal dropdowns.
// ---------------------------------------------------------------------------

const HOURS_12 = Array.from({ length: 12 }, (_, i) => pad2(i + 1));
const MINUTES_60 = Array.from({ length: 60 }, (_, i) => pad2(i));

interface TimeParts {
  hour12: string;
  minute: string;
  period: "AM" | "PM";
}

function parseTimeValue(value: string): TimeParts | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const minute = Number(match[2]);
  if (h > 23 || minute > 59) return null;
  return {
    hour12: pad2(h % 12 === 0 ? 12 : h % 12),
    minute: pad2(minute),
    period: h < 12 ? "AM" : "PM",
  };
}

function partsTo24Hour(parts: TimeParts): string {
  const h12 = Number(parts.hour12);
  const h24 =
    parts.period === "AM" ? h12 % 12 : (h12 % 12) + 12;
  return `${pad2(h24)}:${parts.minute}`;
}

function formatParts12Hour(parts: TimeParts): string {
  return `${parts.hour12}:${parts.minute} ${parts.period}`;
}

const TIME_SELECT_CLASS =
  "h-9 w-full cursor-pointer rounded-md border border-input bg-background px-1.5 text-center text-sm tabular-nums transition-colors outline-none hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export interface FollowupTimeFieldProps {
  /** 24-hour `HH:MM` or "" when unset. */
  value: string;
  onChange: (value: string) => void;
  /** Controlled open state — the dialog coordinates date/time so only one opens. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FollowupTimeField({
  value,
  onChange,
  open,
  onOpenChange,
}: FollowupTimeFieldProps) {
  const committed = parseTimeValue(value);
  // Every dropdown commits immediately: the field always shows the
  // current pick, so reopening trivially restores the selection
  // and no half-picked draft can strand. Blank values start from
  // the 1:30 PM new-attempt default (the dialog prefills anyway).
  const current: TimeParts = committed ?? {
    hour12: "01",
    minute: "30",
    period: "PM",
  };
  const commit = (patch: Partial<TimeParts>) => {
    onChange(partsTo24Hour({ ...current, ...patch }));
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            id="fu-time"
            aria-label="Follow-up time"
            aria-haspopup="dialog"
            className={FIELD_TRIGGER_CLASS}
          />
        }
      >
        <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left tabular-nums",
            committed ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {committed ? formatParts12Hour(committed) : "Pick a time"}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-64"
        aria-label="Choose follow-up time"
      >
        <div
          className="grid grid-cols-[1fr_auto_1fr_1fr] items-end gap-1.5"
          role="group"
          aria-label="Hour, minute, and period"
        >
          <label className="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
            Hour
            <select
              aria-label="Hour"
              value={current.hour12}
              onChange={(e) => commit({ hour12: e.target.value })}
              className={TIME_SELECT_CLASS}
            >
              {HOURS_12.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
          <span aria-hidden="true" className="pb-2 text-sm text-muted-foreground">
            :
          </span>
          <label className="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
            Minute
            <select
              aria-label="Minute"
              value={current.minute}
              onChange={(e) => commit({ minute: e.target.value })}
              className={TIME_SELECT_CLASS}
            >
              {MINUTES_60.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
            Period
            <select
              aria-label="AM or PM"
              value={current.period}
              onChange={(e) =>
                commit({ period: e.target.value as "AM" | "PM" })
              }
              className={TIME_SELECT_CLASS}
            >
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </label>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-sm text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {formatParts12Hour(current)}
          </span>
          <Button
            type="button"
            size="sm"
            className="h-8"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
