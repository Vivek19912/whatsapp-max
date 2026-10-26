"use client";

import { EyeOff, Loader2, RotateCcw } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  hiddenRowLabel,
  type HiddenRowInfo,
} from "@/lib/flows/workspace-row-prefs";

/**
 * "Show hidden rows" control for the Workspace toolbar. Compact
 * dropdown listing the caller's hidden rows for the selected flow
 * with a per-row Restore action plus Restore all. Each entry
 * mirrors the Workspace table's row formatting — lead name as the
 * primary field, phone as the secondary muted field, Restore
 * pinned to the right — separated by subtle dividers. Restoring
 * only clears the visibility flag — the underlying lead and
 * flow-run data are never touched, and restored rows respect the
 * active search, filters, view, and pagination on the next table
 * fetch.
 */
export function HiddenRowsMenu({
  hidden,
  pendingIds,
  restoreAllPending,
  onRestore,
  onRestoreAll,
}: {
  /** The caller's hidden rows for the selected flow. */
  hidden: readonly HiddenRowInfo[];
  /** Run ids with a restore request currently in flight. */
  pendingIds: ReadonlySet<string>;
  /** True while a restore-all request is in flight. */
  restoreAllPending: boolean;
  /** Restore one hidden row. */
  onRestore: (flowRunId: string) => void;
  /** Restore every hidden row in this flow. */
  onRestoreAll: () => void;
}) {
  const count = hidden.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={
          count > 0 ? `Show ${count} hidden rows` : "Show hidden rows"
        }
        className="border-border bg-card text-muted-foreground hover:text-foreground inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <EyeOff className="h-4 w-4" />
        Hidden{count > 0 ? ` (${count})` : ""}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-h-80">
        <DropdownMenuLabel>
          Hidden rows{count > 0 ? ` (${count})` : ""}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {count === 0 ? (
          <DropdownMenuItem disabled>No hidden rows</DropdownMenuItem>
        ) : (
          <div className="divide-y divide-border">
            {hidden.map((h) => {
              const pending = pendingIds.has(h.flow_run_id);
              const name = h.name?.trim() ? h.name.trim() : null;
              const phone = h.phone?.trim() ? h.phone.trim() : null;
              return (
                <DropdownMenuItem
                  key={h.flow_run_id}
                  onClick={() => onRestore(h.flow_run_id)}
                  disabled={pending}
                  aria-label={`Restore ${hiddenRowLabel(h)}`}
                  className="py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-sm font-medium text-foreground"
                      title={name ?? phone ?? undefined}
                    >
                      {name ?? phone ?? "Lead"}
                    </span>
                    {name && phone ? (
                      <span
                        className="text-muted-foreground block truncate text-xs tabular-nums"
                        title={phone}
                      >
                        {phone}
                      </span>
                    ) : null}
                  </span>
                  {pending ? (
                    <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <span className="text-muted-foreground ml-2 shrink-0 text-xs">
                      Restore
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </div>
        )}
        {count > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onRestoreAll}
              disabled={restoreAllPending}
              aria-label="Restore all hidden rows"
            >
              {restoreAllPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              Restore all
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
