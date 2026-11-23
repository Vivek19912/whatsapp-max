"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarOff,
  CalendarPlus,
  Crown,
  Info,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  UserCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { SkeletonCard } from "@/components/dashboard/skeleton";
import {
  avatarToneFor,
  initialsFor,
  normalizeAssignmentTableRow,
} from "@/lib/lead-assignment/table-overview";
import {
  excludeOnHoliday,
  normalizeAdjustedPercentages,
} from "@/lib/lead-assignment/holidays";
import { cn } from "@/lib/utils";

interface HolidayWindow {
  id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: "upcoming" | "active" | "completed" | "cancelled";
}

interface TeamMember {
  user_id: string;
  full_name: string;
  role: string;
  availability: "available" | "on_holiday";
  holidays: HolidayWindow[];
  affects_tables: string[];
}

interface OverviewData {
  today: string;
  kpis: {
    totalMembers: number;
    onHoliday: number;
    availableToday: number;
    assignmentsAdjusted: number;
  };
  members: TeamMember[];
}

interface PreviewTable {
  flowId: string;
  tableName: string;
  mode: "round_robin" | "percentage";
  assignees: Array<{ id: string; user_id: string | null; display_name: string; weight: number }>;
}

type MemberTab = "all" | "on_holiday" | "available";

/** "Nov 25, 2026" — date-only values parsed at UTC noon so the IST wall date never shifts. */
function formatDay(isoDate: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(`${isoDate}T12:00:00Z`));
  } catch {
    return isoDate;
  }
}

function formatRange(start: string, end: string): string {
  return start === end ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`;
}

function roleLabel(role: string): string {
  return role.length > 0 ? role.charAt(0).toUpperCase() + role.slice(1) : role;
}

export default function TeamAvailabilityPage() {
  const { accountRole, profileLoading } = useAuth();
  const isOwner = !profileLoading && accountRole === "owner";
  const isDenied = !profileLoading && accountRole !== "owner";

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [tables, setTables] = useState<PreviewTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [memberId, setMemberId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const [tab, setTab] = useState<MemberTab>("all");
  const [search, setSearch] = useState("");

  const reload = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/team-availability/overview", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (OverviewData & { error?: string }) | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not load team availability.");
      if (!body || !Array.isArray(body.members)) throw new Error("Could not load team availability.");
      setOverview(body);
      // Assignment tables feed the adjustment preview only — a
      // failure here falls back to an illustrative example and
      // never blocks holiday management.
      try {
        const tRes = await fetch("/api/workspace/table-assignments", { cache: "no-store" });
        const tBody = (await tRes.json().catch(() => null)) as { tables?: unknown } | null;
        if (tRes.ok && Array.isArray(tBody?.tables)) {
          const normalized = (tBody?.tables as unknown[])
            .map((t) => normalizeAssignmentTableRow(t))
            .filter((t): t is NonNullable<typeof t> => t !== null);
          setTables(
            normalized.map((t) => ({
              flowId: t.flowId,
              tableName: t.tableName,
              mode: t.config?.mode ?? "round_robin",
              assignees: t.assignees.map((a) => ({
                id: a.id,
                user_id: a.user_id,
                display_name: a.display_name,
                weight: a.weight,
              })),
            })),
          );
        }
      } catch {
        setTables([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load team availability.");
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [isOwner]);

  useEffect(() => {
    if (!isOwner) return;
    void reload();
  }, [isOwner, reload]);

  const members = useMemo(() => overview?.members ?? [], [overview]);
  // Display label for the member dropdown trigger: the Select
  // keeps the stable user UUID as its value (submitted as-is),
  // while the visible trigger resolves back to the full name.
  // Undefined = no selection (placeholder) or unknown member.
  const selectedMemberName = useMemo(
    () =>
      memberId === ""
        ? undefined
        : (members.find((m) => m.user_id === memberId)?.full_name ?? undefined),
    [members, memberId],
  );
  const onHolidayIds = useMemo(
    () => new Set(members.filter((m) => m.availability === "on_holiday").map((m) => m.user_id)),
    [members],
  );

  const tabCounts = useMemo(
    () => ({
      all: members.length,
      on_holiday: members.filter((m) => m.availability === "on_holiday").length,
      available: members.filter((m) => m.availability === "available").length,
    }),
    [members],
  );

  const visibleMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (tab !== "all" && m.availability !== tab) return false;
      if (q !== "" && !m.full_name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [members, tab, search]);

  const resetForm = useCallback(() => {
    setMemberId("");
    setStartDate("");
    setEndDate("");
    setReason("");
    setFormError(null);
    setEditingId(null);
  }, []);

  const submitHoliday = useCallback(async () => {
    setFormError(null);
    if (editingId === null && memberId === "") {
      setFormError("Select a team member.");
      return;
    }
    if (startDate === "" || endDate === "") {
      setFormError("Holiday start and end dates are required.");
      return;
    }
    if (endDate < startDate) {
      setFormError("Holiday end date cannot be earlier than the start date.");
      return;
    }
    setSaving(true);
    try {
      const url = editingId
        ? `/api/team-availability/holidays/${encodeURIComponent(editingId)}`
        : "/api/team-availability/holidays";
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editingId
            ? { start_date: startDate, end_date: endDate, reason }
            : { user_id: memberId, start_date: startDate, end_date: endDate, reason },
        ),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not save the holiday.");
      toast.success(editingId ? "Holiday updated." : "Holiday recorded. New leads will skip this member while away.");
      resetForm();
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save the holiday.");
    } finally {
      setSaving(false);
    }
  }, [editingId, memberId, startDate, endDate, reason, reload, resetForm]);

  const startEdit = useCallback((member: TeamMember) => {
    const live =
      member.holidays.find((w) => w.status === "active") ??
      member.holidays.filter((w) => w.status === "upcoming").sort((a, b) => (a.start_date < b.start_date ? -1 : 1))[0] ??
      null;
    if (!live) {
      toast.error("No editable holiday for this member.");
      return;
    }
    setEditingId(live.id);
    setMemberId(member.user_id);
    setStartDate(live.start_date);
    setEndDate(live.end_date);
    setReason(live.reason ?? "");
    setFormError(null);
  }, []);

  const cancelHoliday = useCallback(
    async (member: TeamMember) => {
      const live =
        member.holidays.find((w) => w.status === "active") ??
        member.holidays.filter((w) => w.status === "upcoming").sort((a, b) => (a.start_date < b.start_date ? -1 : 1))[0] ??
        null;
      if (!live) {
        toast.error("No live holiday to cancel for this member.");
        return;
      }
      setRowBusy(member.user_id);
      try {
        const res = await fetch(
          `/api/team-availability/holidays/${encodeURIComponent(live.id)}/cancel`,
          { method: "POST" },
        );
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(body?.error ?? "Could not cancel the holiday.");
        toast.success(
          live.status === "active" ? "Holiday ended. The member receives new leads again." : "Holiday cancelled.",
        );
        if (editingId === live.id) resetForm();
        await reload();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not cancel the holiday.");
      } finally {
        setRowBusy(null);
      }
    },
    [editingId, reload, resetForm],
  );

  // --- Assignment Adjustment Preview (real configs; illustrative fallback) ---
  const preview = useMemo(() => {
    const internal = (t: PreviewTable) => t.assignees.filter((a) => typeof a.user_id === "string");
    const rrCandidate = tables.find((t) => {
      if (t.mode !== "round_robin") return false;
      const names = internal(t);
      if (names.length < 2) return false;
      const holidayHere = names.filter((a) => a.user_id && onHolidayIds.has(a.user_id));
      const availableHere = names.filter((a) => !(a.user_id && onHolidayIds.has(a.user_id)));
      return holidayHere.length > 0 && availableHere.length > 0;
    });
    const pctCandidate = tables.find((t) => {
      if (t.mode !== "percentage") return false;
      const pool = t.assignees.filter((a) => !(a.user_id && onHolidayIds.has(a.user_id)) && a.weight > 0);
      const holidayHere = t.assignees.filter((a) => a.user_id && onHolidayIds.has(a.user_id));
      return holidayHere.length > 0 && pool.length > 0;
    });
    if (!rrCandidate && !pctCandidate) return null;
    const holidayName = (t: PreviewTable) => {
      const h = t.assignees.find((a) => a.user_id && onHolidayIds.has(a.user_id));
      return h?.display_name ?? "On holiday";
    };
    return { rrCandidate, pctCandidate, holidayName };
  }, [tables, onHolidayIds]);

  if (profileLoading) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Team Availability</h1>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SkeletonCard key="t1" />
          <SkeletonCard key="t2" />
          <SkeletonCard key="t3" />
          <SkeletonCard key="t4" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Team Availability</h1>
        <EmptyState title="Owner only" hint="Only the account owner can manage team availability." />
      </div>
    );
  }

  const kpis = overview?.kpis;

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Team Availability</h1>
          <Badge variant="secondary" className="gap-1 text-blue-700">
            <Crown className="h-3 w-3" aria-hidden />
            Owner only
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage team member holidays and automatically adjust lead assignment for Round Robin and Percentage tables.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Total Team Members" value={loading ? 0 : (kpis?.totalMembers ?? 0)} icon={Users} loading={loading} />
        <KpiCard title="Available Today" value={loading ? 0 : (kpis?.availableToday ?? 0)} icon={UserCheck} loading={loading} />
        <KpiCard title="On Holiday" value={loading ? 0 : (kpis?.onHoliday ?? 0)} icon={CalendarOff} loading={loading} />
        <KpiCard title="Assignments Adjusted" value={loading ? 0 : (kpis?.assignmentsAdjusted ?? 0)} icon={RefreshCw} loading={loading} />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      ) : loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
          {/* Left: Add / Edit Holiday */}
          <div className="border-border bg-card rounded-xl border p-5">
            <h2 className="text-base font-semibold text-foreground">
              {editingId ? "Edit Holiday / Leave" : "Add Holiday / Leave"}
            </h2>
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-foreground" htmlFor="holiday-member">
                  Team Member <span className="text-destructive">*</span>
                </label>
                <Select value={memberId} onValueChange={(v) => setMemberId(v ?? "")} disabled={editingId !== null}>
                  <SelectTrigger id="holiday-member" className="h-9 w-full text-sm">
                    <SelectValue placeholder="Select a team member">
                      {selectedMemberName}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {members.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.full_name}
                        {m.availability === "on_holiday" ? " (On Holiday)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-foreground" id="holiday-period-label">
                  Holiday Period <span className="text-destructive">*</span>
                </span>
                <div className="flex items-center gap-2" role="group" aria-labelledby="holiday-period-label">
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    aria-label="Holiday start date"
                    className="h-9 text-sm"
                  />
                  <span className="shrink-0 text-muted-foreground" aria-hidden>–</span>
                  <Input
                    type="date"
                    value={endDate}
                    min={startDate || undefined}
                    onChange={(e) => setEndDate(e.target.value)}
                    aria-label="Holiday end date"
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-foreground" htmlFor="holiday-reason">
                  Reason (optional)
                </label>
                <Input
                  id="holiday-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Annual leave"
                  maxLength={500}
                  className="h-9 text-sm"
                />
              </div>
              <p className="rounded-lg bg-blue-500/10 px-3 py-2.5 text-xs leading-relaxed text-blue-800 dark:text-blue-300">
                During this period, the selected member will be automatically excluded from new lead
                assignment in all tables and the allocation will be adjusted among available team members.
              </p>
              {formError ? (
                <p className="text-sm text-destructive" role="alert">{formError}</p>
              ) : null}
              <div className="flex flex-col gap-2">
                <Button type="button" onClick={() => void submitHoliday()} disabled={saving} className="w-full">
                  <CalendarPlus className="h-4 w-4" aria-hidden />
                  {saving ? "Saving…" : editingId ? "Update Holiday" : "Set Holiday"}
                </Button>
                {editingId ? (
                  <Button type="button" variant="ghost" onClick={resetForm} disabled={saving}>
                    Cancel editing
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          {/* Right: Team Availability */}
          <div className="border-border bg-card overflow-hidden rounded-xl border">
            <div className="flex flex-col gap-3 p-5 pb-3">
              <h2 className="text-base font-semibold text-foreground">Team Availability</h2>
              <div className="flex flex-row flex-wrap items-center gap-2">
                <div className="flex shrink-0 flex-wrap items-center gap-2" role="tablist" aria-label="Availability filter">
                  {(
                    [
                      { key: "all", label: `All Members (${tabCounts.all})` },
                      { key: "on_holiday", label: `On Holiday (${tabCounts.on_holiday})` },
                      { key: "available", label: `Available (${tabCounts.available})` },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.key}
                      onClick={() => setTab(t.key)}
                      className={cn(
                        "inline-flex h-8 items-center rounded-lg border px-3 text-[13px] font-medium transition-colors",
                        tab === t.key
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="relative min-w-0 flex-1 sm:max-w-xs sm:ml-auto">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search team member..."
                    aria-label="Search team members by name"
                    className="h-9 pl-9"
                  />
                </div>
              </div>
            </div>
            <div className="overflow-x-auto px-2 pb-2">
              <Table>
                <TableHeader className="[&_tr]:border-b-0">
                  <TableRow>
                    <TableHead className="h-11 px-3 align-middle text-[13px] font-semibold whitespace-nowrap">Team Member</TableHead>
                    <TableHead className="h-11 px-3 align-middle text-[13px] font-semibold whitespace-nowrap">Role</TableHead>
                    <TableHead className="h-11 px-3 align-middle text-[13px] font-semibold whitespace-nowrap">Availability</TableHead>
                    <TableHead className="h-11 px-3 align-middle text-[13px] font-semibold whitespace-nowrap">Holiday Period</TableHead>
                    <TableHead className="h-11 px-3 align-middle text-[13px] font-semibold whitespace-nowrap">Affects Assignment</TableHead>
                    <TableHead className="h-11 w-24 px-2 align-middle" aria-label="Row actions">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleMembers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        {members.length === 0 ? "No eligible team members yet." : "No matching team members."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleMembers.map((m) => {
                      const active = m.holidays.find((w) => w.status === "active") ?? null;
                      const upcoming = m.holidays
                        .filter((w) => w.status === "upcoming")
                        .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
                      const shown = active ?? upcoming[0] ?? null;
                      const extraUpcoming = active ? upcoming.length : Math.max(0, upcoming.length - 1);
                      return (
                        <TableRow key={m.user_id}>
                          <TableCell className="px-3 py-2.5 text-[13px] font-medium whitespace-nowrap">
                            <span className="inline-flex items-center gap-2">
                              <span
                                aria-hidden
                                className={cn(
                                  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                                  avatarToneFor(m.user_id),
                                )}
                              >
                                {initialsFor(m.full_name)}
                              </span>
                              {m.full_name}
                            </span>
                          </TableCell>
                          <TableCell className="px-3 py-2.5 text-[13px] whitespace-nowrap text-muted-foreground">
                            {roleLabel(m.role)}
                          </TableCell>
                          <TableCell className="px-3 py-2.5 text-[13px] whitespace-nowrap">
                            {m.availability === "on_holiday" ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                                <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
                                On Holiday
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                                <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                                Available
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="px-3 py-2.5 text-[13px] whitespace-nowrap tabular-nums">
                            {shown ? (
                              <span>
                                {formatRange(shown.start_date, shown.end_date)}
                                {extraUpcoming > 0 ? (
                                  <span className="text-muted-foreground"> +{extraUpcoming} more</span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="px-3 py-2.5 text-[13px] whitespace-nowrap">
                            {m.availability === "on_holiday" && m.affects_tables.length > 0 ? (
                              <span
                                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400"
                                title={m.affects_tables.join(", ")}
                              >
                                Yes (All Tables)
                                <Info className="h-3.5 w-3.5" aria-hidden />
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="w-24 px-2 text-center align-middle">
                            <span className="inline-flex items-center justify-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`Edit holiday for ${m.full_name}`}
                                title={`Edit holiday for ${m.full_name}`}
                                disabled={rowBusy === m.user_id || m.holidays.filter((w) => w.status === "active" || w.status === "upcoming").length === 0}
                                onClick={() => startEdit(m)}
                                className="h-8 w-8"
                              >
                                <Pencil className="h-4 w-4" aria-hidden />
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  aria-label={`More actions for ${m.full_name}`}
                                  className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 w-8 items-center justify-center rounded-md"
                                >
                                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-52">
                                  <DropdownMenuItem
                                    disabled={rowBusy === m.user_id || (active === null && upcoming.length === 0)}
                                    onClick={() => void cancelHoliday(m)}
                                  >
                                    <CalendarOff className="h-4 w-4" aria-hidden />
                                    {active ? "End holiday early" : "Cancel holiday"}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}

      {/* Assignment Adjustment Preview */}
      {!loading && !error ? (
        <div className="border-violet-200 bg-violet-50/50 dark:border-violet-500/20 dark:bg-violet-500/5 rounded-xl border p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-violet-700 dark:text-violet-400" aria-hidden />
              <div>
                <h2 className="text-base font-semibold text-foreground">Assignment Adjustment Preview</h2>
                <p className="text-sm text-muted-foreground">
                  See how assignments change automatically when a team member is on holiday.
                </p>
              </div>
            </div>
            <Badge variant="secondary" className="gap-1 text-violet-700 dark:text-violet-300">
              <Info className="h-3 w-3" aria-hidden />
              {preview ? "Preview based on current configurations." : "Illustrative example."}
            </Badge>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <PreviewRoundRobin
              tableName={preview?.rrCandidate?.tableName}
              names={(preview?.rrCandidate?.assignees ?? []).map((a) => ({ key: String(a.user_id ?? a.id), name: a.display_name }))}
              onHoliday={onHolidayIds}
              illustrative={preview?.rrCandidate == null}
            />
            <PreviewPercentage
              tableName={preview?.pctCandidate?.tableName}
              assignees={(preview?.pctCandidate?.assignees ?? []).map((a) => ({
                key: a.id,
                name: a.display_name,
                weight: a.weight,
                userId: a.user_id,
              }))}
              onHoliday={onHolidayIds}
              holidayName={preview?.pctCandidate ? preview.holidayName(preview.pctCandidate) : undefined}
              illustrative={preview?.pctCandidate == null}
            />
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5" aria-hidden />
            This preview does not modify your saved assignment configuration.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PreviewRoundRobin({
  tableName,
  names,
  onHoliday,
  illustrative,
}: {
  tableName?: string;
  names: Array<{ key: string; name: string }>;
  onHoliday: ReadonlySet<string>;
  illustrative: boolean;
}) {
  const demo = illustrative || names.length === 0;
  // Illustrative fallback (clearly labeled): Pooja → Rishita → Deepika → Vandana.
  const all = demo
    ? [{ key: "pooja" }, { key: "rishita" }, { key: "deepika" }, { key: "vandana" }]
    : names.map((n) => ({ key: n.key }));
  const displayByKey = new Map(
    (demo
      ? ["Pooja", "Rishita", "Deepika", "Vandana"].map((name, i) => [all[i].key, name] as const)
      : names.map((n) => [n.key, n.name] as const)
    ),
  );
  const label = (key: string) => displayByKey.get(key) ?? key;
  const awayKeys = demo ? new Set(["rishita"]) : new Set(all.map((m) => m.key).filter((k) => onHoliday.has(k)));
  const normal = all.map((m) => m.key);
  const during = excludeOnHoliday(all, awayKeys).map((m) => m.key);
  const awayLabel = demo ? "Rishita" : [...awayKeys].map(label).join(", ");
  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <h3 className="text-sm font-semibold text-foreground">Round Robin Table Example</h3>
      {tableName ? <p className="mt-0.5 text-xs text-muted-foreground">{tableName}</p> : null}
      <p className="mt-1 text-xs text-muted-foreground">Salespeople: {normal.map(label).join(", ")}</p>
      <div className="mt-3 space-y-2 text-[13px]">
        <div className="bg-muted/60 rounded-lg px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">Normal Rotation</p>
          <p className="mt-0.5 font-medium">{normal.map(label).join(" → ")}</p>
        </div>
        <div className="rounded-lg bg-emerald-500/10 px-3 py-2">
          <p className="text-xs font-medium text-emerald-800 dark:text-emerald-300">During Holiday ({awayLabel})</p>
          <p className="mt-0.5 font-medium text-emerald-900 dark:text-emerald-200">{during.map(label).join(" → ")}</p>
        </div>
      </div>
    </div>
  );
}

function PreviewPercentage({
  tableName,
  assignees,
  onHoliday,
  holidayName,
  illustrative,
}: {
  tableName?: string;
  assignees: Array<{ key: string; name: string; weight: number; userId: string | null }>;
  onHoliday: ReadonlySet<string>;
  holidayName?: string;
  illustrative: boolean;
}) {
  const demo = illustrative || assignees.length === 0;
  // Illustrative fallback (clearly labeled): Pooja 16 + six members at 14.
  const normal = demo
    ? [
        { key: "pooja", name: "Pooja", weight: 16 },
        { key: "rishita", name: "Rishita", weight: 14 },
        { key: "ritika", name: "Ritika", weight: 14 },
        { key: "vandana", name: "Vandana", weight: 14 },
        { key: "deepika", name: "Deepika", weight: 14 },
        { key: "devender", name: "Devender", weight: 14 },
        { key: "diksha", name: "Diksha", weight: 14 },
      ]
    : assignees;
  const awayKeys = demo
    ? new Set(["pooja"])
    : new Set(
        normal.filter((a) => {
          const entry = assignees.find((x) => x.key === a.key);
          return entry?.userId != null && onHoliday.has(entry.userId);
        }).map((a) => a.key),
      );
  const available = normal.filter((a) => !awayKeys.has(a.key));
  const adjusted = normalizeAdjustedPercentages(available);
  const awayLabel = demo ? "Pooja" : (holidayName ?? "On holiday");
  const mid = Math.ceil(normal.length / 2);
  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <h3 className="text-sm font-semibold text-foreground">Percentage Table Example</h3>
      {tableName ? <p className="mt-0.5 text-xs text-muted-foreground">{tableName}</p> : null}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
        <div className="rounded-lg bg-muted/60 px-3 py-2 text-[13px]">
          <p className="text-xs font-medium text-muted-foreground">Normal Allocation (100%)</p>
          <div className="mt-1 grid grid-cols-2 gap-x-4">
            {[normal.slice(0, mid), normal.slice(mid)].map((col, i) => (
              <div key={i} className="space-y-0.5">
                {col.map((a) => (
                  <p key={a.key} className="flex items-center justify-between gap-2 tabular-nums">
                    <span className="truncate">{a.name}</span>
                    <span className="font-medium">{a.weight}%</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="hidden items-center justify-center text-muted-foreground sm:flex" aria-hidden>
          →
        </div>
        <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[13px]">
          <p className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
            During Holiday ({awayLabel}) — Adjusted (100%)
          </p>
          <div className="mt-1 grid grid-cols-2 gap-x-4">
            {[adjusted.slice(0, Math.ceil(adjusted.length / 2)), adjusted.slice(Math.ceil(adjusted.length / 2))].map(
              (col, i) => (
                <div key={i} className="space-y-0.5">
                  {col.map((a) => (
                    <p key={a.key} className="flex items-center justify-between gap-2 tabular-nums">
                      <span className="truncate">{a.name}</span>
                      <span className="font-medium">{a.percent}%</span>
                    </p>
                  ))}
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
