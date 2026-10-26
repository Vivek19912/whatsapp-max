"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { WS_INPUT_SM } from "./workspace-tokens";

export interface SearchableOption {
  value: string;
  label: string;
  hint?: string | null;
  disabled?: boolean;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Substring filter over label, value, then hint (in that order of
 * fields, stable original order otherwise). Pure — powers both the
 * live dropdown and unit tests over real option lists.
 */
export function filterSearchableOptions(
  options: SearchableOption[],
  query: string
): SearchableOption[] {
  const q = norm(query);
  if (!q) return options;
  return options.filter(
    (o) =>
      norm(o.label).includes(q) ||
      norm(o.value).includes(q) ||
      (o.hint ? norm(o.hint).includes(q) : false)
  );
}

/**
 * Searchable single-select for long option lists (tables,
 * timezones, roster members): a controlled Base UI Popover
 * combobox — a real editable search input, a substring filter,
 * and a plain scroll viewport (same reliable pattern as the
 * Travel CRM destination selector).
 *
 * Anchoring and overflow contract (do not regress):
 * - width follows the trigger via Base UI's `--anchor-width`
 *   variable (NOT the Radix `--radix-popover-trigger-width`
 *   variable, which does not exist in this stack and silently
 *   decoupled the dropdown from its trigger);
 * - the option list — and only the option list — scrolls, capped
 *   at min(15rem, --available-height) so it fits above or below
 *   the trigger without covering dialog content;
 * - collision avoidance flips above the trigger when there is no
 *   room below and shifts horizontally to stay in the viewport;
 * - keyboard: ArrowUp/Down/Home/End move a highlight (scrolled
 *   into view), Enter picks it, Escape dismisses via the Popover.
 */
export function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  triggerClassName,
  contentClassName,
  ariaLabel,
}: {
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  triggerClassName?: string;
  contentClassName?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const activeId = highlight >= 0 ? `${listboxId}-option-${highlight}` : undefined;

  const filtered = useMemo(() => filterSearchableOptions(options, query), [options, query]);

  const selected = options.find((o) => o.value === value) ?? null;

  function scrollHighlightIntoView(index: number) {
    // Runs after paint so the highlighted row exists; nearest-only
    // so the list never jumps while typing (fires solely on
    // arrow-key navigation).
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  function moveHighlight(delta: 1 | -1) {
    if (filtered.length === 0) return;
    const next =
      highlight < 0 || highlight >= filtered.length
        ? delta === 1
          ? 0
          : filtered.length - 1
        : (highlight + delta + filtered.length) % filtered.length;
    setHighlight(next);
    scrollHighlightIntoView(next);
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Home") {
      if (filtered.length === 0) return;
      e.preventDefault();
      setHighlight(0);
      scrollHighlightIntoView(0);
    } else if (e.key === "End") {
      if (filtered.length === 0) return;
      e.preventDefault();
      setHighlight(filtered.length - 1);
      scrollHighlightIntoView(filtered.length - 1);
    } else if (e.key === "Enter") {
      const target =
        highlight >= 0 && highlight < filtered.length
          ? filtered[highlight]
          : filtered[0];
      if (target && !target.disabled) {
        e.preventDefault();
        onChange(target.value);
        setOpen(false);
      }
    }
    // Escape dismisses via the Popover and Tab moves focus out
    // (both propagate); every other key types into the input.
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setQuery("");
          setHighlight(-1);
        }
      }}
    >
      <PopoverTrigger
        aria-label={ariaLabel ?? placeholder}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "border-border bg-card inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-sm font-normal shadow-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          triggerClassName
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? selected.label : <span className="text-muted-foreground">{placeholder}</span>}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] p-1", contentClassName)}
        align="start"
        side="bottom"
        sideOffset={6}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        collisionPadding={8}
      >
        <div className="flex items-center gap-1.5 border-b border-border px-1.5 pb-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Typing resets the highlight without moving scroll.
              setHighlight(-1);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={activeId}
            autoFocus
            className={cn(WS_INPUT_SM, "border-0 shadow-none focus-visible:ring-0")}
          />
        </div>
        {/* Plain scroll viewport for the option list only: the
            search input above stays pinned, the list never grows
            the popover past min(15rem, available space), and
            overscroll-contain keeps wheel scrolling from hijacking
            the dialog behind it. */}
        <div
          ref={listRef}
          role="listbox"
          id={listboxId}
          aria-label="Options"
          className="max-h-[min(15rem,var(--available-height))] min-h-0 overflow-y-auto overscroll-contain"
        >
          <div className="flex flex-col gap-0.5 p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyText}</p>
            ) : (
              filtered.map((o, index) => {
                const active = o.value === value;
                return (
                  <button
                    key={o.value}
                    id={`${listboxId}-option-${index}`}
                    data-index={index}
                    type="button"
                    role="option"
                    aria-selected={active}
                    aria-disabled={o.disabled || undefined}
                    disabled={o.disabled}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                      "disabled:pointer-events-none disabled:opacity-50",
                      (active || highlight === index) && "bg-muted"
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-left">
                      <span className="block truncate text-foreground">{o.label}</span>
                      {o.hint ? (
                        <span className="block truncate text-xs text-muted-foreground">{o.hint}</span>
                      ) : null}
                    </span>
                    {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
