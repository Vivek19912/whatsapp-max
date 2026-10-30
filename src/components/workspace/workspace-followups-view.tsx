"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { DialAction } from "@/components/workspace/dial-action";
import { ScheduleFollowupDialog } from "@/components/workspace/schedule-followup-dialog";
import { WorkspacePagination } from "@/components/workspace/workspace-pagination";
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  type WorkspacePageSize,
} from "@/lib/flows/workspace-pagination";
import {
  assignHeaderBackgrounds,
  headerTextColor,
} from "@/lib/flows/header-colors";
import { localDayBounds, type FollowupBucket } from "@/lib/followups/followup-view";

export type FollowupsBucket = "all" | "overdue" | "today" | "tomorrow" | "upcoming" | "completed";

interface FollowupLead {
  runId: string;
  name: string | null;
  phone: string | null;
  contactId: string | null;
  conversationId: string | null;
}

interface FollowupItem {
  id: string;
  status: string;
  scheduled_for: string;
  message_text: string;
  template_name: string | null;
  followup_completed_at: string | null;
  followup_completed_by: string | null;
  sent_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
  bucket: FollowupBucket;
  lead: FollowupLead;
  assignee: { userId: string; display: string } | null;
}

interface FollowupsCounts {
  all: number;
  pending: number;
  overdue: number;
  today: number;
  tomorrow: number;
  upcoming: number;
  completed: number;
}

const BUCKET_TABS: Array<{ id: FollowupsBucket; label: string }> = [
  { id: "all", label: "All" },
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Due Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "upcoming", label: "Upcoming" },
  { id: "completed", label: "Completed" },
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Follow-ups column headers paint from the SAME Workspace header
 * system as the Leads table: positional pastel backgrounds from
 * assignHeaderBackgrounds (Name → Cool Gray, Follow-up Status →
 * teal, the rest from the shared palette with the same adjacency
 * guarantee), auto text contrast, flat fills in both themes.
 * The Actions column reuses the existing Dial action-column
 * treatment instead of the palette.
 */
const FOLLOWUP_COLUMNS = [
  { visId: "followups:lead", label: "Name" },
  { visId: "followups:phone", label: "Phone Number" },
  { visId: "followups:assignee", label: "Assigned To" },
  { visId: "followups:datetime", label: "Follow-up Date & Time" },
  { visId: "followups:reminder", label: "Reminder" },
  { visId: "followups:status", label: "Follow-up Status" },
  { visId: "followups:message", label: "Message" },
] as const;

function followupHeadStyleAt(backgrounds: readonly string[], index: number) {
  const background = backgrounds[index] ?? "#93c47d";
  return {
    backgroundColor: background,
    color: headerTextColor(background),
  };
}

function bucketTone(bucket: FollowupsBucket): string {
  switch (bucket) {
    case "overdue":
      return "text-red-600 dark:text-red-400";
    case "today":
      return "text-amber-600 dark:text-amber-400";
    case "tomorrow":
      return "text-violet-600 dark:text-violet-400";
    case "upcoming":
      return "text-blue-600 dark:text-blue-400";
    case "completed":
      return "text-green-600 dark:text-green-400";
    default:
      return "";
  }
}

/** Compact delivery state as a subtle text badge — never confused with completion. */
function reminderLabel(status: string): { text: string; className: string } {
  const base = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium";
  switch (status) {
    case "sent":
      return { text: "Reminder sent", className: `${base} bg-muted text-muted-foreground` };
    case "failed":
      return { text: "Reminder failed", className: `${base} bg-red-500/10 text-red-700 dark:text-red-400` };
    case "cancelled":
      return { text: "Reminder cancelled", className: `${base} bg-muted text-muted-foreground` };
    case "processing":
      return { text: "Reminder sending", className: `${base} bg-amber-500/10 text-amber-700 dark:text-amber-400` };
    default:
      return { text: "Reminder scheduled", className: `${base} bg-muted text-muted-foreground` };
  }
}

/** Follow-up completion state as a subtle text badge. */
function followupStatusBadge(bucket: FollowupsBucket): string {
  const base = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium";
  switch (bucket) {
    case "overdue":
      return `${base} bg-red-500/10 text-red-700 dark:text-red-400`;
    case "today":
      return `${base} bg-amber-500/10 text-amber-700 dark:text-amber-400`;
    case "upcoming":
    case "tomorrow":
      return `${base} bg-blue-500/10 text-blue-700 dark:text-blue-400`;
    case "completed":
      return `${base} bg-green-500/10 text-green-700 dark:text-green-400`;
    default:
      return `${base} bg-muted text-muted-foreground`;
  }
}

/**
 * The follow-ups grid itself — same enterprise table as Leads:
 * sticky pastel headers, full cell borders, unified scrolling
 * viewport. Extracted so the rendered grid is unit-testable with
 * fixed rows (the view loads its rows client-side).
 */
export function FollowupsTable({
  items,
  headerBackgrounds,
  flowId,
  followupFieldId,
  confirmId,
  actingId,
  onAskConfirm,
  onCancelConfirm,
  onAct,
  onReschedule,
}: {
  items: FollowupItem[];
  headerBackgrounds: readonly string[];
  flowId: string;
  followupFieldId: string | null;
  confirmId: string | null;
  actingId: string | null;
  onAskConfirm: (id: string) => void;
  onCancelConfirm: () => void;
  onAct: (id: string, action: "complete" | "reopen") => void;
  onReschedule: (item: FollowupItem) => void;
}) {
  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="workspace-table-viewport max-h-[70vh] overflow-auto">
        <Table>
          {/* Same enterprise grid as the Leads table: sticky
              opaque headers, pastel positional backgrounds, the
              tr-level divider neutralized in favour of th-level
              dividers, one unified horizontally scrolling grid. */}
          <TableHeader className="[&_tr]:border-b-0">
            <TableRow>
              {(
                [
                  "Lead Name",
                  "Phone Number",
                  "Assigned To",
                  "Follow-up Date & Time",
                  "Reminder",
                  "Follow-up Status",
                  "Message",
                ] as const
              ).map((label, i) => (
                <TableHead
                  key={label}
                  className="sticky top-0 z-20 h-11 truncate border-r border-b border-border px-3 align-middle text-[13px] font-semibold whitespace-nowrap last:border-r-0"
                  style={followupHeadStyleAt(headerBackgrounds, i)}
                >
                  {label}
                </TableHead>
              ))}
              <TableHead
                scope="col"
                className="sticky top-0 z-20 h-11 border-r border-b border-border bg-[#F1F5F9] px-3 align-middle text-center text-[13px] font-semibold whitespace-nowrap [html[data-mode=dark]_&]:bg-muted last:border-r-0"
              >
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const reminder = reminderLabel(item.status);
              return (
                <TableRow key={item.id}>
                  <TableCell className="max-w-48 truncate border-r border-border last:border-r-0" title={item.lead.name ?? undefined}>
                    <div className="truncate text-sm font-medium text-foreground">
                      {item.lead.name ?? "—"}
                    </div>
                  </TableCell>
                  <TableCell className="border-r border-border whitespace-nowrap text-sm tabular-nums last:border-r-0">
                    {item.lead.phone ?? "—"}
                  </TableCell>
                  <TableCell className="border-r border-border text-sm last:border-r-0">
                    {item.assignee?.display ?? "Unassigned"}
                  </TableCell>
                  <TableCell className={cn("border-r border-border whitespace-nowrap text-sm tabular-nums last:border-r-0", bucketTone(item.bucket as FollowupBucket))}>
                    {formatDate(item.scheduled_for)}, {formatTime(item.scheduled_for)}
                  </TableCell>
                  <TableCell className="border-r border-border whitespace-nowrap last:border-r-0">
                    <span className={reminder.className}>
                      {reminder.text}
                    </span>
                  </TableCell>
                  <TableCell className="border-r border-border last:border-r-0">
                    <span className={followupStatusBadge(item.bucket as FollowupBucket)}>
                      {item.bucket === "completed" ? "Completed" : "Pending"}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-64 border-r border-border last:border-r-0">
                    <span className="line-clamp-2 block whitespace-pre-wrap text-xs text-muted-foreground">
                      {item.message_text}
                    </span>
                  </TableCell>
                  <TableCell className="border-r border-border last:border-r-0">
                    <div className="flex items-center justify-end gap-1">
                      {item.lead.phone ? (
                        <DialAction
                          phone={item.lead.phone}
                          contactId={item.lead.contactId}
                          flowId={flowId}
                          runId={item.lead.runId}
                        />
                      ) : null}
                      {item.lead.conversationId ? (
                        <a
                          href={`/inbox?c=${item.lead.conversationId}`}
                          title="Open Inbox conversation"
                          aria-label="Open Inbox conversation"
                          className="inline-flex h-8 items-center justify-center rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          Inbox
                        </a>
                      ) : null}
                      {followupFieldId && item.bucket !== "completed" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Reschedule"
                          onClick={() => onReschedule(item)}
                        >
                          Reschedule
                        </Button>
                      ) : null}
                      {item.bucket !== "completed" ? (
                        confirmId === item.id ? (
                          <>
                            <Button
                              variant="default"
                              size="sm"
                              disabled={actingId === item.id}
                              onClick={() => onAct(item.id, "complete")}
                              className="bg-green-600 text-white hover:bg-green-600/90 dark:bg-green-600 dark:hover:bg-green-600/90"
                            >
                              {actingId === item.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : null}
                              Confirm
                            </Button>
                            <Button variant="ghost" size="sm" onClick={onCancelConfirm}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onAskConfirm(item.id)}
                            className="border-green-600/40 text-green-700 hover:bg-green-600/10 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                          >
                            Complete
                          </Button>
                        )
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Reopen"
                          disabled={actingId === item.id}
                          onClick={() => onAct(item.id, "reopen")}
                        >
                          Reopen
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function WorkspaceFollowupsView({
  flowId,
  followupFieldId,
  onTableRefresh,
}: {
  flowId: string;
  /** Follow-up datetime field id for reschedule/cell sync (null = reschedule unavailable). */
  followupFieldId: string | null;
  /** Refresh the underlying Workspace table (cell sync). */
  onTableRefresh: () => void;
}) {
  const [bucket, setBucket] = useState<FollowupsBucket>("all");
  const [assignee, setAssignee] = useState("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<WorkspacePageSize>(DEFAULT_WORKSPACE_PAGE_SIZE);
  const [items, setItems] = useState<FollowupItem[]>([]);
  const [counts, setCounts] = useState<FollowupsCounts>({
    all: 0, pending: 0, overdue: 0, today: 0, tomorrow: 0, upcoming: 0, completed: 0,
  });
  const [assignees, setAssignees] = useState<Array<{ userId: string; display: string }>>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [reschedule, setReschedule] = useState<FollowupItem | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 400);
    return () => clearTimeout(t);
  }, [query]);

  // New table selection resets the view.
  useEffect(() => {
    setBucket("all");
    setAssignee("all");
    setQuery("");
    setFrom("");
    setTo("");
    setPage(0);
  }, [flowId]);

  const dayWindow = useMemo(() => {
    const now = new Date();
    const b = localDayBounds(now);
    // Civil tomorrow in the viewer's zone (exact across DST).
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    const tb = localDayBounds(t);
    return (
      `todayStart=${encodeURIComponent(b.start)}&todayEnd=${encodeURIComponent(b.end)}` +
      `&tomorrowStart=${encodeURIComponent(tb.start)}&tomorrowEnd=${encodeURIComponent(tb.end)}`
    );
  }, []);

  // Same positional header system as the Leads table (see
  // FOLLOWUP_COLUMNS): one pastel background per rendered header,
  // index-aligned, with the shared adjacency guarantee.
  const headerBackgrounds = useMemo(
    () => assignHeaderBackgrounds([...FOLLOWUP_COLUMNS], null),
    [],
  );

  const queryString = useMemo(() => {
    const qs = new URLSearchParams({
      bucket,
      assignee,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (debouncedQuery.trim()) qs.set("q", debouncedQuery.trim());
    if (from) qs.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) qs.set("to", new Date(`${to}T23:59:59`).toISOString());
    return `${qs.toString()}&${dayWindow}`;
  }, [bucket, assignee, debouncedQuery, from, to, page, pageSize, dayWindow]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/followups?${queryString}`, {
        cache: "no-store",
      });
      const payload = (await res.json().catch(() => ({}))) as {
        items?: FollowupItem[];
        counts?: FollowupsCounts;
        total?: number;
        assignees?: Array<{ userId: string; display: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
      setItems(payload.items ?? []);
      setCounts(
        payload.counts ?? { all: 0, pending: 0, overdue: 0, today: 0, tomorrow: 0, upcoming: 0, completed: 0 },
      );
      setTotal(payload.total ?? 0);
      setAssignees(payload.assignees ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load follow-ups");
    } finally {
      setLoading(false);
    }
  }, [flowId, queryString]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: "complete" | "reopen") {
    setActingId(id);
    try {
      const res = await fetch(`/api/followups/${id}/${action}`, { method: "POST" });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
      toast.success(action === "complete" ? "Follow-up completed" : "Follow-up reopened");
      setConfirmId(null);
      await load();
      onTableRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActingId(null);
    }
  }

  const cards: Array<{
    id: FollowupsBucket;
    label: string;
    count: number;
    tone: string;
  }> = [
    { id: "overdue", label: "Overdue", count: counts.overdue, tone: "text-red-600 dark:text-red-400" },
    { id: "today", label: "Due Today", count: counts.today, tone: "text-amber-600 dark:text-amber-400" },
    { id: "tomorrow", label: "Tomorrow", count: counts.tomorrow, tone: "text-violet-600 dark:text-violet-400" },
    { id: "upcoming", label: "Upcoming", count: counts.upcoming, tone: "text-blue-600 dark:text-blue-400" },
    { id: "completed", label: "Completed", count: counts.completed, tone: "text-green-600 dark:text-green-400" },
  ];

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              setBucket(c.id);
              setPage(0);
            }}
            aria-pressed={bucket === c.id}
            className={cn(
              "rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/50",
              bucket === c.id ? "border-primary" : "border-border",
            )}
          >
            <div className={cn("text-xs font-medium", c.tone)}>
              {c.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {c.count}
            </div>
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1.5" role="tablist" aria-label="Follow-up filter">
        {BUCKET_TABS.map((t) => (
          <Button
            key={t.id}
            role="tab"
            aria-selected={bucket === t.id}
            variant={bucket === t.id ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setBucket(t.id);
              setPage(0);
            }}
            className={cn(
              "h-8 rounded-full px-3.5 text-sm font-medium",
              bucket !== t.id &&
                "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Search lead name or phone"
          aria-label="Search follow-ups"
          className="sm:max-w-xs"
        />
        <Select
          value={assignee}
          onValueChange={(v) => {
            if (v == null) return;
            setAssignee(v);
            setPage(0);
          }}
        >
          <SelectTrigger aria-label="Filter by salesperson" className="sm:w-52">
            <SelectValue placeholder="All salespeople" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All salespeople</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {assignees.map((a) => (
              <SelectItem key={a.userId} value={a.userId}>
                {a.display}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(0);
            }}
            aria-label="From date"
            className="w-auto"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(0);
            }}
            aria-label="To date"
            className="w-auto"
          />
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-12" role="status">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : error ? (
        <p className="rounded-xl border border-border bg-card px-4 py-8 text-center text-sm text-destructive" role="alert">
          {error}{" "}
          <Button variant="link" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-12 text-center">
          <p className="mt-2 text-sm font-medium text-foreground">No follow-ups here</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {bucket === "overdue"
              ? "Nothing overdue — nice work."
              : bucket === "completed"
                ? "Completed follow-ups will appear here."
                : "Schedule one from a lead's Next Follow-up Date & Time cell."}
          </p>
        </div>
      ) : (
        <FollowupsTable
          items={items}
          headerBackgrounds={headerBackgrounds}
          flowId={flowId}
          followupFieldId={followupFieldId}
          confirmId={confirmId}
          actingId={actingId}
          onAskConfirm={setConfirmId}
          onCancelConfirm={() => setConfirmId(null)}
          onAct={(id, action) => void act(id, action)}
          onReschedule={setReschedule}
        />
      )}

      <WorkspacePagination
        page={page}
        totalPages={Math.max(1, Math.ceil(total / pageSize))}
        total={total}
        pageSize={pageSize}
        rowsOnPage={items.length}
        disabled={loading}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size);
          setPage(0);
        }}
      />

      {reschedule && followupFieldId ? (
        <ScheduleFollowupDialog
          open
          onOpenChange={(open) => {
            if (!open) setReschedule(null);
          }}
          flowId={flowId}
          runId={reschedule.lead.runId}
          leadName={reschedule.lead.name}
          leadPhone={reschedule.lead.phone}
          initialValue={reschedule.scheduled_for}
          fieldId={followupFieldId}
          onSaved={() => {
            setReschedule(null);
            void load();
            onTableRefresh();
          }}
        />
      ) : null}
    </div>
  );
}
