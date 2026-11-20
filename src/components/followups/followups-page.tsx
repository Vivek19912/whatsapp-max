"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Followup, FollowupStatus } from "@/lib/followups/types";
import { formatAgentNumberForDisplay } from "@/lib/followups/types";
import { FollowupDialog } from "./followup-dialog";

const TABS: Array<{ id: FollowupStatus; label: string }> = [
  { id: "scheduled", label: "Scheduled" },
  { id: "sent", label: "Sent" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];

const STATUS_TONE: Record<FollowupStatus, string> = {
  scheduled: "border-primary/40 text-primary",
  processing: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  sent: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  failed: "border-red-500/40 text-red-500",
  cancelled: "border-border text-muted-foreground",
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function FollowupsPage() {
  const { canSendMessages } = useAuth();
  const [tab, setTab] = useState<FollowupStatus>("scheduled");
  const [items, setItems] = useState<Followup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Followup | null>(null);
  const [cancelling, setCancelling] = useState<Followup | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/followups?status=${tab}`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        followups?: Followup[];
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not load reminders.");
      setItems(json?.followups ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load reminders.");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCancel() {
    if (!cancelling || acting) return;
    setActing(true);
    try {
      const res = await fetch(`/api/followups/${cancelling.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not cancel.");
      toast.success("Reminder cancelled — it will never send.");
      setCancelling(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel.");
    } finally {
      setActing(false);
    }
  }

  async function handleRetry(f: Followup) {
    if (acting) return;
    setActing(true);
    try {
      const res = await fetch(`/api/followups/${f.id}/retry`, { method: "POST" });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not retry.");
      toast.success("Reminder re-scheduled for immediate send.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not retry.");
    } finally {
      setActing(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            WhatsApp Reminders
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Personal reminders delivered to your WhatsApp number
          </p>
        </div>
        {canSendMessages && (
          <Button
            type="button"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            New Reminder
          </Button>
        )}
      </div>

      <div
        className="mt-5 flex gap-1.5"
        role="tablist"
        aria-label="Reminder status"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "h-8 rounded-full px-3.5 text-[13px] font-medium transition-colors",
              tab === t.id
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {loading ? (
          <Card className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
            ))}
          </Card>
        ) : error ? (
          <Card className="px-5 py-12 text-center">
            <p className="text-base font-semibold text-foreground">
              Could not load reminders
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            <Button type="button" variant="outline" className="mt-4" onClick={load}>
              Try again
            </Button>
          </Card>
        ) : items.length === 0 ? (
          <Card className="px-5 py-12 text-center">
            <CalendarClock className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 text-base font-semibold text-foreground">
              {tab === "scheduled"
                ? "No scheduled reminders"
                : `No ${tab} reminders`}
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Choose a date and time, write the message — WhatsApp Max delivers it
              to your WhatsApp number.
            </p>
          </Card>
        ) : (
          <div className="grid gap-3">
            {items.map((f) => (
              <Card key={f.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {f.contact_name || f.contact_phone || "Personal reminder"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {f.contact_phone ? `${f.contact_phone} · ` : ""}
                      {formatWhen(f.scheduled_for)}
                    </span>
                    <Badge variant="outline" className={cn("gap-1.5 text-xs font-normal", STATUS_TONE[f.status])}>
                      <span className="size-1.5 rounded-full bg-current" />
                      {f.status.charAt(0).toUpperCase() + f.status.slice(1)}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {f.message_text}
                  </p>
                  {/* Creator + actual recipient (the snapshot the
                      scheduler sends to — never the customer phone).
                      Rendered for every tab; the card body is shared. */}
                  <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    <span>
                      Created by:{" "}
                      <span className="font-medium text-foreground">
                        {f.creator?.full_name?.trim() || "Unknown"}
                      </span>
                    </span>
                    <span>
                      Send to:{" "}
                      <span className="font-medium tabular-nums text-foreground">
                        {f.recipient_phone
                          ? formatAgentNumberForDisplay(f.recipient_phone)
                          : "—"}
                      </span>
                    </span>
                  </p>
                  {f.status === "failed" && f.failure_reason && (
                    <p className="mt-1 text-xs text-red-500">{f.failure_reason}</p>
                  )}
                  {f.status === "sent" && f.sent_at && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Sent {formatWhen(f.sent_at)}
                      {/* Delivery state is explicit: the Sent badge
                          itself means Meta acceptance only. NULL
                          receipts imply nothing yet (no callback) —
                          never render those as confirmed delivery. */}
                      {f.read_at
                        ? ` · Read ${formatWhen(f.read_at)}`
                        : f.delivered_at
                          ? ` · Delivered ${formatWhen(f.delivered_at)}`
                          : " · accepted by Meta, delivery not yet confirmed"}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {(f.status === "scheduled" || f.status === "failed") &&
                    canSendMessages && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditing(f);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Button>
                    )}
                  {f.status === "scheduled" && canSendMessages && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCancelling(f)}
                    >
                      <X className="h-4 w-4" />
                      Cancel
                    </Button>
                  )}
                  {f.status === "failed" && canSendMessages && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={acting}
                      onClick={() => handleRetry(f)}
                    >
                      <RotateCcw className="h-4 w-4" />
                      Retry
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <FollowupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={load}
      />

      <Dialog open={cancelling !== null} onOpenChange={(v) => !v && setCancelling(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this reminder?</DialogTitle>
            <DialogDescription>
              It will never send. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCancelling(null)}
              disabled={acting}
            >
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={acting}
              onClick={handleCancel}
            >
              {acting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Cancelling…
                </>
              ) : (
                "Cancel reminder"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
