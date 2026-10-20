"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Per-column header menu for Meta Lead Ads tables ONLY.
 *
 * Rendered exclusively for dynamically generated Instant Form
 * question columns (never system columns, never the fixed Source
 * column, never on Flow Tables). Offers exactly two options:
 *   - Rename Header — opens the rename dialog;
 *   - Restore Original Name — deletes this column's override
 *     (disabled when no custom name is stored).
 *
 * Display-only: overrides never touch stored answers, field
 * mappings, or API payloads — the table route keeps serving the
 * original values under the original keys.
 */
export function MetaColumnHeaderMenu({
  columnKey,
  originalLabel,
  displayLabel,
  customLabel,
  onRename,
  onRestore,
  disabled,
}: {
  /** Stable flow column key (for element ids only). */
  columnKey: string;
  /** Original Instant Form question text (read-only reference). */
  originalLabel: string;
  /** Text rendered in the header (custom verbatim, else formatted original). */
  displayLabel: string;
  /** Active custom header, or null when the original shows. */
  customLabel: string | null;
  /** Persist a new custom header; rejects to surface a toast. */
  onRename: (label: string) => Promise<void>;
  /** Delete this column's override; rejects to surface a toast. */
  onRestore: () => Promise<void>;
  disabled?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState(customLabel ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed the draft whenever the dialog opens for a column so a
  // stale draft from another column can never leak in.
  useEffect(() => {
    if (dialogOpen) {
      setDraft(customLabel ?? "");
      setError(null);
    }
  }, [dialogOpen, customLabel]);

  async function save() {
    const next = draft.trim();
    if (next === "") {
      setError("Enter a header name, or Cancel to keep the original.");
      return;
    }
    setBusy(true);
    try {
      await onRename(next);
      setDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the header name.");
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    try {
      await onRestore();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label={`Column options for ${originalLabel}`}
          className={cn(
            "group flex min-w-0 items-center gap-1 rounded-sm",
            "hover:bg-muted/50 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
          )}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden="true"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() => {
              setMenuOpen(false);
              setDialogOpen(true);
            }}
          >
            Rename Header
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!customLabel || busy}
            onSelect={() => {
              void restore();
            }}
          >
            Restore Original Name
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent aria-label={`Rename header for ${originalLabel}`}>
          <DialogHeader>
            <DialogTitle>Rename Header</DialogTitle>
            <DialogDescription>
              Only the visible header changes — answers, field mappings,
              and lead data stay exactly as they are.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label>Original Question</Label>
              <p className="text-muted-foreground rounded-md border border-border bg-muted px-3 py-2 text-sm">
                {originalLabel}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`meta-header-name-${columnKey}`}>
                New Header Name
              </Label>
              <Input
                id={`meta-header-name-${columnKey}`}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="e.g. Experience"
                autoComplete="off"
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
              {error ? (
                <p role="alert" className="text-destructive text-xs">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void save()} disabled={busy || draft.trim() === ""}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
