"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FOLLOWUP_MESSAGE_MAX } from "@/lib/followups/types";
import {
  buildWorkspaceFollowupMessage,
  formatWorkspaceFollowupDateTime,
} from "@/lib/followups/workspace-link";

/**
 * Create Follow-up Reminder — offered after an agent sets a lead's
 * "Next Follow-up Date & Time" on a Meta Lead Ads Table. The dialog
 * itself is table-agnostic; the caller gates it to Meta tables and
 * the API rejects anything else.
 *
 * On confirm, exactly one linked reminder is created or updated
 * through the existing Reminders backend (delivered to the
 * agent's WhatsApp number — never to the lead). A blank message
 * falls back to a generated default carrying the lead's name and
 * phone; a custom message is sent exactly as entered (the shared
 * validator trims only surrounding whitespace, as everywhere).
 * Nothing is created before the agent confirms.
 */

export interface FollowupReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flowId: string;
  runId: string;
  /** Lead display values for confirmation + the default message. */
  leadName: string | null;
  leadPhone: string | null;
  /** Persisted follow-up instant (ISO) the reminder will use. */
  scheduledFor: string;
  /** Refresh the table after a successful save. */
  onSaved: () => void;
}

export function FollowupReminderDialog({
  open,
  onOpenChange,
  flowId,
  runId,
  leadName,
  leadPhone,
  scheduledFor,
  onSaved,
}: FollowupReminderDialogProps) {
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh message draft per follow-up; a failed save keeps the
  // draft so the agent can retry without retyping.
  useEffect(() => {
    if (open) {
      setMessage("");
      setError(null);
      setSaving(false);
    }
  }, [open, runId, scheduledFor]);

  const preview = buildWorkspaceFollowupMessage({
    name: leadName,
    phone: leadPhone,
  });
  const trimmed = message.trim();
  const canSubmit = !saving && trimmed.length <= FOLLOWUP_MESSAGE_MAX;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/followup-reminder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flow_run_id: runId,
          scheduled_for: scheduledFor,
          // Blank → the server generates the default message.
          message: trimmed === "" ? null : message,
          lead_name: leadName,
          lead_phone: leadPhone,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save the reminder.");
      toast.success("Follow-up reminder saved.");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the reminder.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Follow-up Reminder</DialogTitle>
          <DialogDescription>
            Delivered to your WhatsApp number at the scheduled time —
            never to the lead.
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
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Follow-up at</dt>
              <dd className="text-foreground tabular-nums">
                {formatWorkspaceFollowupDateTime(scheduledFor)}
              </dd>
            </div>
          </dl>

          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="fu-reminder-message">Reminder Message</Label>
              <span className="text-xs text-muted-foreground">
                {trimmed.length}/{FOLLOWUP_MESSAGE_MAX}
              </span>
            </div>
            <Textarea
              id="fu-reminder-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Leave blank to use the default message below."
            />
            {trimmed === "" && (
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

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
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
