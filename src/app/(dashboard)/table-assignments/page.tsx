"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Crown,
  Hand,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Play,
  Pause,
  Eye,
  ExternalLink,
  RefreshCw,
  Search,
  Plus,
  UserCheck,
  UserX,
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
import { WorkspacePagination } from "@/components/workspace/workspace-pagination";
import { TableAssignmentDialog } from "@/components/workspace/table-assignment-dialog";
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  isWorkspacePageSize,
  workspaceRowNumber,
  type WorkspacePageSize,
} from "@/lib/flows/workspace-pagination";
import { saveSelectedFlowId } from "@/lib/flows/workspace-selected-flow";
import {
  allocationText,
  avatarToneFor,
  computeKpis,
  deriveMethodLabel,
  deriveTableStatus,
  filterOverviewTables,
  initialsFor,
  type AssignmentMethodFilter,
  type AssignmentStatusFilter,
  type OverviewTableInput,
} from "@/lib/lead-assignment/table-overview";
import { cn } from "@/lib/utils";

interface TableAssignmentRow {
  flowId: string;
  tableName: string;
  formName: string | null;
  config: {
    id: string;
    enabled: boolean;
    mode: "round_robin" | "percentage";
    whatsapp_template_name: string | null;
    whatsapp_template_language: string;
    updated_at: string | null;
  } | null;
  assignees: Array<{
    id: string;
    user_id: string | null;
    display_name: string;
    weight: number;
    is_active: boolean;
  }>;
}

function toOverviewInput(row: TableAssignmentRow): OverviewTableInput {
  return {
    flowId: row.flowId,
    tableName: row.tableName,
    formName: row.formName,
    config: row.config
      ? {
          enabled: row.config.enabled,
          mode: row.config.mode,
          whatsapp_template_name: row.config.whatsapp_template_name,
          updated_at: row.config.updated_at,
        }
      : null,
    assignees: row.assignees.map((a) => ({
      id: a.id,
      user_id: a.user_id,
      display_name: a.display_name,
      weight: a.weight,
      is_active: a.is_active,
    })),
  };
}

/** "Nov 23, 05:17 PM" in Asia/Kolkata (same convention as the Assignment dialog). */
function formatUpdatedOn(iso: string | null): string {
  if (!iso) return "Not available";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")}`.replace("  ", " ");
  } catch {
    return iso;
  }
}

function MethodBadge({ method }: { method: string }) {
  if (method === "Percentage") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-700 dark:text-violet-400">
        <Users className="h-3.5 w-3.5" aria-hidden />
        Percentage
      </span>
    );
  }
  if (method === "Round Robin") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-400">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        Round Robin
      </span>
    );
  }
  if (method === "Manual") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
        <Hand className="h-3.5 w-3.5" aria-hidden />
        Manual
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function StatusBadge({ status }: { status: "active" | "paused" | "not_configured" }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
        Active
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
        Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-700 dark:text-rose-400">
      <span className="size-1.5 rounded-full bg-rose-500" aria-hidden />
      Not Configured
    </span>
  );
}

const MAX_VISIBLE_ASSIGNEES = 3;

export default function TableAssignmentsPage() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const router = useRouter();
  const isOwner = !profileLoading && accountRole === "owner";
  const isDenied = !profileLoading && accountRole !== "owner";

  const [rows, setRows] = useState<TableAssignmentRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [methodFilter, setMethodFilter] = useState<AssignmentMethodFilter>("all");
  const [statusFilter, setStatusFilter] = useState<AssignmentStatusFilter>("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<WorkspacePageSize>(DEFAULT_WORKSPACE_PAGE_SIZE);
  const [editFlow, setEditFlow] = useState<{ flowId: string; tableName: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewMode, setViewMode] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace/table-assignments", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as {
        tables?: TableAssignmentRow[];
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not load table assignments.");
      setRows(Array.isArray(body?.tables) ? body.tables : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load table assignments.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [isOwner]);

  useEffect(() => {
    if (!isOwner) return;
    const ctrl = new AbortController();
    void reload();
    return () => ctrl.abort();
  }, [isOwner, reload]);

  const overviewRows = useMemo(
    () => (rows ?? []).map((r) => ({ row: r, input: toOverviewInput(r) })),
    [rows],
  );

  const kpis = useMemo(
    () => computeKpis(overviewRows.map((r) => r.input)),
    [overviewRows],
  );

  const filtered = useMemo(
    () =>
      filterOverviewTables(
        overviewRows.map((r) => r.row),
        {
          search,
          method: methodFilter,
          status: statusFilter,
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overviewRows, search, methodFilter, statusFilter],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const pageRows = useMemo(
    () => filtered.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [filtered, safePage, pageSize],
  );

  const openWorkspaceTable = useCallback(
    (flowId: string) => {
      // Reuse the existing Workspace selection mechanism so the
      // table (including hidden ones) opens directly. The Workspace
      // page honors ?table= for any of the account's own flows.
      saveSelectedFlowId(accountId, flowId);
      router.push(`/workspace?table=${encodeURIComponent(flowId)}`);
    },
    [accountId, router],
  );

  const openEdit = useCallback((row: TableAssignmentRow, viewOnly: boolean) => {
    setEditFlow({ flowId: row.flowId, tableName: row.tableName });
    setViewMode(viewOnly);
    setDialogOpen(true);
  }, []);

  const togglePause = useCallback(
    async (row: TableAssignmentRow) => {
      const enabled = row.config?.enabled === true;
      setRowBusy(row.flowId);
      try {
        const res = await fetch(`/api/flows/${row.flowId}/assignment/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: enabled ? "pause" : "resume" }),
        });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(body?.error ?? "Could not update table status.");
        toast.success(enabled ? "Table paused." : "Table resumed.");
        await reload();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not update table status.");
      } finally {
        setRowBusy(null);
      }
    },
    [reload],
  );

  if (profileLoading) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Table Assignments</h1>
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
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Table Assignments</h1>
        <EmptyState title="Owner only" hint="Only the account owner can view table assignments." />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Table Assignments</h1>
          <Badge variant="secondary" className="gap-1 text-blue-700">
            <Crown className="h-3 w-3" aria-hidden />
            Owner only
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          View and manage lead assignment settings for all Meta Lead Ads tables.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Total Tables" value={loading ? 0 : kpis.total} icon={LayoutGrid} loading={loading} />
        <KpiCard title="Assigned Tables" value={loading ? 0 : kpis.assigned} icon={UserCheck} loading={loading} />
        <KpiCard title="Unassigned Tables" value={loading ? 0 : kpis.unassigned} icon={UserX} loading={loading} />
        <KpiCard title="Total Assignees" value={loading ? 0 : kpis.distinctAssignees} icon={Users} loading={loading} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-row flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search table by name..."
              aria-label="Search tables by name"
              className="h-9 pl-9"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:ml-auto">
            <Select
              value={methodFilter}
              onValueChange={(v) => {
                setMethodFilter(v as AssignmentMethodFilter);
                setPage(0);
              }}
            >
              <SelectTrigger className="h-9 w-[200px] text-sm" aria-label="Filter by assignment method">
                <SelectValue placeholder="All Assignment Methods" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Assignment Methods</SelectItem>
                <SelectItem value="percentage">Percentage</SelectItem>
                <SelectItem value="round_robin">Round Robin</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v as AssignmentStatusFilter);
                setPage(0);
              }}
            >
              <SelectTrigger className="h-9 w-[160px] text-sm" aria-label="Filter by status">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="not_configured">Not Configured</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              title="Show tables needing assignment"
              onClick={() => {
                setStatusFilter("not_configured");
                setSearch("");
                setPage(0);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Assign Table
            </Button>
          </div>
        </div>
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
      ) : filtered.length === 0 ? (
        <EmptyState
          title={rows && rows.length > 0 ? "No matching tables" : "No Meta Lead Ads tables yet"}
          hint={
            rows && rows.length > 0
              ? "Try widening the search or clearing the filters."
              : "Connect Meta Lead Ads and enable an Instant Form to see tables here."
          }
        />
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-xl border">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="[&_tr]:border-b-0">
                <TableRow>
                  <TableHead className="h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold tabular-nums">
                    No.
                  </TableHead>
                  <TableHead className="h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                    Meta Lead Ads Table
                  </TableHead>
                  <TableHead className="h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                    Assignment Method
                  </TableHead>
                  <TableHead className="h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                    Assigned To
                  </TableHead>
                  <TableHead className="h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                    Allocation
                  </TableHead>
                  <TableHead className="h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                    Status
                  </TableHead>
                  <TableHead className="h-11 border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap">
                    Updated On
                  </TableHead>
                  <TableHead className="h-11 w-12 border-r border-b border-border px-2 align-middle" aria-label="Row actions">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row, index) => {
                  const input = toOverviewInput(row);
                  const status = deriveTableStatus(input);
                  const method = deriveMethodLabel(input);
                  const allocation = allocationText(input);
                  const visible = row.assignees.slice(0, MAX_VISIBLE_ASSIGNEES);
                  const overflow = row.assignees.length - visible.length;
                  const fullNames = row.assignees.map((a) => a.display_name).join(", ");
                  return (
                    <TableRow key={row.flowId} className="cursor-default">
                      <TableCell className="border-r border-border px-4 text-sm tabular-nums text-muted-foreground">
                        {(safePage * pageSize + index + 1).toLocaleString()}
                      </TableCell>
                      <TableCell className="max-w-56 truncate border-r border-border px-2.5 py-1.5 text-[13px] font-medium">
                        <button
                          type="button"
                          onClick={() => openWorkspaceTable(row.flowId)}
                          title={`Open ${row.tableName} in Workspace`}
                          className="truncate text-left text-primary hover:underline hover:underline-offset-2"
                        >
                          {row.tableName}
                        </button>
                      </TableCell>
                      <TableCell className="border-r border-border px-2.5 py-1.5 text-[13px]">
                        <MethodBadge method={method} />
                      </TableCell>
                      <TableCell className="max-w-64 border-r border-border px-2.5 py-1.5 text-[13px]">
                        {row.assignees.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="flex items-center gap-1.5" title={fullNames}>
                            {visible.map((a) => (
                              <span
                                key={a.id}
                                aria-hidden
                                className={cn(
                                  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                                  avatarToneFor(a.id),
                                )}
                              >
                                {initialsFor(a.display_name)}
                              </span>
                            ))}
                            {overflow > 0 && (
                              <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-muted px-1 text-[11px] font-semibold text-muted-foreground">
                                +{overflow}
                              </span>
                            )}
                            <span className="sr-only">{fullNames}</span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell
                        className="max-w-72 truncate border-r border-border px-2.5 py-1.5 text-[13px]"
                        title={allocation === "—" ? undefined : allocation}
                      >
                        {allocation}
                      </TableCell>
                      <TableCell className="border-r border-border px-2.5 py-1.5 text-[13px]">
                        <StatusBadge status={status} />
                      </TableCell>
                      <TableCell className="border-r border-border px-2.5 py-1.5 text-[13px] whitespace-nowrap tabular-nums">
                        {row.config?.updated_at ? formatUpdatedOn(row.config.updated_at) : "Not available"}
                      </TableCell>
                      <TableCell className="w-24 border-r border-border px-2 text-center align-middle last:border-r-0">
                        <span className="inline-flex items-center justify-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit assignment for ${row.tableName}`}
                            title={`Edit assignment for ${row.tableName}`}
                            onClick={() => {
                              setEditFlow({ flowId: row.flowId, tableName: row.tableName });
                              setViewMode(false);
                              setDialogOpen(true);
                            }}
                            className="h-8 w-8"
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              aria-label={`More actions for ${row.tableName}`}
                              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 w-8 items-center justify-center rounded-md"
                            >
                              <MoreHorizontal className="h-4 w-4" aria-hidden />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditFlow({ flowId: row.flowId, tableName: row.tableName });
                                  setViewMode(true);
                                  setDialogOpen(true);
                                }}
                              >
                                <Eye className="h-4 w-4" aria-hidden />
                                View configuration
                              </DropdownMenuItem>
                              {row.config && (
                                <DropdownMenuItem
                                  disabled={rowBusy === row.flowId}
                                  onClick={() => void togglePause(row)}
                                >
                                  {row.config.enabled ? (
                                    <Pause className="h-4 w-4" aria-hidden />
                                  ) : (
                                    <Play className="h-4 w-4" aria-hidden />
                                  )}
                                  {row.config.enabled ? "Pause assignment" : "Resume assignment"}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => openWorkspaceTable(row.flowId)}>
                                <ExternalLink className="h-4 w-4" aria-hidden />
                                Open in Workspace
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="border-t border-border bg-card">
            <WorkspacePagination
              page={safePage}
              totalPages={totalPages}
              total={filtered.length}
              pageSize={pageSize}
              rowsOnPage={pageRows.length}
              disabled={false}
              onPage={setPage}
              onPageSize={(size) => {
                setPageSize(size);
                setPage(0);
              }}
            />
          </div>
        </div>
      )}

      {editFlow && (
        <TableAssignmentDialog
          key={`assign-${editFlow.flowId}`}
          flowId={editFlow.flowId}
          flowName={editFlow.tableName}
          tableKind="meta_lead_ads"
          open={dialogOpen}
          onOpenChange={(v) => {
            setDialogOpen(v);
            if (!v) {
              setEditFlow(null);
              void reload();
            }
          }}
          viewMode={viewMode}
        />
      )}
    </div>
  );
}
