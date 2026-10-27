"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { Eye, Pencil, Plus, Settings2, SlidersHorizontal, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { WS_CONTROL_BUTTON } from "./workspace-tokens";

export interface WorkspaceActionsMenuProps {
  /** Already-wired Filters trigger + panel (rendered as-is). */
  filters: ReactNode;
  /** Already-wired Columns trigger + panel (rendered as-is). */
  columns: ReactNode;
  /** Already-wired Hidden-rows trigger + panel; omit when not permitted. */
  hiddenRows?: ReactNode;
  /** Mirrors the previous Add Column gate (settings editors only). */
  canAddColumn: boolean;
  /** Existing Add Column handler (opens the column dialog). */
  onAddColumn: () => void;
  /** Mirrors the previous toolbar gate (owner only). */
  showAssignment: boolean;
  /** Existing Assignment handler (opens view or edit dialog). */
  onOpenAssignment: (mode: "view" | "edit") => void;
  /** Travel CRM row visibility (defaults to visible). */
  showTravelSettings?: boolean;
  /** Existing Travel CRM Settings handler (opens view or edit dialog). */
  onOpenTravelSettings: (mode: "view" | "edit") => void;
}

/**
 * One settings row: icon + label on the left, compact View and
 * Edit actions on the right. View opens the read-only dialog;
 * Edit opens the full editor. Matches the surrounding menu
 * button styling.
 */
function SettingRow({
  icon: Icon,
  label,
  onView,
  onEdit,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onView: () => void;
  onEdit: () => void;
}) {
  const actionClass =
    "h-8 shrink-0 gap-1 px-2 text-xs font-medium";
  return (
    <div className="flex items-center gap-1">
      <span className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-sm">
        <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground">{label}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={actionClass}
        onClick={onView}
        aria-label={`View ${label}`}
        title={`View ${label}`}
      >
        <Eye className="h-4 w-4" aria-hidden />
        View
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={actionClass}
        onClick={onEdit}
        aria-label={`Edit ${label}`}
        title={`Edit ${label}`}
      >
        <Pencil className="h-4 w-4" aria-hidden />
        Edit
      </Button>
    </div>
  );
}

/**
 * Single-icon menu for every secondary Workspace control.
 *
 * This is the only permanently visible toolbar control for the
 * Workspace table tools: one compact Settings/Actions icon button
 * (tooltip + accessible label "Workspace actions"). Clicking it
 * opens a grouped popover — "Table tools" (Filters, Columns,
 * Hidden rows, Add Column, Travel CRM Settings) and "Automation
 * & assignment" (Assignment).
 *
 * The Filters / Columns / Hidden-rows entries reuse the exact
 * components (and handlers, permissions, filter state, and API
 * contracts) the table row rendered before — they are passed in
 * as slots and mounted here, so no business logic is duplicated.
 * Their panels open in separate portals above this menu, so this
 * menu stays open while those panels are in use (closing it would
 * unmount the trigger that owns the panel). Dialog entries (Add
 * Column) close the menu first and then run the existing
 * page-level open handler — the dialogs live outside this menu
 * and are unaffected.
 *
 * Assignment and Travel CRM Settings each offer View (read-only
 * dialog) and Edit (full editor) actions.
 *
 * Positioning is collision-aware (flips/shifts into view) and
 * the panel scrolls within the viewport on desktop and mobile.
 */
export function WorkspaceActionsMenu({
  filters,
  columns,
  hiddenRows,
  canAddColumn,
  onAddColumn,
  showAssignment,
  onOpenAssignment,
  showTravelSettings = true,
  onOpenTravelSettings,
}: WorkspaceActionsMenuProps) {
  const [open, setOpen] = useState(false);

  const hasTableTools =
    filters != null ||
    columns != null ||
    hiddenRows != null ||
    canAddColumn ||
    showTravelSettings;
  const hasAutomation = showAssignment;

  function runAndClose(fn: () => void) {
    // Dialogs mount outside this menu, so closing first is safe
    // and keeps a single surface on screen.
    setOpen(false);
    fn();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Workspace actions"
        aria-expanded={open}
        title="Workspace actions"
        className={cn(WS_CONTROL_BUTTON, "shrink-0 px-2.5")}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden />
        <span className="sr-only">Workspace actions</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        collisionPadding={8}
        className="max-h-[min(70vh,30rem)] w-[min(92vw,20rem)] overflow-y-auto"
      >
        {hasTableTools ? (
          <section aria-label="Table tools" className="flex flex-col gap-1.5">
            <p className="px-1 pt-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Table tools
            </p>
            <div className="grid gap-1.5 [&>*]:w-full [&>*]:justify-start">
              {filters}
              {columns}
              {hiddenRows}
              {canAddColumn ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => runAndClose(onAddColumn)}
                  className="shrink-0 border-primary/30 bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  Add Column
                </Button>
              ) : null}
              {showTravelSettings ? (
                <SettingRow
                  icon={Settings2}
                  label="Travel CRM Settings"
                  onView={() => runAndClose(() => onOpenTravelSettings("view"))}
                  onEdit={() => runAndClose(() => onOpenTravelSettings("edit"))}
                />
              ) : null}
            </div>
          </section>
        ) : null}
        {hasAutomation ? (
          <section
            aria-label="Automation & assignment"
            className="flex flex-col gap-1.5"
          >
            <p className="px-1 pt-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Automation &amp; assignment
            </p>
            <div className="grid gap-1.5">
              {showAssignment ? (
                <SettingRow
                  icon={UserPlus}
                  label="Assignment"
                  onView={() => runAndClose(() => onOpenAssignment("view"))}
                  onEdit={() => runAndClose(() => onOpenAssignment("edit"))}
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
