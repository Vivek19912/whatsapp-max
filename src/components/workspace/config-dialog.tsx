"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { WS_DIALOG_WIDTH, type WsDialogWidth } from "./workspace-tokens";

/**
 * Shared configuration-dialog shell. Every Workspace table dialog
 * (Sheets, WhatsApp auto-send, Assignment, Travel CRM) renders
 * through this so widths, headers, footers, scrolling, and busy
 * states stay consistent:
 *
 * - Width by content type: md (short forms), lg (two-section
 *   configs), xl (wide editors). Full viewport width on mobile.
 * - Sticky header + scrollable body + sticky footer: long content
 *   scrolls between them, so inputs are never hidden behind the
 *   footer and Close/Save stay reachable.
 * - One header pattern: optional icon, title, kind/table line,
 *   optional status badge. One footer pattern: error line,
 *   Cancel/Close + primary action with loading state.
 * - Escape/outside-click close + focus management come from the
 *   base Dialog; dialogs opt out of outside-close only for dirty
 *   forms that explicitly need it.
 */

export function ConfigDialog({
  open,
  onOpenChange,
  width = "lg",
  icon,
  title,
  tableLine,
  description,
  status,
  loading,
  loadingText = "Loading…",
  error,
  children,
  footer,
  contentClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width?: WsDialogWidth;
  icon?: ReactNode;
  title: ReactNode;
  /** e.g. "Meta Lead Ads table · Monsoon Sale" — always visible. */
  tableLine?: ReactNode;
  description?: ReactNode;
  /** Optional status badge rendered beside the title row. */
  status?: ReactNode;
  loading?: boolean;
  loadingText?: string;
  error?: string | null;
  children?: ReactNode;
  footer?: ReactNode;
  contentClassName?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:rounded-xl",
          WS_DIALOG_WIDTH[width],
          contentClassName,
        )}
      >
        <DialogHeader className="shrink-0 gap-1.5 border-b border-border px-5 pt-5 pb-4 sm:px-6">
          <div className="flex items-start justify-between gap-3 pr-6">
            <DialogTitle className="flex min-w-0 items-center gap-2 text-base font-semibold">
              {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
              <span className="min-w-0 truncate">{title}</span>
            </DialogTitle>
            {status}
          </div>
          {(tableLine || description) && (
            <DialogDescription className="text-[13px] leading-snug">
              {tableLine ? <span className="font-medium text-foreground">{tableLine}</span> : null}
              {tableLine && description ? " · " : null}
              {description}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {loadingText}
            </p>
          ) : (
            children
          )}
        </div>

        {(error || footer) && (
          <DialogFooter className="shrink-0 flex-col items-stretch gap-2 border-t border-border bg-muted/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p role={error ? "alert" : undefined} className="min-h-5 text-xs text-destructive">
              {error ?? ""}
            </p>
            <div className="flex items-center justify-end gap-2">{footer}</div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Section block inside a config dialog: title + hint + content. */
export function ConfigSection({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2.5", className)} aria-label={typeof title === "string" ? title : undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {hint ? <p className="text-xs leading-snug text-muted-foreground">{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Footer Cancel + primary Save pair with shared busy handling. */
export function ConfigFooterActions({
  onClose,
  closeLabel = "Cancel",
  onSave,
  saveLabel = "Save Changes",
  saving,
  saveDisabled,
  savingLabel = "Saving…",
}: {
  onClose: () => void;
  closeLabel?: string;
  onSave: () => void;
  saveLabel?: string;
  saving?: boolean;
  saveDisabled?: boolean;
  savingLabel?: string;
}) {
  return (
    <>
      <Button type="button" variant="outline" onClick={onClose} disabled={!!saving}>
        {closeLabel}
      </Button>
      <Button type="button" onClick={onSave} disabled={!!saveDisabled || !!saving}>
        {saving ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {savingLabel}
          </>
        ) : (
          saveLabel
        )}
      </Button>
    </>
  );
}

/** Small labeled badge row used above dialog footers for counts. */
export function ConfigCountRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function ConfigStatusBadge({
  tone,
  children,
}: {
  tone: "default" | "secondary" | "outline" | "destructive";
  children: ReactNode;
}) {
  return <Badge variant={tone}>{children}</Badge>;
}

export function ConfigDivider() {
  return <Separator className="my-1" />;
}
