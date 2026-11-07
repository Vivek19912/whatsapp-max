"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  FOLLOWUP_OUTCOMES,
  FOLLOWUP_RESULT_MAX,
  type FollowupOutcome,
} from "@/lib/followups/attempts";

/**
 * Record Follow-up Result — the mandatory result entry for a due
 * sales follow-up attempt. Outcome + notes are both required; the
 * server re-validates everything and rejects duplicate submissions
 * (a completed attempt 409s instead of overwriting history).
 */

export interface RecordFollowupResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flowId: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  leadName: string | null;
  scheduledAt: string;
  onSaved: () => void;
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return format(d, "d MMM yyyy, h:mm a");
}

export function RecordFollowupResultDialog({
  open,
  onOpenChange,
  flowId,
  runId,
  attemptId,
  attemptNumber,
  leadName,
  scheduledAt,
  onSaved,
}: RecordFollowupResultDialogProps) {
  const [outcome, setOutcome] = useState<FollowupOutcome | "">("");
  const [resultText, setResultText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOutcome("");
    setResultText("");
    setSaving(false);
    setError(null);
  }, [open, attemptId]);

  const trimmed = resultText.trim();
  // Outcome is optional — only the result text is mandatory.
  const clientError =
    trimmed === ""
      ? "Describe the follow-up result."
      : trimmed.length > FOLLOWUP_RESULT_MAX
        ? `Keep the result to ${FOLLOWUP_RESULT_MAX} characters or fewer.`
        : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || clientError !== null) {
      setError(clientError ?? "Complete the required fields.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/flows/${flowId}/sales-followups/${attemptId}/result`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            flow_run_id: runId,
            outcome: outcome === "" ? null : outcome,
            result_text: trimmed,
          }),
        },
      );
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(json?.error ?? "Could not save the result.");
      }
      toast.success(`Follow-up ${attemptNumber} completed.`);
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record Follow-up Result</DialogTitle>
          <DialogDescription>
            Follow-up {attemptNumber} is due — record what actually
            happened before the next follow-up can be scheduled.
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
              <dt className="text-muted-foreground">Follow-up</dt>
              <dd className="text-foreground font-medium tabular-nums">
                Follow-up {attemptNumber}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Scheduled</dt>
              <dd className="text-foreground font-medium tabular-nums">
                {formatInstant(scheduledAt)}
              </dd>
            </div>
          </dl>

          <div className="grid gap-2">
            <Label htmlFor="fr-outcome">Follow-up Outcome (optional)</Label>
            <Select
              value={outcome}
              onValueChange={(v) => setOutcome(v as FollowupOutcome)}
            >
              <SelectTrigger id="fr-outcome" aria-label="Follow-up outcome">
                <SelectValue placeholder="Select outcome (optional)" />
              </SelectTrigger>
              <SelectContent>
                {FOLLOWUP_OUTCOMES.map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="fr-result">Follow-up Result / Notes</Label>
              <span className="text-xs text-muted-foreground">
                {trimmed.length}/{FOLLOWUP_RESULT_MAX}
              </span>
            </div>
            <Textarea
              id="fr-result"
              value={resultText}
              onChange={(e) => setResultText(e.target.value)}
              rows={4}
              maxLength={FOLLOWUP_RESULT_MAX + 100}
              placeholder="What happened on this follow-up?"
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Save Result
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
