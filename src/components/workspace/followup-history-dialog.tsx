"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarPlus, ClipboardList, Loader2, LockOpen, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  attemptStatus,
  badgeForAttempt,
  type SalesFollowupAttempt,
} from "@/lib/followups/attempts";
import { cn } from "@/lib/utils";

/**
 * Follow-up History — the unlimited per-lead attempt timeline.
 * Every attempt renders in order with its scheduled time, outcome,
 * result, salesperson, and completion time; the current state
 * drives one contextual primary action (Record Result / Schedule
 * Next / none when closed), so the sequential rule is visible,
 * not just enforced.
 */

export interface FollowupHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flowId: string;
  runId: string;
  leadName: string | null;
  onRecordResult: (attempt: SalesFollowupAttempt) => void;
  onScheduleNext: () => void;
  /** Bump to refetch after a schedule/record/close elsewhere. */
  refreshSeq: number;
}

interface HistoryState {
  attempts: SalesFollowupAttempt[];
  closure: { id: string; closed_by: string | null; closed_at: string } | null;
  state: {
    kind: string;
    activeAttempt: SalesFollowupAttempt | null;
    nextAttemptNumber: number;
    nextAction: string | null;
  };
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return format(d, "d MMM yyyy, h:mm a");
}

const TONE_CLASS: Record<string, string> = {
  info: "bg-blue-600/10 text-blue-700 border-blue-600/30 dark:text-blue-300",
  warning: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300",
  success: "bg-green-600/10 text-green-700 border-green-600/30 dark:text-green-300",
};

export function FollowupHistoryDialog({
  open,
  onOpenChange,
  flowId,
  runId,
  leadName,
  onRecordResult,
  onScheduleNext,
  refreshSeq,
}: FollowupHistoryDialogProps) {
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/flows/${flowId}/sales-followups?flow_run_id=${encodeURIComponent(runId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json().catch(() => null)) as HistoryState & {
        error?: string;
      };
      if (!res.ok) throw new Error(json?.error ?? "Could not load history.");
      setHistory(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load history.");
    } finally {
      setLoading(false);
    }
  }, [flowId, runId]);

  useEffect(() => {
    if (!open) return;
    setHistory(null);
    void reload();
  }, [open, refreshSeq, reload]);

  async function handleCloseToggle() {
    const isClosed = history?.closure !== null;
    setClosing(true);
    setError(null);
    try {
      const res = isClosed
        ? await fetch(
            `/api/flows/${flowId}/sales-followups/closure?flow_run_id=${encodeURIComponent(runId)}`,
            { method: "DELETE" },
          )
        : await fetch(`/api/flows/${flowId}/sales-followups/closure`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ flow_run_id: runId }),
          });
      const json = (await res.json().catch(() => null)) as { error?: string };
      if (!res.ok) throw new Error(json?.error ?? "Could not update the sequence.");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the sequence.");
    } finally {
      setClosing(false);
    }
  }

  const active = history?.state.activeAttempt ?? null;
  const activeStatus = active ? attemptStatus(active) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Follow-up History{leadName?.trim() ? ` — ${leadName.trim()}` : ""}
          </DialogTitle>
          <DialogDescription>
            Every scheduled attempt in order, with its outcome and result.
          </DialogDescription>
        </DialogHeader>

        {loading && !history ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading history…</p>
        ) : error !== null && !history ? (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : history && history.attempts.length === 0 ? (
          <div className="grid gap-3 py-2">
            <p className="text-sm text-muted-foreground">
              No follow-ups scheduled yet for this lead.
            </p>
            <Button type="button" onClick={onScheduleNext} className="w-full sm:w-auto">
              <CalendarPlus className="h-4 w-4" />
              Schedule Follow-up 1
            </Button>
          </div>
        ) : history ? (
          <div className="grid gap-4">
            <ol className="grid gap-4">
              {history.attempts.map((attempt) => {
                const badge = badgeForAttempt(attempt);
                return (
                  <li
                    key={attempt.id}
                    className="grid gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold tabular-nums">
                        Follow-up {attempt.attempt_number}
                      </span>
                      <Badge variant="outline" className={cn("text-xs", TONE_CLASS[badge.tone])}>
                        {badge.label}
                      </Badge>
                    </div>
                    <dl className="grid gap-1 text-sm">
                      <div className="flex justify-between gap-4">
                        <dt className="shrink-0 text-muted-foreground">Scheduled</dt>
                        <dd className="text-right font-medium tabular-nums">
                          {formatInstant(attempt.scheduled_at)}
                        </dd>
                      </div>
                      {attempt.outcome !== null && (
                        <div className="flex justify-between gap-4">
                          <dt className="shrink-0 text-muted-foreground">Outcome</dt>
                          <dd className="text-right font-medium">{attempt.outcome}</dd>
                        </div>
                      )}
                      {attempt.completed_at !== null && (
                        <div className="flex justify-between gap-4">
                          <dt className="shrink-0 text-muted-foreground">Completed</dt>
                          <dd className="text-right font-medium tabular-nums">
                            {formatInstant(attempt.completed_at)}
                          </dd>
                        </div>
                      )}
                      {attempt.rescheduled_from !== null && (
                        <div className="flex justify-between gap-4">
                          <dt className="shrink-0 text-muted-foreground">Rescheduled from</dt>
                          <dd className="text-right tabular-nums">
                            {formatInstant(attempt.rescheduled_from)}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {attempt.result_text !== null && (
                      <p className="text-sm break-words whitespace-pre-wrap">
                        {attempt.result_text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>

            {history.closure !== null && (
              <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                Sequence closed{history.closure.closed_at ? ` on ${formatInstant(history.closure.closed_at)}` : ""}. History is preserved.
              </p>
            )}

            {error !== null && (
              <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {active !== null && activeStatus === "result_required" && (
                <Button type="button" onClick={() => onRecordResult(active)}>
                  <ClipboardList className="h-4 w-4" />
                  Record Result — Follow-up {active.attempt_number}
                </Button>
              )}
              {history.closure === null &&
                (history.state.kind === "none" || history.state.kind === "completed") && (
                  <Button type="button" variant="outline" onClick={onScheduleNext}>
                    <CalendarPlus className="h-4 w-4" />
                    Schedule Follow-up {history.state.nextAttemptNumber}
                  </Button>
                )}
              <Button
                type="button"
                variant="ghost"
                disabled={closing || loading}
                onClick={() => void handleCloseToggle()}
                className="sm:ml-auto"
              >
                {closing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : history.closure !== null ? (
                  <LockOpen className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                {history.closure !== null ? "Reopen sequence" : "Close sequence"}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
