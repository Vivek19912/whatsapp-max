"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { localDayWindow, localDayWindowOffset, type FollowupKpiBucket } from "@/lib/followups/workspace-link";

export interface FollowupKpiCounts {
  overdue: number;
  today: number;
  tomorrow: number;
  upcoming: number;
}

const EMPTY_COUNTS: FollowupKpiCounts = { overdue: 0, today: 0, tomorrow: 0, upcoming: 0 };

/**
 * Four summary cards: identical height, label-over-count hierarchy,
 * neutral surfaces, one restrained accent per card. No icons.
 * Counts always come from the server (never derived from the
 * visible page), covering every lead in the selected table.
 * When `onSelectBucket` is provided the cards act as single-select
 * filters (click the active card again to clear); `activeBucket`
 * drives the selected styling + aria-pressed state.
 */
export function FollowupKpiCards({
  counts,
  loading,
  error,
  onRetry,
  activeBucket = null,
  onSelectBucket,
}: {
  counts: FollowupKpiCounts;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  activeBucket?: FollowupKpiBucket | null;
  onSelectBucket?: (bucket: FollowupKpiBucket | null) => void;
}) {
  const cards: Array<{
    id: FollowupKpiBucket;
    label: string;
    count: number;
    tone: string;
  }> = [
    { id: "overdue", label: "Overdue", count: counts.overdue, tone: "text-red-600 dark:text-red-400" },
    { id: "today", label: "Due Today", count: counts.today, tone: "text-amber-600 dark:text-amber-400" },
    { id: "tomorrow", label: "Tomorrow", count: counts.tomorrow, tone: "text-violet-600 dark:text-violet-400" },
    { id: "upcoming", label: "Upcoming", count: counts.upcoming, tone: "text-blue-600 dark:text-blue-400" },
  ];
  const interactive = typeof onSelectBucket === "function";
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" role="group" aria-label="Follow-up workload">
      {cards.map((c) => {
        const selected = activeBucket === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={interactive ? () => onSelectBucket(selected ? null : c.id) : undefined}
            aria-pressed={interactive ? selected : undefined}
            aria-label={interactive ? `Filter by ${c.label}` : undefined}
            className={cn(
              "flex min-h-[80px] flex-col justify-center gap-1 rounded-[10px] border bg-card px-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-primary/60 bg-primary/[0.04]"
                : "border-border",
              interactive ? "cursor-pointer hover:border-muted-foreground/30" : "cursor-default",
            )}
          >
            <span className={cn("text-[11px] font-semibold uppercase tracking-[0.08em]", c.tone)}>
              {c.label}
            </span>
            <span className="text-[26px] font-semibold leading-8 tabular-nums text-foreground">
              {loading ? (
                <span className="inline-block h-7 w-12 animate-pulse rounded bg-muted" aria-label="Loading" />
              ) : error ? (
                <span className="text-sm font-medium text-muted-foreground">—</span>
              ) : (
                c.count
              )}
            </span>
          </button>
        );
      })}
      {error && !loading ? (
        <div className="col-span-full flex items-center gap-2 text-xs text-muted-foreground" role="alert">
          <span>Follow-up counts are unavailable.</span>
          <Button variant="ghost" size="sm" onClick={onRetry} className="h-7 px-2 text-xs">
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Workspace Leads KPI strip. Server-aggregated over every lead in
 * the selected Meta Lead Ads table (never the visible page), keyed
 * by table + follow-up column so switching tables can never flash
 * stale counts. Refreshes whenever the parent's refreshSeq ticks
 * (save / reschedule / clear / realtime update).
 */
export function WorkspaceFollowupKpis({
  flowId,
  followupFieldId,
  refreshSeq,
  activeBucket = null,
  onSelectBucket,
}: {
  flowId: string;
  followupFieldId: string;
  refreshSeq: number;
  activeBucket?: FollowupKpiBucket | null;
  onSelectBucket?: (bucket: FollowupKpiBucket | null) => void;
}) {
  const [counts, setCounts] = useState<FollowupKpiCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Viewer-local day windows (same convention as the scheduling UI).
  const windowQuery = useMemo(() => {
    const now = new Date();
    const today = localDayWindow(now);
    const tomorrow = localDayWindowOffset(now, 1);
    const qs = new URLSearchParams({
      todayStart: today.start,
      todayEnd: today.end,
      tomorrowStart: tomorrow.start,
      tomorrowEnd: tomorrow.end,
    });
    return qs.toString();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/followup-counts?${windowQuery}`, {
        cache: "no-store",
      });
      const payload = (await res.json().catch(() => null)) as (Partial<FollowupKpiCounts> & {
        error?: string;
      }) | null;
      if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
      setCounts({
        overdue: Number(payload?.overdue ?? 0) || 0,
        today: Number(payload?.today ?? 0) || 0,
        tomorrow: Number(payload?.tomorrow ?? 0) || 0,
        upcoming: Number(payload?.upcoming ?? 0) || 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load follow-up counts");
    } finally {
      setLoading(false);
    }
  }, [flowId, windowQuery]);

  useEffect(() => {
    void load();
  }, [load, refreshSeq, followupFieldId]);

  return (
    <FollowupKpiCards
      counts={counts}
      loading={loading}
      error={error}
      onRetry={() => void load()}
      activeBucket={activeBucket}
      onSelectBucket={onSelectBucket}
    />
  );
}
