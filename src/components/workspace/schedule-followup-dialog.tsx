"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { FOLLOWUP_MESSAGE_MAX, normalizeAgentWhatsappNumber } from "@/lib/followups/types";
import {
  buildWorkspaceFollowupMessage,
  combineFollowupDateTime,
  mergeLinkedFollowupMessage,
  splitFollowupDateTime,
  validateFollowupDateTime,
} from "@/lib/followups/workspace-link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

/**
 * Schedule Follow-up — the single modal for a lead's
 * "Next Follow-up Date & Time" cell on Meta Lead Ads Tables.
 *
 * Clicking the cell opens this modal directly (no inline picker,
 * no second dialog): the agent picks a date and a time, edits the
 * prefilled "<name>, <phone>" reminder message if needed, and Save
 * Follow-up persists BOTH the cell value and the linked WhatsApp
 * reminder with the exact same timestamp. The reminder goes to the
 * agent's WhatsApp number — never to the lead.
 *
 * Timezone handling is the whole point of this modal: the picked
 * wall-clock values are combined into an explicit viewer-local
 * instant client-side (see combineFollowupDateTime), so what the
 * agent picked is exactly what gets stored and delivered —
 * regardless of the server's timezone. Editing an existing
 * follow-up prefills its date, time, and exact saved message;
 * clearing removes the cell value and cancels the linked reminder.
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
  // Prefilled with the "<name>, <phone>" default for a new
  // follow-up; an existing linked reminder's exact saved message
  // overwrites it on load (see below). Always editable.
  const defaultMessage = useMemo(
    () => buildWorkspaceFollowupMessage({ name: leadName, phone: leadPhone }),
    [leadName, leadPhone],
  );
  const [message, setMessage] = useState(defaultMessage);
  // Per-reminder recipient ("Send reminder to"). Prefilled from the
  // linked reminder's saved value, else the agent's current Settings
  // default. The dirty ref keeps async prefills from clobbering
  // typing — and from leaking one lead's/user's number into the
  // next dialog session (reset on every open).
  const [recipient, setRecipient] = useState("");
  // Tracks whether the agent typed into the recipient field since
  // the dialog opened, so async prefills never clobber typing — and
  // never leak one lead's/user's number into the next session
  // (reset on every open).
  const recipientDirtyRef = useRef(false);
  // True only when the visible value was defaulted from Settings
  // (drives the helper copy below).
  const [recipientFromSettings, setRecipientFromSettings] = useState(false);
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)initialize when the modal opens for a (possibly different)
  // lead: prefill from the current cell value, then layer the
  // linked reminder's saved values on top without clobbering typing.
  // Message: an untouched default is replaced by the saved message.
  // Recipient: the linked row's saved destination wins; otherwise the
  // agent's current Settings number. Anything the agent typed —
  // including a deliberately cleared field — is preserved verbatim.
  useEffect(() => {
    if (!open) return;
    const parts = splitFollowupDateTime(initialValue);
    setDate(parts?.date ?? "");
    setTime(parts?.time ?? "");
    setMessage(defaultMessage);
    setRecipient("");
    recipientDirtyRef.current = false;
    setRecipientFromSettings(false);
    setSaving(false);
    setClearing(false);
    setError(null);
    let cancelled = false;
    const supabase = createClient();
    const fetchProfileNumber = (async (): Promise<string | null> => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("whatsapp_number")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error || !data) return null;
      return normalizeAgentWhatsappNumber(
        (data as { whatsapp_number?: unknown }).whatsapp_number,
      );
    })();
    const fetchLinked = (async (): Promise<{
      message_text?: unknown;
      recipient_phone?: unknown;
    } | null> => {
      try {
        const res = await fetch(
          `/api/flows/${flowId}/followup-reminder?flow_run_id=${encodeURIComponent(runId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return null;
        const json = (await res.json().catch(() => null)) as {
          reminder?: { message_text?: unknown; recipient_phone?: unknown } | null;
        } | null;
        return json?.reminder ?? null;
      } catch {
        return null;
      }
    })();
    void Promise.all([fetchProfileNumber, fetchLinked]).then(([profileNumber, linked]) => {
      if (cancelled) return;
      const linkedMessage =
        typeof linked?.message_text === "string" && linked.message_text !== ""
          ? linked.message_text
          : null;
      if (linkedMessage !== null) {
        // Only prefill if the agent hasn't started typing: a field
        // that still holds the untouched default takes the saved
        // message; anything typed (or cleared) is left alone.
        setMessage((current) =>
          mergeLinkedFollowupMessage(current, defaultMessage, linkedMessage),
        );
      }
      if (recipientDirtyRef.current) return;
      const savedRecipient =
        typeof linked?.recipient_phone === "string" && linked.recipient_phone.trim() !== ""
          ? linked.recipient_phone.trim()
          : null;
      if (savedRecipient) {
        setRecipient(savedRecipient);
      } else if (profileNumber) {
        setRecipient(profileNumber);
        setRecipientFromSettings(true);
      } else {
        setRecipient("");
      }
    });
    return () => {
      cancelled = true;
    };
    // Re-run when a different lead's modal opens or the signed-in user changes.
  }, [open, runId, flowId, initialValue, defaultMessage, user?.id]);

  const trimmedMessage = message.trim();
  const canSubmit =
    !saving && !clearing && trimmedMessage.length <= FOLLOWUP_MESSAGE_MAX;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const validationError = validateFollowupDateTime(date, time);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    // Validate the per-reminder destination with the same rules as
    // Settings → Reminder WhatsApp Number. Invalid input blocks the
    // save inline so no other field values are lost.
    const normalizedRecipient = normalizeAgentWhatsappNumber(recipient);
    if (!normalizedRecipient) {
      setError("Enter a valid WhatsApp number to receive this reminder.");
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
          recipient_phone: normalizedRecipient,
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
            Pick a date and time, choose the WhatsApp number that should
            receive the reminder, edit the message if needed, and save —
            the reminder never goes to the lead.
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

          <div className="grid gap-2">
            <Label htmlFor="fu-recipient">Send reminder to</Label>
            <Input
              id="fu-recipient"
              type="tel"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                recipientDirtyRef.current = true;
                setRecipientFromSettings(false);
              }}
              maxLength={32}
              placeholder="WhatsApp number"
              autoComplete="tel"
            />
            <p className="text-xs text-muted-foreground">
              {recipientFromSettings ? "Defaulted from Settings. You can change it for this reminder." : "Enter the WhatsApp number that should receive this reminder."}
            </p>
          </div>

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
              placeholder="Reminder message"
            />
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
