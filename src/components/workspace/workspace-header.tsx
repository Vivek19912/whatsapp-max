"use client";

import { useState, type ComponentType } from "react";
import { MoreHorizontal, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { WS_ACTION_BUTTON, WS_CONTROL_HEIGHT } from "./workspace-tokens";

export interface WorkspaceFlowOption {
  id: string;
  name?: string | null;
}

/**
 * Workspace page header: compact title row (title + table-kind
 * status) followed by a selector + primary-action toolbar row.
 * The selector stays a Radix Select (keyboard + screen-reader
 * behavior preserved) with a type-to-filter search field pinned
 * at the top of the menu.
 */
export function WorkspacePageHeader({
  subtitle,
  kindLabel,
  selector,
  toolbar,
}: {
  subtitle?: React.ReactNode;
  /** e.g. "Meta Lead Ads" / "Flow" — hidden when null. */
  kindLabel?: string | null;
  selector: React.ReactNode;
  toolbar?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Workspace
        </h1>
        {kindLabel ? (
          <Badge variant="secondary" className="shrink-0 text-xs font-medium">
            {kindLabel}
          </Badge>
        ) : null}
      </div>
      {subtitle ? (
        <p className="-mt-2 text-[13px] text-muted-foreground">{subtitle}</p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 sm:max-w-md">{selector}</div>
        {toolbar ? <div className="min-w-0 shrink-0">{toolbar}</div> : null}
      </div>
    </div>
  );
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Table selector: searchable menu of Workspace tables. Keeps the
 * existing Select contract (value/onValueChange, placeholder,
 * aria-label) and the established trigger widths; adds a filter
 * field so long Instant-Form lists stay navigable.
 */
export function WorkspaceTableSelector({
  flows,
  flowId,
  onSelect,
  wide,
  displayName,
}: {
  flows: WorkspaceFlowOption[];
  flowId: string | null;
  onSelect: (flowId: string) => void;
  /** Meta tables get the wider trigger for long form names. */
  wide?: boolean;
  displayName: (name: string | null | undefined) => string;
}) {
  const [query, setQuery] = useState("");
  const filtered =
    norm(query).length === 0
      ? flows
      : flows.filter(
          (f) =>
            norm(displayName(f.name)).includes(norm(query)) ||
            norm(f.id).includes(norm(query)),
        );
  const active = flows.find((f) => f.id === flowId) ?? null;

  return (
    <Select
      value={flowId ?? ""}
      onValueChange={(v) => {
        if (typeof v === "string" && v) onSelect(v);
      }}
      onOpenChange={(isOpen) => {
        if (!isOpen) setQuery("");
      }}
    >
      <SelectTrigger
        className={
          wide
            ? "border-border bg-card w-full sm:w-[min(24rem,100%)]"
            : "border-border bg-card w-full sm:w-72"
        }
        aria-label="Select flow"
      >
        <SelectValue placeholder="Select Flow">
          {active ? (
            <span className="block min-w-0 truncate" title={displayName(active.name)}>
              {displayName(active.name)}
            </span>
          ) : (
            "Select Flow"
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className={wide ? "max-w-[calc(100vw-2rem)]" : undefined}>
        <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-popover px-2 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search tables…"
            aria-label="Search tables"
            className="h-7 border-0 px-0 text-[13px] shadow-none focus-visible:ring-0"
          />
        </div>
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            No tables match.
          </p>
        ) : (
          filtered.map((f) => (
            <SelectItem
              key={f.id}
              value={f.id}
              title={wide ? displayName(f.name) : undefined}
              className={
                wide
                  ? "[&>span]:min-w-0 [&>span]:shrink [&>span]:truncate"
                  : undefined
              }
            >
              {displayName(f.name)}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

export interface WorkspaceToolbarAction {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  /** Screen-reader label when different from the visible label. */
  ariaLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Secondary actions render less prominent and collapse first. */
  secondary?: boolean;
}

/**
 * Primary-action toolbar with responsive overflow. All actions
 * render inline from sm: up; below that the first primary action
 * stays visible and everything else collapses into a "More
 * actions" menu — no wrapping, no horizontal overflow, no
 * clipped popovers.
 */
export function WorkspaceToolbar({
  primary,
  secondary = [],
  moreLabel = "More actions",
}: {
  primary: WorkspaceToolbarAction[];
  secondary?: WorkspaceToolbarAction[];
  moreLabel?: string;
}) {
  const inlinePrimary = primary.slice(0, 2);
  const overflowPrimary = primary.slice(2);
  const overflow = [...overflowPrimary, ...secondary];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="hidden min-w-0 items-center gap-2 sm:flex">
        {primary.map((a) => (
          <ToolbarButton key={a.key} action={a} />
        ))}
        {secondary.map((a) => (
          <ToolbarButton key={a.key} action={a} secondary />
        ))}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:hidden">
        {inlinePrimary.map((a) => (
          <ToolbarButton key={a.key} action={a} compact />
        ))}
          {overflow.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={moreLabel}
                className={cn(WS_ACTION_BUTTON, "px-2.5")}
              >
                <MoreHorizontal className="size-4" aria-hidden />
                <span className="sr-only">{moreLabel}</span>
              </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {overflow.map((a) => (
                <DropdownMenuItem
                  key={a.key}
                  onClick={a.onClick}
                  disabled={a.disabled}
                  aria-label={a.ariaLabel ?? a.label}
                >
                  <a.icon />
                  <span className="truncate">{a.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

function ToolbarButton({
  action,
  secondary,
  compact,
}: {
  action: WorkspaceToolbarAction;
  secondary?: boolean;
  compact?: boolean;
}) {
  const Icon = action.icon;
  return (
    <Button
      type="button"
      variant={secondary ? "ghost" : "outline"}
      size="sm"
      onClick={action.onClick}
      disabled={action.disabled}
      aria-label={action.ariaLabel ?? action.label}
      title={action.ariaLabel ?? action.label}
      className={cn(WS_ACTION_BUTTON, compact && "px-2.5")}
    >
      <Icon aria-hidden />
      {compact ? <span className="sr-only">{action.label}</span> : action.label}
      {action.loading ? <span className="sr-only">(loading)</span> : null}
    </Button>
  );
}

/** Shared h-9 search field for the table controls row. */
export function WorkspaceSearchField({
  value,
  onChange,
  placeholder = "Search name or phone…",
  ariaLabel = "Search table",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="relative w-full sm:max-w-sm">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn(WS_CONTROL_HEIGHT, "pl-9")}
      />
    </div>
  );
}
