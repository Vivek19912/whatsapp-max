"use client";

import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
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
 * Searchable single-select for long option lists (tables,
 * timezones, roster members). Popover + filter input + scrollable
 * list; keyboard navigable via native button focus, Escape closes
 * via the Popover. Controlled value, no form library needed.
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
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return options;
    return options.filter(
      (o) => norm(o.label).includes(q) || norm(o.value).includes(q) || (o.hint ? norm(o.hint).includes(q) : false),
    );
  }, [options, query]);

  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setQuery("");
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }}
    >
      <PopoverTrigger
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel ?? placeholder}
        className={cn(
          "border-border bg-card inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-sm font-normal shadow-xs transition-colors",
          "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          triggerClassName,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? selected.label : <span className="text-muted-foreground">{placeholder}</span>}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-[var(--radix-popover-trigger-width)] min-w-56 p-1", contentClassName)}
        align="start"
        sideOffset={6}
      >
        <div className="flex items-center gap-1.5 border-b border-border px-1.5 pb-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className={cn(WS_INPUT_SM, "border-0 shadow-none focus-visible:ring-0")}
          />
        </div>
        <ScrollArea className="max-h-56">
          <div className="flex flex-col gap-0.5 p-1" role="listbox">
            {filtered.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyText}</p>
            ) : (
              filtered.map((o) => {
                const active = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={o.disabled}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                      "disabled:pointer-events-none disabled:opacity-50",
                      active && "bg-muted",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
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
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
