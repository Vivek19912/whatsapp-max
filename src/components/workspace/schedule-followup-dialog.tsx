"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FOLLOWUP_MESSAGE_MAX } from "@/lib/followups/types";
import {
  buildWorkspaceFollowupMessage,
  combineFollowupDateTime,
  splitFollowupDateTime,
  validateFollowupDateTime,
} from "@/lib/followups/workspace-link";

/**
 * Schedule Follow-up — the single modal for a lead's
 * "Next Follow-up Date & Time" cell on Meta Lead Ads Tables.
 *
 * Clicking the cell opens this modal directly (no inline picker,
 * no second dialog): the agent picks a date and a time, optionally
 * writes a reminder message, and Save Follow-up persists BOTH the
 * cell value and the linked WhatsApp reminder with the exact same
 * timestamp. The reminder goes to the agent's WhatsApp number —
 * never to the lead.
 *
 * Timezone handling is the whole point of this modal: the picked
 * wall-clock values are combined into an explicit viewer-local
 * instant client-side (see combineFollowupDateTime), so what the
 * agent picked is exactly what gets stored and delivered —
 * regardless of the server's timezone. Editing an existing
 * follow-up prefills its date, time, and linked message; clearing
 * removes the cell value and cancels the linked reminder.
 */

export interface ScheduleFollowupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flowId: string;
  runId: string;
  /** Lead display values for confirmation + the default message. */
  leadName: string | null;
  leadPhone: string | null;
  /** Current cell value (ISO instant) or null when unset. */
  initialValue: string | null;
  /** The follow-up datetime field id for the cell write. */
  fieldId: string;
  /** Refresh the table after a successful save or clear. */
  onSaved: () => void;
}

export function ScheduleFollowupDialog({
  open,
  onOpenChange,
  flowId,
  runId,
  leadName,
  leadPhone,
  initialValue,
  fieldId,
  onSaved,
}: ScheduleFollowupDialogProps) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)initialize when the modal opens for a (possibly different)
  // lead: prefill from the current cell value, then layer the
  // linked reminder's message on top without clobbering typing.
  useEffect(() => {
    if (!open) return;
    const parts = splitFollowupDateTime(initialValue);
    setDate(parts?.date ?? "");
    setTime(parts?.time ?? "");
    setMessage("");
    setSaving(false);
    setClearing(false);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/flows/${flowId}/followup-reminder?flow_run_id=${encodeURIComponent(runId)}`,
          { cache: "no-store" },
        );
        if (cancelled || !res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          reminder?: { message_text?: unknown } | null;
        } | null;
        const linked = json?.reminder;
        if (linked && typeof linked.message_text === "string" && linked.message_text !== "") {
          // Only prefill if the agent hasn't started typing.
          setMessage((current) => (current === "" ? linked.message_text as string : current));
        }
      } catch {
        // Prefill is best-effort; a missing message just leaves the
        // field blank (the default preview still shows).
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-run when a different lead's modal opens.
  }, [open, runId, flowId, initialValue]);

  const trimmedMessage = message.trim();
  const canSubmit =
    !saving && !clearing && trimmedMessage.length <= FOLLOWUP_MESSAGE_MAX;
  const preview = buildWorkspaceFollowupMessage({
    name: leadName,
    phone: leadPhone,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const validationError = validateFollowupDateTime(date, time);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    // Combine in the viewer's timezone into one unambiguous UTC
    // instant used for BOTH writes below.
    const iso = combineFollowupDateTime(date, time);
    if (iso === null) {
      setError("Enter a valid date and time.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const cellRes = await fetch(`/api/flows/${flowId}/workspace-values`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_id: fieldId,
          flow_run_id: runId,
          value: iso,
        }),
      });
      const cellJson = (await cellRes.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!cellRes.ok) {
        throw new Error(cellJson?.error ?? "Could not save the follow-up date.");
      }
      const res = await fetch(`/api/flows/${flowId}/followup-reminder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flow_run_id: runId,
          scheduled_for: iso,
          message: trimmedMessage === "" ? null : message,
          lead_name: leadName,
          lead_phone: leadPhone,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save the reminder.");
      toast.success("Follow-up saved.");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      // No success toast: the follow-up is only saved when the
      // backend confirms persistence. Input is preserved for retry.
      setError(err instanceof Error ? err.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (saving || clearing) return;
    setClearing(true);
    setError(null);
    try {
      const cellRes = await fetch(`/api/flows/${flowId}/workspace-values`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_id: fieldId,
          flow_run_id: runId,
          value: null,
        }),
      });
      const cellJson = (await cellRes.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!cellRes.ok) {
        throw new Error(cellJson?.error ?? "Could not clear the follow-up.");
      }
      const res = await fetch(`/api/flows/${flowId}/followup-reminder`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow_run_id: runId }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        cancelled?: boolean;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not cancel the reminder.");
      if (json?.cancelled) toast.success("Scheduled reminder cancelled.");
      else toast.success("Follow-up cleared.");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear. Try again.");
    } finally {
      setClearing(false);
    }
  }

  const busy = saving || clearing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Schedule Follow-up</DialogTitle>
          <DialogDescription>
            Pick a date and time, optionally add a message, and save —
            the reminder goes to your WhatsApp number, never to the lead.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <dl className="space-y-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Lead</dt>
              <dd className="text-foreground font-medium">
                {leadName?.trim() ? leadName : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="text-foreground font-medium">
                {leadPhone?.trim() ? leadPhone : "—"}
              </dd>
            </div>
          </dl>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="fu-date">Follow-up date</Label>
              <Input
                id="fu-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fu-time">Follow-up time</Label>
              <Input
                id="fu-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="fu-reminder-message">Reminder Message</Label>
              <span className="text-xs text-muted-foreground">
                {trimmedMessage.length}/{FOLLOWUP_MESSAGE_MAX}
              </span>
            </div>
            <Textarea
              id="fu-reminder-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Leave blank to use the default message below."
            />
            {trimmedMessage === "" && (
              <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm whitespace-pre-line">
                {preview}
              </p>
            )}
          </div>

          {error !== null && (
            <p
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
            >
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            {initialValue !== null && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void handleClear()}
                className="mr-auto text-destructive hover:text-destructive"
              >
                {clearing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Clear
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Save Follow-up
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
