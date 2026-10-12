"use client";

import { EyeOff, Loader2, MoreHorizontal, Pin, PinOff } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Per-row actions menu for the Workspace live table (Pin /
 * Unpin / Hide). Lives in the dedicated narrow actions column —
 * one menu per row, never a button per cell. Clicks never bubble
 * to the row (which opens the lead drawer); the menu itself
 * renders through a portal, so the table's scroll viewport and
 * sticky header can never clip it.
 */
export function RowActionsMenu({
  rowLabel,
  isPinned,
  pending,
  onTogglePin,
  onHide,
}: {
  /** Accessible label for the trigger (lead name/phone). */
  rowLabel: string;
  /** True while this row's pin is set (filled-pin indicator). */
  isPinned: boolean;
  /** True while a pin/hide request for this row is in flight. */
  pending: boolean;
  /** Pin when unpinned, unpin when pinned. */
  onTogglePin: () => void;
  /** Hide the row (visibility-only, reversible). */
  onHide: () => void;
}) {
  return (
    <span
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      {isPinned && (
        <Pin
          aria-label="Pinned"
          className="h-3.5 w-3.5 shrink-0 fill-amber-500 text-amber-500"
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Row actions for ${rowLabel}`}
          disabled={pending}
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 w-8 items-center justify-center rounded-md disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onClick={onTogglePin}
            disabled={pending}
            aria-label={isPinned ? "Unpin row" : "Pin row"}
          >
            {isPinned ? (
              <PinOff className="h-4 w-4" />
            ) : (
              <Pin className="h-4 w-4" />
            )}
            {isPinned ? "Unpin row" : "Pin row"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onHide}
            disabled={pending}
            aria-label="Hide row"
          >
            <EyeOff className="h-4 w-4" />
            Hide row
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
