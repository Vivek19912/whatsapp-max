'use client';

import { Phone } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Skeleton } from '@/components/dashboard/skeleton';
import { KpiCard } from '@/components/calls/dashboard/kpi-card';
import { TrendChart } from '@/components/calls/dashboard/trend-chart';
import { DirectionDonut } from '@/components/calls/dashboard/direction-donut';
import { OutcomeDonut } from '@/components/calls/dashboard/outcome-donut';
import { SalespersonTable } from '@/components/calls/dashboard/salesperson-table';
import {
  HourlyChart,
  WeekdayChart,
} from '@/components/calls/dashboard/activity-charts';
import { RecentCallsTable } from '@/components/calls/dashboard/recent-calls';
import { RecordingsToolbar } from '@/components/recordings/recordings-toolbar';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { getCallsRange } from '@/lib/calls/ranges';
import { formatShortDuration } from '@/lib/calls/formatters';
import { mergeSalespersonRows } from '@/lib/calls/aggregate';
import {
  loadMemberOptions,
  loadWorkspaceTableOptions,
  resetRecordingsFilters,
  type MemberOption,
  type RecordingsFilters,
  type WorkspaceTableOption,
} from '@/lib/recordings/library';
import {
  loadCallsStats,
  type CallsStatsResult,
  type SalespersonRow,
} from '@/lib/calls/client';

/**
 * Calls dashboard: one shared filter state (the Recordings
 * toolbar) drives every section. Totals/outcomes/salesperson
 * numbers are exact server-side RPCs; hourly, weekday, trend and
 * recent rows derive from the same bounded fetch, so every panel
 * describes the same filtered set.
 */
export default function CallsPage() {
  const tz = useMemo(
    () =>
      typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : 'UTC',
    []
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [filters, setFilters] = useState<RecordingsFilters>(
    resetRecordingsFilters()
  );
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [tables, setTables] = useState<WorkspaceTableOption[]>([]);
  const [stats, setStats] = useState<CallsStatsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const debouncedQ = useDebouncedValue(filters.q, 300);
  const range = useMemo(
    () =>
      getCallsRange(filters.rangeKey, nowMs, tz, {
        fromInput: filters.customFrom,
        toInput: filters.customTo,
      }),
    [filters.rangeKey, filters.customFrom, filters.customTo, nowMs, tz]
  );
  const effectiveFilters = useMemo(
    () => ({ ...filters, q: debouncedQ }),
    [filters, debouncedQ]
  );

  const fetchAll = useCallback(async () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const dashboard = await loadCallsStats({
        fromISO: range.fromISO,
        toISO: range.toISO,
        user: effectiveFilters.uploadedBy,
        direction: effectiveFilters.direction,
        timeZone: tz,
        q: effectiveFilters.q.trim() || undefined,
        callType: effectiveFilters.callType,
        workspaceTable: effectiveFilters.workspaceTable,
        status: effectiveFilters.status,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setStats(dashboard);
    } catch (err) {
      if (controller.signal.aborted) return;
      setStats(null);
      setError(
        err instanceof Error ? err.message : 'Failed to load call analytics'
      );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
    return () => controller.abort();
  }, [range, effectiveFilters, tz]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void fetchAll().then((c) => {
      cleanup = c;
    });
    return () => cleanup?.();
  }, [fetchAll]);

  useEffect(() => {
    const controller = new AbortController();
    void loadMemberOptions(controller.signal)
      .then(setMembers)
      .catch(() => undefined);
    void loadWorkspaceTableOptions(controller.signal)
      .then(setTables)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // Re-anchor "now" when the tab regains focus so Today stays current.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNowMs(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Every authorized salesperson appears: assigned rows from the
  // server plus zero-activity roster members, sorted by volume.
  const salespersonRows: SalespersonRow[] | null = useMemo(() => {
    if (!stats) return null;
    return mergeSalespersonRows(stats.salesperson, members);
  }, [stats, members]);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-600 text-white">
            <Phone className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">
              Calls Dashboard
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Complete call insights for your team. Track volume, performance
              and calling activity.
            </p>
          </div>
        </div>
      </div>

      <RecordingsToolbar
        filters={filters}
        onChange={setFilters}
        nowMs={nowMs}
        timeZone={tz}
        members={members}
        tables={tables}
      />

      {stats?.truncated && !loading ? (
        <p className="text-muted-foreground text-xs">
          Very large result set — charts and lists show the most recent 5,000
          recordings; the KPI cards are exact.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-xl border p-4 text-sm"
        >
          {error}{' '}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => void fetchAll()}
          >
            Retry
          </button>
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4 2xl:grid-cols-7">
            {loading || !stats ? (
              Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} className="h-[104px] w-full rounded-xl" />
              ))
            ) : (
              <>
                <KpiCard
                  label="Total Calls"
                  value={stats.recordingCount.toLocaleString('en-US')}
                />
                <KpiCard
                  label="Total Call Duration"
                  value={formatShortDuration(stats.recordingDurationSecs)}
                />
                <KpiCard
                  label="Phone Calls"
                  value={stats.phoneRecordings.toLocaleString('en-US')}
                />
                <KpiCard
                  label="WhatsApp Calls"
                  value={(
                    stats.whatsappRecordings + stats.whatsappBusinessRecordings
                  ).toLocaleString('en-US')}
                />
                <KpiCard
                  label="Outgoing Calls"
                  value={stats.outgoingRecordings.toLocaleString('en-US')}
                />
                <KpiCard
                  label="Incoming Calls"
                  value={stats.incomingRecordings.toLocaleString('en-US')}
                />
                <KpiCard
                  label="Missed Calls"
                  value={stats.missedRecordings.toLocaleString('en-US')}
                />
              </>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="xl:col-span-5">
              <TrendChart
                buckets={stats?.trend.buckets ?? null}
                loading={loading}
              />
            </div>
            <div className="xl:col-span-3">
              <OutcomeDonut
                answered={stats?.answeredEvents ?? 0}
                missed={stats?.missedRecordings ?? 0}
                unknown={stats?.unknownEvents ?? 0}
                loading={loading}
              />
            </div>
            <div className="xl:col-span-4">
              <DirectionDonut
                inbound={stats?.incomingRecordings ?? 0}
                outbound={stats?.outgoingRecordings ?? 0}
                unknown={stats?.unknownDirectionRecordings ?? 0}
                loading={loading}
                title="Call Direction"
                subtitle="Inbound vs outbound calls"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="xl:col-span-6">
              <SalespersonTable rows={salespersonRows} loading={loading} />
            </div>
            <div className="xl:col-span-3">
              <HourlyChart data={stats?.hourly ?? null} loading={loading} />
            </div>
            <div className="xl:col-span-3">
              <WeekdayChart data={stats?.weekday ?? null} loading={loading} />
            </div>
          </div>

          <RecentCallsTable
            recent={stats?.recent ?? null}
            missed={stats?.recentMissed ?? null}
            loading={loading}
          />
        </>
      )}
    </div>
  );
}
