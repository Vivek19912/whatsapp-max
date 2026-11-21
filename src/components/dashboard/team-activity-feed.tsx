"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  CalendarCheck,
  CheckCircle2,
  MessageCircle,
  Search,
  StickyNote,
  UserCheck,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import {
  TEAM_ACTIVITY_TYPES,
  type TeamActivityItem,
  type TeamActivityMember,
  type TeamActivityTable,
  type TeamActivityType,
} from "@/lib/meta-lead-ads/team-activity";
import {
  resolveTeamDateRange,
  type TeamDatePreset,
} from "@/lib/meta-leads-dashboard/team-performance-client";

const PRESETS: Array<{ value: TeamDatePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 Days" },
  { value: "last30", label: "Last 30 Days" },
  { value: "thisMonth", label: "This Month" },
  { value: "lastMonth", label: "Last Month" },
  { value: "custom", label: "Custom Date Range" },
  { value: "allTime", label: "All Time" },
];

const TYPE_ICON: Record<TeamActivityType, { Icon: typeof UserPlus; bg: string }> = {
  lead_assigned: { Icon: UserPlus, bg: "bg-emerald-600" },
  lead_reassigned: { Icon: UserCheck, bg: "bg-blue-600" },
  lead_unassigned: { Icon: UserMinus, bg: "bg-zinc-500" },
  followup_scheduled: { Icon: CalendarCheck, bg: "bg-orange-600" },
  note_added: { Icon: StickyNote, bg: "bg-purple-600" },
  whatsapp_sent: { Icon: MessageCircle, bg: "bg-green-600" },
};

function formatActivityTime(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const now = new Date();
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const time = d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (day(d) === day(now)) return `Today, ${time}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day(d) === day(y)) return `Yesterday, ${time}`;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function initials(name: string): string {
  const t = name.trim();
  return t === "" ? "?" : t.charAt(0).toUpperCase();
}

interface FilterState {
  search: string;
  member: string;
  activityType: string;
  tableId: string;
  from: string | null;
  to: string | null;
}

export function TeamActivityFeed() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [member, setMember] = useState("");
  const [activityType, setActivityType] = useState("");
  const [tableId, setTableId] = useState("");
  const [preset, setPreset] = useState<TeamDatePreset>("last30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [activities, setActivities] = useState<TeamActivityItem[]>([]);
  const [members, setMembers] = useState<TeamActivityMember[]>([]);
  const [tables, setTables] = useState<TeamActivityTable[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => window.clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(
    async (filters: FilterState, cursor: string | null, signal?: AbortSignal) => {
      const tz =
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
          : "UTC";
      const qs = new URLSearchParams({ tz, limit: "20" });
      if (filters.search) qs.set("search", filters.search);
      if (filters.member) qs.set("member", filters.member);
      if (filters.activityType) qs.set("activityType", filters.activityType);
      if (filters.tableId) qs.set("tableId", filters.tableId);
      if (filters.from && filters.to) {
        qs.set("from", filters.from);
        qs.set("to", filters.to);
      }
      if (cursor) qs.set("cursor", cursor);
      const res = await fetch(`/api/meta-lead-ads/team-activity?${qs.toString()}`, {
        signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`activity ${res.status}`);
      return (await res.json()) as {
        activities?: unknown;
        nextCursor?: unknown;
        hasMore?: unknown;
        members?: Array<{ userId?: unknown; name?: unknown }>;
        tables?: Array<{ flowId?: unknown; name?: unknown }>;
      };
    },
    [],
  );

  const normalizeItems = useCallback((raw: unknown): TeamActivityItem[] => {
    if (!Array.isArray(raw)) return [];
    const valid: TeamActivityItem[] = [];
    for (const e of raw) {
      if (!e || typeof e !== "object") continue;
      const er = e as Record<string, unknown>;
      if (
        typeof er.id !== "string" ||
        typeof er.timestamp !== "string" ||
        typeof er.actorId !== "string" ||
        typeof er.actorName !== "string" ||
        typeof er.title !== "string" ||
        typeof er.description !== "string" ||
        typeof er.type !== "string"
      ) {
        continue;
      }
      valid.push({
        id: er.id,
        type: er.type as TeamActivityType,
        title: er.title,
        description: er.description,
        timestamp: er.timestamp,
        actorId: er.actorId,
        actorName: er.actorName,
        leadName: typeof er.leadName === "string" ? er.leadName : null,
        leadId: typeof er.leadId === "string" ? er.leadId : null,
        tableId: typeof er.tableId === "string" ? er.tableId : null,
        tableName: typeof er.tableName === "string" ? er.tableName : null,
      });
    }
    return valid;
  }, []);

  // Fresh load whenever any filter changes (cursor resets; other
  // filters are preserved because they all live in state).
  useEffect(() => {
    const range = resolveTeamDateRange(
      preset,
      new Date(),
      customFrom || undefined,
      customTo || undefined,
    );
    const filters: FilterState = {
      search: debouncedSearch,
      member,
      activityType,
      tableId,
      from: range.from,
      to: range.to,
    };
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetchPage(filters, null, ctrl.signal)
      .then((json) => {
        setActivities(normalizeItems(json.activities));
        setNextCursor(typeof json.nextCursor === "string" ? json.nextCursor : null);
        setHasMore(json.hasMore === true);
        if (Array.isArray(json.members)) {
          setMembers(
            json.members
              .filter((m) => typeof m.userId === "string")
              .map((m) => ({
                userId: m.userId as string,
                name: typeof m.name === "string" && m.name !== "" ? m.name : "Team member",
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
        }
        if (Array.isArray(json.tables)) {
          setTables(
            json.tables
              .filter((t) => typeof t.flowId === "string")
              .map((t) => ({
                flowId: t.flowId as string,
                name: typeof t.name === "string" && t.name !== "" ? t.name : "Untitled Table",
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError("Failed to load Workspace activity.");
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [debouncedSearch, member, activityType, tableId, preset, customFrom, customTo, fetchPage, normalizeItems]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    const range = resolveTeamDateRange(
      preset,
      new Date(),
      customFrom || undefined,
      customTo || undefined,
    );
    setLoadingMore(true);
    void fetchPage(
      {
        search: debouncedSearch,
        member,
        activityType,
        tableId,
        from: range.from,
        to: range.to,
      },
      nextCursor,
    )
      .then((json) => {
        const items = normalizeItems(json.activities);
        setActivities((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...items.filter((a) => !seen.has(a.id))];
        });
        setNextCursor(typeof json.nextCursor === "string" ? json.nextCursor : null);
        setHasMore(json.hasMore === true);
      })
      .catch(() => setError("Failed to load more activities."))
      .finally(() => setLoadingMore(false));
  }, [nextCursor, loadingMore, debouncedSearch, member, activityType, tableId, preset, customFrom, customTo, fetchPage, normalizeItems]);

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    const range = resolveTeamDateRange(
      preset,
      new Date(),
      customFrom || undefined,
      customTo || undefined,
    );
    void fetchPage(
      {
        search: debouncedSearch,
        member,
        activityType,
        tableId,
        from: range.from,
        to: range.to,
      },
      null,
    )
      .then((json) => {
        setActivities(normalizeItems(json.activities));
        setNextCursor(typeof json.nextCursor === "string" ? json.nextCursor : null);
        setHasMore(json.hasMore === true);
      })
      .catch(() => setError("Failed to load Workspace activity."))
      .finally(() => setLoading(false));
  }, [debouncedSearch, member, activityType, tableId, preset, customFrom, customTo, fetchPage, normalizeItems]);

  const hasActiveFilters =
    debouncedSearch !== "" ||
    member !== "" ||
    activityType !== "" ||
    tableId !== "" ||
    preset !== "last30" ||
    customFrom !== "" ||
    customTo !== "";

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setMember("");
    setActivityType("");
    setTableId("");
    setPreset("last30");
    setCustomFrom("");
    setCustomTo("");
  };

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      aria-label="Workspace Activity"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <Activity className="h-4 w-4 text-violet-500" aria-hidden />
          Workspace Activity
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Real-time activity from your Workspace — every action by team members.
        </p>
      </div>

      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-52 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search activity, lead name or table..."
              aria-label="Search activity, lead name or table"
              className="h-9 w-full rounded-lg border border-input bg-background pr-2 pl-8 text-sm text-foreground"
            />
          </label>
          <select
            value={member}
            onChange={(e) => setMember(e.target.value)}
            aria-label="Filter by team member"
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="">All Team Members</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            value={activityType}
            onChange={(e) => setActivityType(e.target.value)}
            aria-label="Filter by activity type"
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="">All Activities</option>
            {TEAM_ACTIVITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <select
            value={tableId}
            onChange={(e) => setTableId(e.target.value)}
            aria-label="Filter by Meta Lead Ads table"
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="">All Tables</option>
            {tables.map((t) => (
              <option key={t.flowId} value={t.flowId}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as TeamDatePreset)}
            aria-label="Filter by activity date"
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} aria-label="Clear filters">
              <X className="h-4 w-4" aria-hidden /> Clear
            </Button>
          )}
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="Custom from date"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            />
            <span className="text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="Custom to date"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            />
          </div>
        )}

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}{" "}
            <Button variant="link" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        ) : activities.length === 0 ? (
          <EmptyState
            title="No matching activities"
            hint="Try a different search, filter, or date range. Owner actions never appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-[13px] text-muted-foreground">
                  <th className="w-40 px-3 py-2.5 font-medium">Time</th>
                  <th className="px-3 py-2.5 font-medium">Activity</th>
                  <th className="w-44 px-3 py-2.5 text-right font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {activities.map((a) => {
                  const meta = TYPE_ICON[a.type] ?? { Icon: CheckCircle2, bg: "bg-zinc-500" };
                  const { Icon } = meta;
                  return (
                    <tr key={a.id} className="align-top hover:bg-muted/30">
                      <td className="px-3 py-3 whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatActivityTime(a.timestamp)}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-start gap-3">
                          <span
                            className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white ${meta.bg}`}
                          >
                            <Icon className="h-4 w-4" aria-hidden />
                          </span>
                          <span>
                            <span className="block font-semibold text-foreground">{a.title}</span>
                            <span className="mt-0.5 block text-[13px] text-muted-foreground">
                              {a.description}
                            </span>
                            {(a.leadName || a.tableName) && (
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {a.leadName ? (
                                  <span>
                                    Lead: <span className="font-medium text-foreground">{a.leadName}</span>
                                  </span>
                                ) : null}
                                {a.leadName && a.tableName ? <span> · </span> : null}
                                {a.tableName ? <span>Table: {a.tableName}</span> : null}
                              </span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <span className="flex items-center justify-end gap-2">
                          <span
                            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground"
                            aria-hidden
                          >
                            {initials(a.actorName)}
                          </span>
                          <span className="max-w-32 truncate font-medium text-foreground" title={a.actorName}>
                            {a.actorName}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {hasMore && !loading && !error && (
          <div className="flex justify-center pt-1">
            <Button variant="outline" size="sm" disabled={loadingMore || !nextCursor} onClick={loadMore}>
              {loadingMore ? "Loading…" : "Load More"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
